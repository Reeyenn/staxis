// Client-side helpers for the per-staff link token (security audit 2026-06-26
// #1). The public mobile pages (/housekeeper/[id], /laundry/[id],
// /engineer/[id]) read the `tok` from their own URL and must forward it on
// every API call — it's the credential the server verifies
// (src/lib/staff-link-auth.ts). staffId in the URL is no longer sufficient.
//
// These are tiny, dependency-free, and safe to call in the browser only.
//
// ── Staff-link client kit (staff-pages overhaul F4, 2026-07) ──────────────
// On top of the original token helpers this module now also exports the
// shared client kit for the public no-login pages:
//
//   - staffGet()      — GET a /api/* route with pid+staffId+tok injected
//   - staffPost()     — POST a /api/* route with pid+staffId+tok folded into
//                       the body; opts.offline routes through the existing
//                       offline replay queue (useOfflineSync.enqueueIfOffline)
//
// HARD RULE (RLS bug class — bit this app 3 times): every read/write from a
// public page goes through a same-origin /api/* route. This module therefore
// refuses any path that doesn't start with `/api/` and has NO supabase import
// path at all. It also never decides WHICH actions are offline-queued — the
// caller opts in per action, exactly like today's per-component wiring.


/** Read the raw `tok` from the current page URL, or '' if absent. */
export function getStaffLinkTokenFromUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('tok') ?? '';
  } catch {
    return '';
  }
}

/**
 * Append `&tok=` (or `?tok=`) to a same-origin API path for GET requests.
 * No-op if there's no token in the URL (the server then returns 401, which is
 * the correct behaviour for a link that arrived without a token).
 */
export function withStaffLinkToken(url: string, tok = getStaffLinkTokenFromUrl()): string {
  if (!tok) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}tok=${encodeURIComponent(tok)}`;
}

/**
 * Fold the link token into a POST body object so the server can read it from
 * `body.tok`. Returns a shallow copy with `tok` set (unless already present).
 */
export function withStaffLinkTokenBody<T extends Record<string, unknown>>(
  body: T,
  tok = getStaffLinkTokenFromUrl(),
): T & { tok?: string } {
  if (!tok) return body;
  return { ...body, tok };
}

// ─── URL identity resolution ───────────────────────────────────────────────

/**
 * The three identity pieces every public staff page carries in its URL,
 * plus a `ready` flag that flips once they've been read (post-mount).
 *
 * Matches how the pages derive them today:
 *   - staffId — the `[id]` dynamic route segment (last path segment on
 *     /housekeeper/[id], /laundry/[id], /engineer/[id])
 *   - pid     — the `?pid=` query param (`useSearchParams().get('pid')`)
 *   - token   — the `?tok=` query param via getStaffLinkTokenFromUrl().
 *     NOT `?token=` — that's the legacy magic-link param the housekeeper
 *     page consumes separately and strips from the URL.
 */
export interface StaffLink {
  pid: string | null;
  staffId: string | null;
  /** Raw link token; '' when the link arrived without one (server 401s). */
  token: string;
  /** True once the URL has been read. Until then pid/staffId are null. */
  ready: boolean;
}

/** The subset of StaffLink that staffGet/staffPost need. */
export type StaffLinkIdentity = Pick<StaffLink, 'pid' | 'staffId' | 'token'>;

/** Read `?pid=` from the current page URL, or null if absent. */
export function getStaffLinkPidFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('pid');
  } catch {
    return null;
  }
}

/**
 * Extract the `[id]` route segment from a pathname. All three public staff
 * pages mount their dynamic id as the LAST path segment; Next hands the page
 * the decoded value, so decode here too. Returns null for a bare '/'.
 */
export function staffIdFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// ─── /api/* fetch kit ──────────────────────────────────────────────────────

/** Extra query params for staffGet. null/undefined values are skipped. */
export type StaffGetParams = Record<string, string | number | boolean | null | undefined>;

function assertApiPath(path: string): void {
  if (!path.startsWith('/api/')) {
    throw new Error(
      `staff-link-client: public staff pages may only call same-origin /api/* routes (got "${path}"). ` +
        'Direct table reads silently return [] for anon visitors under RLS.',
    );
  }
}

/**
 * Build the GET url for a public-page API read: `pid` + `staffId` injected as
 * query params (encodeURIComponent, same as the pages do today), extra params
 * appended, then the link token applied exactly as withStaffLinkToken.
 * Missing pid/staffId are omitted — the server then 400/401s, which is the
 * correct behaviour for a broken link.
 */
export function buildStaffLinkUrl(
  path: string,
  link: StaffLinkIdentity,
  params?: StaffGetParams,
): string {
  assertApiPath(path);
  const parts: string[] = [];
  if (link.pid) parts.push(`pid=${encodeURIComponent(link.pid)}`);
  if (link.staffId) parts.push(`staffId=${encodeURIComponent(link.staffId)}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  let url = path;
  if (parts.length > 0) {
    url += (path.includes('?') ? '&' : '?') + parts.join('&');
  }
  return withStaffLinkToken(url, link.token);
}

export interface StaffGetResult<T = unknown> {
  /** True only when HTTP 2xx AND the standard envelope says ok. */
  ok: boolean;
  /** HTTP status; 0 when the request never reached the server. */
  status: number;
  /** The envelope's `data` when ok, else null. */
  data: T | null;
  /** The envelope's `error` string when present (or 'network'). */
  error: string | null;
}

/**
 * GET a /api/* route with the staff-link identity injected. Never throws for
 * network/parse failures — returns `{ ok: false, status: 0 }` so callers keep
 * the pages' existing best-effort semantics. A 401 surfaces via `status` for
 * the tokenless-link guard.
 */
export async function staffGet<T = unknown>(
  path: string,
  link: StaffLinkIdentity,
  params?: StaffGetParams,
): Promise<StaffGetResult<T>> {
  const url = buildStaffLinkUrl(path, link, params);
  try {
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: T; error?: string }
      | null;
    const ok = res.ok && json?.ok === true;
    return {
      ok,
      status: res.status,
      data: ok ? (json?.data ?? null) : null,
      error: typeof json?.error === 'string' ? json.error : null,
    };
  } catch {
    return { ok: false, status: 0, data: null, error: 'network' };
  }
}

/**
 * The enqueueIfOffline contract from useOfflineSync (src/lib/offline-sync/
 * use-offline-sync.ts) — typed here so this module never imports React-hook
 * glue. Callers pass the function through, same as the per-room action
 * buttons do today.
 */
export type EnqueueIfOffline = (opts: {
  endpoint: string;
  body: Record<string, unknown>;
  label: string;
}) => Promise<{ ok: boolean; queued: boolean; data?: unknown; status?: number }>;

export interface StaffPostOpts {
  /**
   * Route this action through the offline replay queue. The kit never
   * decides which actions are offline-queued — callers opt in per action
   * and must supply `enqueueIfOffline` from useOfflineSync().
   */
  offline?: boolean;
  enqueueIfOffline?: EnqueueIfOffline;
  /** Offline-banner label for the queued action; defaults to the path. */
  label?: string;
}

export interface StaffPostResult {
  ok: boolean;
  /** True when the action was stored for later replay instead of sent. */
  queued: boolean;
  /** HTTP status when a response was received; 0 on network error. */
  status?: number;
  data?: unknown;
  error?: string | null;
}

/**
 * POST a /api/* route with pid + staffId + tok folded into the JSON body
 * (via withStaffLinkTokenBody, so replayed offline actions carry the token
 * too). The link is the source of truth — caller-provided pid/staffId in
 * `body` are overwritten.
 *
 * With `opts.offline: true` the call routes through the EXISTING
 * enqueueIfOffline unchanged. A queued result (`queued: true`) passes
 * through as-is so callers can distinguish queued from sent exactly like
 * today. A sent-while-online result is NORMALIZED to the direct-path shape
 * first — enqueueIfOffline returns the RAW response JSON (the full
 * envelope) in `data` and an HTTP-level `ok`, so without normalizing,
 * flipping an action to `{ offline: true }` would silently change what
 * `ok`/`data`/`error` mean at the call site.
 */
export async function staffPost(
  path: string,
  link: StaffLinkIdentity,
  body: Record<string, unknown>,
  opts?: StaffPostOpts,
): Promise<StaffPostResult> {
  assertApiPath(path);
  const injected = withStaffLinkTokenBody(
    {
      ...body,
      ...(link.pid ? { pid: link.pid } : {}),
      ...(link.staffId ? { staffId: link.staffId } : {}),
    },
    link.token,
  );

  if (opts?.offline) {
    if (typeof opts.enqueueIfOffline !== 'function') {
      throw new Error(
        'staff-link-client: staffPost({ offline: true }) requires enqueueIfOffline from useOfflineSync()',
      );
    }
    const result = await opts.enqueueIfOffline({
      endpoint: path,
      body: injected,
      label: opts.label ?? path,
    });
    if (result.queued) {
      // Stored for later replay — pass through unchanged (data carries the
      // queue receipt, e.g. { actionId, queued: true }, not an envelope).
      return result;
    }
    // Sent while online: enqueueIfOffline's `data` is the RAW response JSON
    // (the whole { ok, requestId, data, error } envelope) and its `ok` is
    // HTTP-level only. Normalize to the exact direct-path semantics so
    // callers never branch on how the action was routed.
    const envelope = (result.data ?? null) as
      | { ok?: boolean; data?: unknown; error?: string }
      | null;
    const sentOk = result.ok && envelope?.ok === true;
    return {
      ok: sentOk,
      queued: false,
      status: result.status,
      data: envelope?.data ?? null,
      error: typeof envelope?.error === 'string' ? envelope.error : null,
    };
  }

  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(injected),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: unknown; error?: string }
      | null;
    const ok = res.ok && json?.ok === true;
    return {
      ok,
      queued: false,
      status: res.status,
      data: json?.data ?? null,
      error: typeof json?.error === 'string' ? json.error : null,
    };
  } catch {
    return { ok: false, queued: false, status: 0, data: null, error: 'network' };
  }
}
