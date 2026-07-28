import type { EnvelopeResult } from '@/lib/api-envelope';

/**
 * A portfolio probe decides which Feed the signed-in person owns. It is a
 * navigation dependency, so it gets a shorter, explicit ceiling than an
 * ordinary background refresh: after this point the screen must offer Retry
 * instead of leaving a blank page behind a promise that may never settle.
 */
export const PORTFOLIO_QUEUE_DEADLINE_MS = 8_000;

export const PORTFOLIO_QUEUE_TIMEOUT_ERROR =
  'Staxis could not finish opening your queue. Check your connection and try again.';

/**
 * Bound the whole authenticated read, including token preparation. Aborting
 * the fetch alone is not enough because auth can stall before fetch starts;
 * the race gives the UI a terminal result, while the already-aborted signal
 * prevents a late token continuation from starting useful network work.
 */
export async function readWithPortfolioDeadline<T>(
  read: (signal: AbortSignal) => Promise<EnvelopeResult<T>>,
  timeoutMs = PORTFOLIO_QUEUE_DEADLINE_MS,
): Promise<EnvelopeResult<T>> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<EnvelopeResult<T>>((resolve) => {
    timeoutId = setTimeout(() => {
      // Resolve first so the timeout owns the race even when abort dispatches a
      // synchronous listener in a mocked/test transport.
      resolve({ error: PORTFOLIO_QUEUE_TIMEOUT_ERROR });
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([read(controller.signal), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export interface ScopePayloadLike {
  scope: object | null;
}

export type PortfolioRequestState<T extends ScopePayloadLike> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'hotel'; data: T }
  | { kind: 'portfolio'; data: T };

/**
 * One exhaustive answer for the fetching wrapper. Last-good data wins over a
 * failed refresh; without data, every path is visible and terminal.
 */
export function portfolioRequestState<T extends ScopePayloadLike>({
  data,
  loading,
  error,
}: {
  data: T | null;
  loading: boolean;
  error: string | null;
}): PortfolioRequestState<T> {
  if (data?.scope) return { kind: 'portfolio', data };
  if (data) return { kind: 'hotel', data };
  if (error) return { kind: 'error', message: error };
  if (loading) return { kind: 'loading' };

  // Defensive terminal state: the resource hook should always supply either
  // loading, data, or error, but silence is never a safe fourth outcome.
  return { kind: 'error', message: PORTFOLIO_QUEUE_TIMEOUT_ERROR };
}

export type HotelFallbackState = 'waiting' | 'portfolio' | 'hotel' | 'empty';

export interface ViewerPortfolioScope<TScope extends object> {
  viewerKey: string;
  scope: TScope | null;
}

/**
 * A null company scope is a real, authorization-owned answer: it says the
 * current person should see the hotel queue. Preserve that distinction while
 * synchronously masking an answer produced for a previous account, role,
 * grant set, or resolved hotel set. Effects run too late to close that gap.
 */
export function portfolioScopeForViewer<TScope extends object>(
  snapshot: ViewerPortfolioScope<TScope> | null,
  viewerKey: string | null,
): TScope | null | undefined {
  if (!viewerKey || snapshot?.viewerKey !== viewerKey) return undefined;
  return snapshot.scope;
}

/** A signed-in Queue must remain visibly pending until PropertyContext has
 * resolved the exact hotel set used by its authorization identity. */
export function shouldRenderQueueIdentityLoading(
  signedIn: boolean,
  viewerKey: string | null,
): boolean {
  return signedIn && viewerKey === null;
}

/**
 * The probe owns the screen only until it identifies a hotel-scoped account,
 * or for as long as it has real portfolio data to render. Once it reports a
 * null scope the parent owns the terminal hotel/empty state; keeping the probe
 * mounted would leave its handoff spinner above that content forever.
 */
export function shouldRenderPortfolioProbe(
  companyScope: object | null | undefined,
): boolean {
  return companyScope !== null;
}

/** What QueueView renders after the portfolio probe has answered. */
export function hotelFallbackState(
  companyScope: object | null | undefined,
  canReadHotelQueue: boolean,
): HotelFallbackState {
  if (companyScope === undefined) return 'waiting';
  if (companyScope !== null) return 'portfolio';
  return canReadHotelQueue ? 'hotel' : 'empty';
}
