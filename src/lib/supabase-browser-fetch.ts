import { fetchWithDeadline } from '@/lib/fetch-deadline';

/** Auth initialization/refresh must release the GoTrue lock inside this budget. */
export const SUPABASE_AUTH_FETCH_TIMEOUT_MS = 8_000;

/** Ordinary PostgREST reads should reach data or a retryable error promptly. */
export const SUPABASE_READ_FETCH_TIMEOUT_MS = 10_000;

/**
 * PostgREST RPCs use POST even when the SQL function is read-only, so method
 * alone cannot distinguish a navigation read from a mutation. Keep this list
 * deliberately narrow: these functions are audited read-only bridges used by
 * navigation-critical pages. A new entry requires confirming the SQL function
 * cannot write before giving it the shared read deadline.
 */
const NAVIGATION_READ_RPC_PATHS = new Set([
  '/rest/v1/rpc/today_room_work_v1',
  '/rest/v1/rpc/today_property_counts_v1',
  '/rest/v1/rpc/staxis_list_inventory_delivery_corrections',
]);

export interface SupabaseBrowserFetchOptions {
  authTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input !== null && typeof (input as Request).url === 'string') {
    return (input as Request).url;
  }
  return String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && typeof (input as Request).method === 'string') {
    return (input as Request).method.toUpperCase();
  }
  return 'GET';
}

function pathname(input: RequestInfo | URL): string {
  try {
    return new URL(requestUrl(input), 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/**
 * Fetch policy for the browser Supabase client.
 *
 * - Auth calls are always bounded. In particular, a hung refresh-token POST
 *   can no longer hold GoTrue initialization (and its cross-tab lock) forever.
 * - GET/HEAD PostgREST reads are bounded because they drive page navigation.
 * - Mutations, Storage transfers, Edge Functions and Realtime are unchanged;
 *   their callers own domain-specific/upload/streaming deadlines.
 */
export function createSupabaseBrowserFetch(
  options: SupabaseBrowserFetchOptions = {},
): typeof fetch {
  const authTimeoutMs = options.authTimeoutMs ?? SUPABASE_AUTH_FETCH_TIMEOUT_MS;
  const readTimeoutMs = options.readTimeoutMs ?? SUPABASE_READ_FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathname(input);
    const method = requestMethod(input, init);
    const isAuth = path.includes('/auth/v1/');
    const isKnownReadRpc = method === 'POST' && NAVIGATION_READ_RPC_PATHS.has(path.replace(/\/+$/, ''));
    const isPostgrestRead = path.includes('/rest/v1/')
      && (method === 'GET' || method === 'HEAD' || isKnownReadRpc);

    if (isAuth) {
      return fetchWithDeadline(input, init, {
        timeoutMs: authTimeoutMs,
        label: 'Authentication request',
        fetchImpl,
      });
    }
    if (isPostgrestRead) {
      return fetchWithDeadline(input, init, {
        timeoutMs: readTimeoutMs,
        label: 'Database request',
        fetchImpl,
      });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

export const supabaseBrowserFetch = createSupabaseBrowserFetch();
