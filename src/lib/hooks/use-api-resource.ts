'use client';

/**
 * useApiResource / useApiAction — the standard client data-fetching pair
 * for staff pages (staff-pages overhaul, foundation wave).
 *
 * Today every page hand-rolls fetch-then-setState (settings, communications
 * lists, dashboard cards, …) and each copy re-solves — or forgets — the same
 * four hazards. This hook owns them once:
 *
 *   1. setState-after-unmount (and after enabled→false / URL switch)
 *   2. out-of-order responses — a slow request resolving after a newer one
 *      never clobbers fresher data (RequestGate tickets)
 *   3. polling hygiene — skips ticks while document.hidden, never overlaps
 *      an in-flight request
 *   4. error semantics — default blanks data on error; keepDataOnError
 *      holds last-good through a failed poll (CalloutBanner/laundry
 *      "never blank a page mid-shift" behavior)
 *
 * Auth rides fetchWithAuth (token preflight + 401 recovery); the envelope
 * is unwrapped by readEnvelope. SessionEndedError is swallowed — the page
 * is already navigating to /signin, nothing to render.
 *
 * NOT for realtime-backed data — subscribeTable surfaces (src/lib/db/
 * _common.ts) keep their refetch-on-event pattern. This is for plain
 * request/response resources and interval polls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
  NAVIGATION_FETCH_TIMEOUT_MS,
  SessionEndedError,
} from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import {
  createDeadlineAbortScope,
  raceWithAbortSignal,
  withPromiseDeadline,
  type DeadlineAbortScope,
} from '@/lib/fetch-deadline';
import {
  applyOutcome,
  createRequestGate,
  shouldHoldDataOnSourceChange,
  shouldPollTick,
  type ResourceOutcome,
} from './api-resource-core';

/** Custom fetcher: anything that resolves to an EnvelopeResult. Use when
 *  the request needs a method/body/params beyond a plain authed GET. */
export type ApiFetcher<T> = (signal?: AbortSignal) => Promise<EnvelopeResult<T>>;

export interface UseApiResourceOptions {
  /**
   * Additional authorization/scope identity for resources whose URL is
   * intentionally stable. Changing it aborts the old request, masks old data,
   * and performs a fresh initial load.
   */
  identityKey?: string | number | null;
  /**
   * Refetch every pollMs milliseconds. Ticks are SKIPPED while the tab is
   * hidden and while a previous request is still in flight — both built in,
   * don't re-gate at the call site.
   */
  pollMs?: number;
  /**
   * When true, a failed refetch keeps the last-good data (error is still
   * set). Default false: an error blanks data.
   */
  keepDataOnError?: boolean;
  /**
   * When false, nothing fetches and data stays null. Capability/section
   * gating happens here — at the fetch level — not by hiding the render.
   * Default true.
   */
  enabled?: boolean;
  /**
   * When true, switching URL/source does NOT blank data or re-show the
   * loading spinner — the previous resource's last-good data stays visible
   * until the new fetch resolves (tab switches, filter changes). The
   * stale-drop guard still applies: a late response for the OLD URL can
   * never land after the switch. This hold is allowed only while identityKey
   * is unchanged; role/grant changes always mask old data. Default false: a
   * URL switch drops the old data and shows the loading state (property
   * switches must never render one property's rows under another's spinner).
   */
  keepDataOnSourceChange?: boolean;
  /**
   * End-to-end budget including response-body parsing. Defaults to the shared
   * navigation-read budget. Pass null only for a deliberate long read whose
   * custom fetcher implements its own terminal timeout/error state.
   */
  timeoutMs?: number | null;
  /**
   * Revalidate after the document returns to the foreground. This is intended
   * for authorization-sensitive read models whose grants may have changed
   * while a tab was parked. Duplicate focus/pageshow/visibility events are
   * coalesced and an in-flight request is never overlapped.
   */
  revalidateOnFocus?: boolean;
  /**
   * Mask last-good data before a foreground revalidation. Use this for
   * tenant/scope DTOs where retaining a revoked company's rows during the
   * recheck would be a data flash. Default false.
   */
  clearDataOnFocusRevalidate?: boolean;
}

export interface UseApiResourceResult<T> {
  data: T | null;
  /** True until the first response for the current source lands (polls and
   *  reloads refresh silently — no loading flicker). */
  loading: boolean;
  error: string | null;
  /**
   * Imperative refetch (e.g. after a mutation elsewhere on the page).
   * Awaitable: the promise resolves once the triggered fetch settles (state
   * updated, or the result was dropped as stale). Never rejects — callers
   * that ignore the return value keep the old fire-and-forget behavior.
   */
  reload: () => Promise<void>;
}

type ResourceAuthorizationIdentity = string | number | null;

interface ResourceIdentity {
  /** `null` preserves the hook's existing function-source semantics: an
   * inline/custom fetcher is not itself a refetch key. */
  sourceKey: string | null;
  authorizationKey: ResourceAuthorizationIdentity;
}

interface ResourceIdentityState {
  /** Exact identity that produced the retained data. */
  data: ResourceIdentity | null;
  /** Exact identity that produced the retained error. */
  error: ResourceIdentity | null;
  /** Identity whose initial/reload status the loading flag describes. */
  status: ResourceIdentity | null;
}

function sameAuthorizationIdentity(
  left: ResourceIdentity | null,
  right: ResourceIdentity,
): boolean {
  return left !== null && Object.is(left.authorizationKey, right.authorizationKey);
}

function sameResourceIdentity(
  left: ResourceIdentity | null,
  right: ResourceIdentity,
): boolean {
  return sameAuthorizationIdentity(left, right) && left?.sourceKey === right.sourceKey;
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

async function settle<T>(
  source: string | ApiFetcher<T>,
  signal: AbortSignal,
): Promise<ResourceOutcome<T>> {
  try {
    const pending: Promise<EnvelopeResult<T>> =
      typeof source === 'string'
        ? (async () => readEnvelope<T>(
            await fetchWithAuth(source, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
              signal,
              // The hook's scope spans BOTH fetch and response JSON parsing.
              // Avoid a second independent timer inside fetchWithAuth.
              timeoutMs: null,
            }),
          ))()
        : source(signal);
    const result = await raceWithAbortSignal(pending, signal);
    if (result.error !== undefined) {
      return { kind: 'error', message: result.error };
    }
    return { kind: 'success', data: result.data as T };
  } catch (e) {
    if (e instanceof SessionEndedError) throw e; // handled by the caller
    return {
      kind: 'error',
      message: e instanceof Error && e.message ? e.message : 'Request failed',
    };
  }
}

/**
 * Fetch a resource and keep it in state.
 *
 *   const { data, loading, error, reload } =
 *     useApiResource<Room[]>(`/api/housekeeper/rooms?pid=${pid}`, { pollMs: 30_000 });
 *
 * Pass a function instead of a URL for POST-shaped reads or custom clients:
 *
 *   useApiResource(useCallback(
 *     () => fetchWithAuth('/api/x', { method: 'POST', body }).then(r => readEnvelope<X>(r)),
 *     [body],
 *   ));
 *
 * Function sources are read through a ref — a new function identity per
 * render does NOT refetch. Refetch happens on URL change (string sources),
 * enabled change, or reload(). Changing pollMs only re-arms the timer —
 * it never drops data or re-shows the loading spinner.
 */
export function useApiResource<T>(
  source: string | ApiFetcher<T>,
  opts: UseApiResourceOptions = {},
): UseApiResourceResult<T> {
  const {
    identityKey = null,
    pollMs,
    keepDataOnError = false,
    enabled = true,
    keepDataOnSourceChange = false,
    timeoutMs = NAVIGATION_FETCH_TIMEOUT_MS,
    revalidateOnFocus = false,
    clearDataOnFocusRevalidate = false,
  } = opts;

  // String sources are resource identities: switching URL (e.g. property
  // change) drops the old resource's data instead of showing it under the
  // new one's spinner. Function sources have no comparable identity.
  const sourceKey = typeof source === 'string' ? source : null;
  const currentIdentity: ResourceIdentity = {
    sourceKey,
    authorizationKey: identityKey,
  };

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);
  const [identityState, setIdentityState] = useState<ResourceIdentityState>({
    data: null,
    error: null,
    status: null,
  });

  const gateRef = useRef(createRequestGate());
  const inFlightRef = useRef(false);
  const activeRequestRef = useRef<DeadlineAbortScope | null>(null);

  // Latest values readable from a stable load() without re-running effects.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const currentIdentityRef = useRef(currentIdentity);
  currentIdentityRef.current = currentIdentity;
  const keepRef = useRef(keepDataOnError);
  keepRef.current = keepDataOnError;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const keepOnSourceChangeRef = useRef(keepDataOnSourceChange);
  keepOnSourceChangeRef.current = keepDataOnSourceChange;
  const timeoutRef = useRef(timeoutMs);
  timeoutRef.current = timeoutMs;
  const revalidateOnFocusRef = useRef(revalidateOnFocus);
  revalidateOnFocusRef.current = revalidateOnFocus;
  const clearOnFocusRef = useRef(clearDataOnFocusRevalidate);
  clearOnFocusRef.current = clearDataOnFocusRevalidate;
  const dataRef = useRef<T | null>(null);
  const identityStateRef = useRef(identityState);
  identityStateRef.current = identityState;
  // False until the identity effect has run once while enabled — the first
  // (initial) load must always show the loading state, opt-in or not.
  const hadIdentityRef = useRef(false);

  const commitIdentityState = useCallback((next: ResourceIdentityState) => {
    identityStateRef.current = next;
    setIdentityState(next);
  }, []);

  const load = useCallback(async (mode: 'initial' | 'poll' | 'reload') => {
    if (!enabledRef.current) return;
    // Capture the exact producer identity. Refs can change during an async
    // request when a parent switches role/grants or property; a response may
    // only ever be stamped with the identity under which it was requested.
    const requestIdentity = { ...currentIdentityRef.current };
    const ticket = gateRef.current.begin();
    const previousRequest = activeRequestRef.current;
    const request = createDeadlineAbortScope({
      timeoutMs: timeoutRef.current,
      label: 'Request',
    });
    activeRequestRef.current = request;
    // A reload/source change supersedes the older request. Abort the actual
    // transport as well as invalidating its state ticket.
    previousRequest?.abort();
    inFlightRef.current = true;
    commitIdentityState({
      ...identityStateRef.current,
      status: requestIdentity,
    });
    if (mode === 'initial') setLoading(true);

    let outcome: ResourceOutcome<T>;
    try {
      outcome = await settle(sourceRef.current, request.signal);
    } catch (error) {
      // Usually a redirect is already tearing the page down. Still settle the
      // resource so a sign-in-owned request or a blocked navigation can never
      // leave an immortal loading state.
      if (gateRef.current.isCurrent(ticket)) {
        inFlightRef.current = false;
        dataRef.current = keepRef.current ? dataRef.current : null;
        setData(dataRef.current);
        const message = error instanceof SessionEndedError
          ? 'Your session ended. Sign in again to continue.'
          : 'Request failed';
        setError(message);
        commitIdentityState({
          data: dataRef.current === null ? null : identityStateRef.current.data,
          error: requestIdentity,
          status: requestIdentity,
        });
        setLoading(false);
      }
      return;
    } finally {
      request.dispose();
      if (activeRequestRef.current === request) activeRequestRef.current = null;
    }

    // Stale ticket = a newer request started, or we unmounted/disabled/
    // switched URL. Its result must not touch state or the in-flight flag
    // (the newer request owns that now).
    if (!gateRef.current.isCurrent(ticket)) return;
    inFlightRef.current = false;

    const next = applyOutcome(dataRef.current, outcome, keepRef.current);
    dataRef.current = next.data;
    setData(next.data);
    setError(next.error);
    commitIdentityState({
      data: outcome.kind === 'success'
        ? requestIdentity
        : next.data === null
          ? null
          : identityStateRef.current.data,
      error: next.error === null ? null : requestIdentity,
      status: requestIdentity,
    });
    setLoading(false);
  }, [commitIdentityState]);

  // Resource identity: first mount, enabled flip, or URL change. Deliberately
  // NOT keyed on pollMs — adjusting polling cadence at runtime must never
  // blank last-good data or re-show the initial spinner (that would bypass
  // keepDataOnError's "never blank a page mid-shift" contract).
  useEffect(() => {
    const gate = gateRef.current;

    if (!enabled) {
      // Cancel anything in flight; clear state so a gated section never
      // shows another capability's leftovers. Re-enabling later counts as a
      // fresh first identity (loading state shows again).
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
      gate.invalidate();
      inFlightRef.current = false;
      dataRef.current = null;
      hadIdentityRef.current = false;
      setData(null);
      setError(null);
      commitIdentityState({ data: null, error: null, status: null });
      setLoading(false);
      return;
    }

    const previousDataIdentity = identityStateRef.current.data;
    const hasDataForCurrentAuthorization = dataRef.current !== null
      && sameAuthorizationIdentity(previousDataIdentity, currentIdentityRef.current);
    const hold = shouldHoldDataOnSourceChange({
      keepDataOnSourceChange: keepOnSourceChangeRef.current,
      isFirstIdentity: !hadIdentityRef.current,
      // Authorization changes are never an eligible "source change". This
      // remains false even when the same uid receives a different role or
      // property grant set via identityKey.
      hasData: hasDataForCurrentAuthorization,
    });
    hadIdentityRef.current = true;

    if (hold) {
      // Opt-in silent switch: keep last-good data on screen, no spinner.
      // The cleanup below already invalidated the old identity's ticket, so
      // a late response for the previous URL can never land.
      void load('reload');
    } else {
      // Default: new resource identity (or first mount) drops the previous
      // resource's data before fetching so it can't render under the new one.
      dataRef.current = null;
      setData(null);
      setError(null);
      commitIdentityState({ data: null, error: null, status: currentIdentityRef.current });
      void load('initial');
    }

    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
      gate.invalidate();
      inFlightRef.current = false;
    };
  }, [enabled, sourceKey, identityKey, load, commitIdentityState]);

  // Polling timer, managed separately so a pollMs change only re-arms the
  // interval. Any in-flight request keeps running (the tick skips while one
  // is in flight anyway). sourceKey stays in the deps so a URL switch
  // restarts the interval phase relative to the fresh initial load.
  useEffect(() => {
    if (!enabled || pollMs === undefined || pollMs <= 0) return;
    const timer = setInterval(() => {
      if (
        !shouldPollTick({
          enabled: enabledRef.current,
          hidden: isDocumentHidden(),
          inFlight: inFlightRef.current,
        })
      ) {
        return;
      }
      void load('poll');
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, sourceKey, identityKey, load]);

  useEffect(() => {
    if (!enabled || !revalidateOnFocus) return;
    let lastForegroundAt = 0;
    const revalidate = () => {
      if (!revalidateOnFocusRef.current
        || !enabledRef.current
        || isDocumentHidden()) return;
      // Authorization-sensitive resources opt into synchronous masking. A
      // request started before the tab was parked cannot be trusted after a
      // foreground transition, so supersede it instead of waiting for it.
      if (inFlightRef.current && !clearOnFocusRef.current) return;
      const now = Date.now();
      // One foreground transition commonly emits visibilitychange, pageshow,
      // and focus. One fresh read is sufficient.
      if (now - lastForegroundAt < 100) return;
      lastForegroundAt = now;
      if (clearOnFocusRef.current) {
        dataRef.current = null;
        setData(null);
        setError(null);
        commitIdentityState({
          data: null,
          error: null,
          status: currentIdentityRef.current,
        });
        void load('initial');
      } else {
        void load('reload');
      }
    };
    window.addEventListener('focus', revalidate);
    window.addEventListener('pageshow', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('pageshow', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [
    enabled,
    revalidateOnFocus,
    sourceKey,
    identityKey,
    load,
    commitIdentityState,
  ]);

  const reload = useCallback(() => load('reload'), [load]);

  // Effects only clear old state after a render commits. Masking here closes
  // that render-sized gap: a role/grant/property change cannot expose the
  // previous identity's rows or error while React waits to run the effect.
  const dataMatchesCurrent = sameResourceIdentity(identityState.data, currentIdentity);
  const canHoldDataAcrossSource = enabled
    && data !== null
    && keepDataOnSourceChange
    && sameAuthorizationIdentity(identityState.data, currentIdentity);
  const visibleData = enabled && (dataMatchesCurrent || canHoldDataAcrossSource)
    ? data
    : null;
  const visibleError = enabled && sameResourceIdentity(identityState.error, currentIdentity)
    ? error
    : null;

  let visibleLoading = false;
  if (enabled) {
    if (!sameAuthorizationIdentity(identityState.status, currentIdentity)) {
      visibleLoading = true;
    } else if (!sameResourceIdentity(identityState.status, currentIdentity)) {
      // The opt-in hold is intentionally limited to a source switch inside
      // the exact same authorization identity. It never spans identityKey.
      visibleLoading = !canHoldDataAcrossSource;
    } else {
      visibleLoading = loading;
    }
  }

  return {
    data: visibleData,
    loading: visibleLoading,
    error: visibleError,
    reload,
  };
}

export interface UseApiActionResult<TIn, TOut> {
  /**
   * Run the action. Never rejects: resolves to the EnvelopeResult so call
   * sites can `const r = await run(x); if (r.error) …` without try/catch.
   * If the session ended mid-action, resolves to an error result WITHOUT
   * touching state (the redirect to /signin is already in progress).
   */
  run: (input: TIn) => Promise<EnvelopeResult<TOut>>;
  saving: boolean;
  error: string | null;
}

export interface UseApiActionOptions {
  /**
   * Outer UI-settlement deadline. The default protects ordinary one-request
   * actions. Pass null only for a finite composite workflow whose individual
   * requests already have deadlines; racing such a workflow can report total
   * failure after an early non-idempotent step committed and invite a
   * duplicate retry while later steps are still running.
   */
  timeoutMs?: number | null;
}

/**
 * Mutation counterpart to useApiResource: wraps a write with { saving,
 * error } state and the same unmount safety.
 *
 *   const save = useApiAction((note: string) =>
 *     fetchWithAuth('/api/housekeeper/add-note', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ pid, staffId, note }),
 *     }).then(r => readEnvelope<{ id: string }>(r)));
 *
 *   const result = await save.run(note);
 *   if (!result.error) closeSheet();
 *
 * The fn is read through a ref, so an inline closure over fresh props is
 * fine. If run() is called again while a previous run is pending, the
 * latest call owns saving/error (older results still resolve to their
 * callers but stop driving state).
 */
export function useApiAction<TIn, TOut>(
  fn: (input: TIn) => Promise<EnvelopeResult<TOut>>,
  options: UseApiActionOptions = {},
): UseApiActionResult<TIn, TOut> {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gateRef = useRef(createRequestGate());
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timeoutRef = useRef<number | null>(INTERACTIVE_ACTION_TIMEOUT_MS);
  timeoutRef.current = options.timeoutMs === undefined
    ? INTERACTIVE_ACTION_TIMEOUT_MS
    : options.timeoutMs;

  useEffect(() => {
    const gate = gateRef.current;
    return () => {
      gate.invalidate();
    };
  }, []);

  const run = useCallback(async (input: TIn): Promise<EnvelopeResult<TOut>> => {
    const ticket = gateRef.current.begin();
    setSaving(true);
    setError(null);

    let result: EnvelopeResult<TOut>;
    try {
      // The shared action adapter must always release `saving`. The underlying
      // write is never auto-retried because the server may have committed even
      // when its response was lost; callers can reconcile on their next read.
      const pending = fnRef.current(input);
      result = timeoutRef.current === null
        ? await pending
        : await withPromiseDeadline(pending, {
          timeoutMs: timeoutRef.current,
          label: 'Action confirmation',
        });
    } catch (e) {
      if (e instanceof SessionEndedError) {
        // A redirect normally tears this state down, but settling is harmless
        // and prevents a blocked/in-page auth flow from retaining `saving`.
        result = { error: 'Your session ended. Sign in again to continue.' };
      } else {
        result = {
          error: e instanceof Error && e.message ? e.message : 'Request failed',
        };
      }
    }

    if (gateRef.current.isCurrent(ticket)) {
      setSaving(false);
      setError(result.error ?? null);
    }
    return result;
  }, []);

  return { run, saving, error };
}
