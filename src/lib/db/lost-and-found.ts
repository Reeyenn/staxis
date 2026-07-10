// ═══════════════════════════════════════════════════════════════════════════
// Lost & Found — client data helpers.
//
// UNLIKE most db/* modules, this one does NOT use the anon supabase client:
// both lost_and_found_items and pms_lost_and_found are deny-all-browser, so the
// anon client would silently return [] (CLAUDE.md "RLS bug class"). Every read
// and write goes through the authenticated /api/front-desk/lost-and-found
// routes via fetchWithAuth. Realtime isn't available on a deny-all table, so we
// poll (low-frequency L&F data) + refetch after the user's own actions.
// ═══════════════════════════════════════════════════════════════════════════

import { fetchWithAuth } from '@/lib/api-fetch';
import type { LostFoundItem, LostFoundCounts } from '@/lib/lost-and-found/types';

export type { LostFoundItem, LostFoundCounts } from '@/lib/lost-and-found/types';

const BASE = '/api/front-desk/lost-and-found';

interface RegisterPayload {
  items: LostFoundItem[];
  counts: LostFoundCounts;
}

async function readEnvelope<T>(res: Response): Promise<T | null> {
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T } | null;
  if (!body || body.ok !== true || body.data === undefined) return null;
  return body.data;
}

// ─── Reads ────────────────────────────────────────────────────────────────

export async function fetchLostFoundRegister(pid: string): Promise<RegisterPayload> {
  const res = await fetchWithAuth(`${BASE}?pid=${encodeURIComponent(pid)}`, { cache: 'no-store' });
  const data = await readEnvelope<RegisterPayload>(res);
  if (data === null) {
    // An HTTP error envelope (e.g. a transient 500) must NOT masquerade as an
    // empty register — returning the empty payload here let a brief server
    // blip wipe the list to "Nothing here yet" mid-shift. Throw instead so
    // subscribers keep last-good data (their catch) and the next poll heals.
    throw new Error(`lost_found_list_failed_${res.status}`);
  }
  return data;
}

export async function fetchLostFoundCounts(pid: string): Promise<LostFoundCounts> {
  const res = await fetchWithAuth(`${BASE}?pid=${encodeURIComponent(pid)}&countsOnly=1`, {
    cache: 'no-store',
  });
  const data = await readEnvelope<{ counts: LostFoundCounts }>(res);
  if (data === null) {
    // Same silent-empty class as the register fetch — don't report zeros on a
    // failed response; let the subscriber keep its last-good counts.
    throw new Error(`lost_found_counts_failed_${res.status}`);
  }
  return data.counts;
}

/**
 * Initial fetch + foreground poll + visibility refetch. Returns an unsubscribe
 * fn. Cross-terminal liveness is poll-bounded (30s) — fine for L&F's volume;
 * the acting user sees instant updates by refetching after their own action.
 */
export function subscribeLostFound(
  pid: string,
  onData: (payload: RegisterPayload) => void,
  pollMs = 30_000,
  onError?: () => void,
): () => void {
  let active = true;
  const refresh = async () => {
    try {
      const payload = await fetchLostFoundRegister(pid);
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

/** Counts-only subscription for the owner dashboard tile. */
export function subscribeLostFoundCounts(
  pid: string,
  onCounts: (counts: LostFoundCounts) => void,
  pollMs = 60_000,
): () => void {
  let active = true;
  const refresh = async () => {
    try {
      const counts = await fetchLostFoundCounts(pid);
      if (active) onCounts(counts);
    } catch {
      /* keep last good */
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

// ─── Writes / actions ─────────────────────────────────────────────────────

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function postAction<T = unknown>(
  path: string,
  payload: Record<string, unknown>,
): Promise<ActionResult<T>> {
  try {
    const res = await fetchWithAuth(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

export interface LogItemInput {
  pid: string;
  type: 'found' | 'lost';
  itemDescription: string;
  category?: string | null;
  location?: string | null;
  roomNumber?: string | null;
  photoPath?: string | null;
  guestName?: string | null;
  foundBy?: string | null;
  reportedBy?: string | null;
  notes?: string | null;
  occurredAt?: string | null;
}

export function logLostFoundItem(input: LogItemInput): Promise<ActionResult<{ id: string }>> {
  return postAction<{ id: string }>(BASE, { action: 'log', ...input });
}

export function updateLostFoundItem(
  pid: string,
  id: string,
  patch: {
    status?: string;
    notes?: string | null;
    guestName?: string | null;
    category?: string | null;
    shippingInfo?: Record<string, unknown> | null;
  },
): Promise<ActionResult<{ updated: boolean }>> {
  return postAction(BASE, { action: 'update', pid, id, ...patch });
}

export function matchLostFound(
  pid: string,
  lostId: string,
  foundId: string,
): Promise<ActionResult<{ matched: boolean }>> {
  return postAction(BASE, { action: 'match', pid, lostId, foundId });
}

export interface DescribedPhoto {
  description: string;
  category: string;
  color: string | null;
}

export function describeFoundPhoto(
  pid: string,
  imageBase64: string,
  mediaType: string,
): Promise<ActionResult<DescribedPhoto>> {
  return postAction<DescribedPhoto>(`${BASE}/describe-photo`, { pid, imageBase64, mediaType });
}

export interface AutoMatchResult {
  matches: Array<{
    id: string;
    score: number;
    reasons: string[];
    aiConfidence?: 'high' | 'medium' | 'low';
    aiReason?: string;
    item: {
      id: string;
      itemDescription: string;
      category: string | null;
      location: string | null;
      roomNumber: string | null;
      photoPath: string | null;
      occurredAt: string | null;
    };
  }>;
}

export function autoMatchLost(pid: string, lostId: string): Promise<ActionResult<AutoMatchResult>> {
  return postAction<AutoMatchResult>(`${BASE}/auto-match`, { pid, lostId });
}

export interface PresignResult {
  path: string;
  signedUrl: string;
  token: string;
}

export function presignFoundPhoto(
  pid: string,
  scopeKey: string,
  filename: string,
): Promise<ActionResult<PresignResult>> {
  return postAction<PresignResult>(`${BASE}/photo-presign`, { pid, scopeKey, filename });
}
