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

import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import {
  applyOutcome,
  createRequestGate,
  shouldPollTick,
  type ResourceOutcome,
} from './api-resource-core';

/** Custom fetcher: anything that resolves to an EnvelopeResult. Use when
 *  the request needs a method/body/params beyond a plain authed GET. */
export type ApiFetcher<T> = () => Promise<EnvelopeResult<T>>;

export interface UseApiResourceOptions {
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
}

export interface UseApiResourceResult<T> {
  data: T | null;
  /** True until the first response for the current source lands (polls and
   *  reloads refresh silently — no loading flicker). */
  loading: boolean;
  error: string | null;
  /** Imperative refetch (e.g. after a mutation elsewhere on the page). */
  reload: () => void;
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

async function settle<T>(source: string | ApiFetcher<T>): Promise<ResourceOutcome<T>> {
  try {
    const result: EnvelopeResult<T> =
      typeof source === 'string'
        ? await readEnvelope<T>(
            await fetchWithAuth(source, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : await source();
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
  const { pollMs, keepDataOnError = false, enabled = true } = opts;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);

  const gateRef = useRef(createRequestGate());
  const inFlightRef = useRef(false);

  // Latest values readable from a stable load() without re-running effects.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const keepRef = useRef(keepDataOnError);
  keepRef.current = keepDataOnError;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const dataRef = useRef<T | null>(null);

  // String sources are resource identities: switching URL (e.g. property
  // change) drops the old resource's data instead of showing it under the
  // new one's spinner. Function sources have no comparable identity.
  const sourceKey = typeof source === 'string' ? source : null;

  const load = useCallback(async (mode: 'initial' | 'poll' | 'reload') => {
    if (!enabledRef.current) return;
    const ticket = gateRef.current.begin();
    inFlightRef.current = true;
    if (mode === 'initial') setLoading(true);

    let outcome: ResourceOutcome<T>;
    try {
      outcome = await settle(sourceRef.current);
    } catch {
      // SessionEndedError: signed out mid-request, redirect already firing.
      if (gateRef.current.isCurrent(ticket)) inFlightRef.current = false;
      return;
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
    setLoading(false);
  }, []);

  // Resource identity: first mount, enabled flip, or URL change. Deliberately
  // NOT keyed on pollMs — adjusting polling cadence at runtime must never
  // blank last-good data or re-show the initial spinner (that would bypass
  // keepDataOnError's "never blank a page mid-shift" contract).
  useEffect(() => {
    const gate = gateRef.current;

    if (!enabled) {
      // Cancel anything in flight; clear state so a gated section never
      // shows another capability's leftovers.
      gate.invalidate();
      inFlightRef.current = false;
      dataRef.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    // New resource identity (or first mount): drop the previous resource's
    // data before fetching so it can't render under the new one.
    dataRef.current = null;
    setData(null);
    setError(null);
    void load('initial');

    return () => {
      gate.invalidate();
      inFlightRef.current = false;
    };
  }, [enabled, sourceKey, load]);

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
  }, [enabled, pollMs, sourceKey, load]);

  const reload = useCallback(() => {
    void load('reload');
  }, [load]);

  return { data, loading, error, reload };
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
): UseApiActionResult<TIn, TOut> {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gateRef = useRef(createRequestGate());
  const fnRef = useRef(fn);
  fnRef.current = fn;

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
      result = await fnRef.current(input);
    } catch (e) {
      if (e instanceof SessionEndedError) {
        // Redirect to /signin already firing — leave state alone.
        return { error: 'Session ended' };
      }
      result = {
        error: e instanceof Error && e.message ? e.message : 'Request failed',
      };
    }

    if (gateRef.current.isCurrent(ticket)) {
      setSaving(false);
      setError(result.error ?? null);
    }
    return result;
  }, []);

  return { run, saving, error };
}
