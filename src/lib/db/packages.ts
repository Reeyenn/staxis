// ═══════════════════════════════════════════════════════════════════════════
// Packages — client data helpers.
//
// Like lost-and-found.ts (and UNLIKE most db/* modules) this does NOT use the
// anon supabase client: `packages` is deny-all-browser, so the anon client
// would silently return [] (CLAUDE.md "RLS bug class"). Every read/write goes
// through the authenticated /api/front-desk/packages routes via fetchWithAuth.
// Realtime isn't available on a deny-all table, so we poll (low-frequency desk
// data) + refetch after the user's own actions.
//
// Client-safe: imports only fetchWithAuth + (type-only) the pure types module.
// Never re-exported through the src/lib/db.ts barrel — that barrel is imported
// by client code, and pulling a supabaseAdmin-touching module through it is the
// exact leak that caused the 2026-05-31 outage. PackagesTab imports this file
// directly.
// ═══════════════════════════════════════════════════════════════════════════

import { fetchWithAuth } from '@/lib/api-fetch';
import type {
  PackageRow,
  PackageCounts,
  PackageStatus,
  ScannedLabel,
} from '@/lib/packages/types';

export type { PackageRow, PackageCounts, ScannedLabel } from '@/lib/packages/types';

const BASE = '/api/front-desk/packages';

interface ListPayload {
  items: PackageRow[];
  counts: PackageCounts;
}

async function readEnvelope<T>(res: Response): Promise<T | null> {
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T } | null;
  if (!body || body.ok !== true || body.data === undefined) return null;
  return body.data;
}

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function sendAction<T = unknown>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  payload?: object,
): Promise<ActionResult<T>> {
  try {
    const res = await fetchWithAuth(path, {
      method,
      ...(payload
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
        : {}),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: T; error?: string }
      | null;
    if (!res.ok || !body || body.ok !== true) {
      return { ok: false, error: body?.error ?? `request_failed_${res.status}` };
    }
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ─── reads ──────────────────────────────────────────────────────────────────

export async function fetchPackages(
  pid: string,
  status?: PackageStatus,
): Promise<ListPayload> {
  const qs = new URLSearchParams({ pid });
  if (status) qs.set('status', status);
  const res = await fetchWithAuth(`${BASE}?${qs.toString()}`, { cache: 'no-store' });
  const data = await readEnvelope<ListPayload>(res);
  if (data === null) {
    // An HTTP error envelope (e.g. a transient 500) must NOT masquerade as an
    // empty register — returning `EMPTY` here let a brief server blip wipe the
    // list to "No packages held" mid-shift. Throw instead so subscribers keep
    // their last-good data (their catch below) and the next poll self-heals.
    throw new Error(`packages_list_failed_${res.status}`);
  }
  return data;
}

/**
 * Initial fetch + foreground poll + visibility refetch. Returns an unsubscribe
 * fn. Cross-terminal liveness is poll-bounded (30s); the acting user sees
 * instant updates by refetching after their own action.
 */
export function subscribePackages(
  pid: string,
  onData: (payload: ListPayload) => void,
  pollMs = 30_000,
  onError?: () => void,
): () => void {
  let active = true;
  const refresh = async () => {
    try {
      const payload = await fetchPackages(pid);
      if (active) onData(payload);
    } catch {
      // Keep last good — transient network/server blip. onError lets the UI
      // show a load-error state when there is no last-good data yet.
      if (active) onError?.();
    }
  };
  void refresh();
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh();
  }, pollMs);
  const onVis = () => {
    if (document.visibilityState === 'visible') void refresh();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  return () => {
    active = false;
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  };
}

// ─── writes / actions ─────────────────────────────────────────────────────

export interface CreatePackageInput {
  pid: string;
  guestName: string;
  roomNumber?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  notes?: string | null;
  photoPath?: string | null;
}

export function createPackage(input: CreatePackageInput): Promise<ActionResult<{ id: string }>> {
  return sendAction<{ id: string }>(BASE, 'POST', input);
}

export function markPackagePickedUp(
  pid: string,
  id: string,
): Promise<ActionResult<{ pickedUp: boolean }>> {
  return sendAction(`${BASE}/${encodeURIComponent(id)}`, 'PATCH', { pid });
}

export function deletePackage(
  pid: string,
  id: string,
): Promise<ActionResult<{ deleted: boolean }>> {
  return sendAction(
    `${BASE}/${encodeURIComponent(id)}?pid=${encodeURIComponent(pid)}`,
    'DELETE',
  );
}

export function scanPackageLabel(
  pid: string,
  imageBase64: string,
  mediaType: string,
): Promise<ActionResult<ScannedLabel>> {
  return sendAction<ScannedLabel>(`${BASE}/scan-label`, 'POST', { pid, imageBase64, mediaType });
}

export interface PresignResult {
  path: string;
  signedUrl: string;
  token: string;
}

export function presignPackagePhoto(
  pid: string,
  scopeKey: string,
  filename: string,
): Promise<ActionResult<PresignResult>> {
  return sendAction<PresignResult>(`${BASE}/photo-presign`, 'POST', { pid, scopeKey, filename });
}
