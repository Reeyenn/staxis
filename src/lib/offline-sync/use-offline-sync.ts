/**
 * React hook glue for the offline queue.
 *
 * Used by the housekeeper page to:
 *   - Wrap mutating fetches with `enqueueIfOffline` — when navigator.onLine
 *     is false the action is queued for replay; when online it's sent
 *     directly. Either way the function returns the same shape so the
 *     caller's UI logic doesn't branch on connectivity.
 *   - Listen for the window 'online' event and trigger a queue drain.
 *   - Expose the queue length + last drain result for the banner UI.
 *
 * Service worker integration: the SW caches the page shell only; it does
 * NOT intercept fetches and route them through Background Sync. Reason:
 * Background Sync isn't supported on iOS Safari (which is most of our
 * housekeeper devices), so a hand-rolled `navigator.onLine` + IndexedDB
 * dance is simpler and works the same everywhere.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  enqueueAction,
  drainQueue,
  getQueueLength,
  clearFailures,
  generateOfflineActionId,
  type QueuedAction,
  type DrainProgress,
} from './queue';

export interface OfflineSyncState {
  /** navigator.onLine — true while connected. */
  online: boolean;
  /** Items currently in the queue (includes permanent failures). */
  queueLength: number;
  /** Last drain result; null until we've tried at least once. */
  lastDrain: DrainProgress | null;
  /** True while a drain is in flight. */
  draining: boolean;
}

interface EnqueueOpts {
  endpoint: string;
  body: Record<string, unknown>;
  label: string;
}

interface FetchResult {
  ok: boolean;
  queued: boolean;
  data?: unknown;
  status?: number;
}

export function useOfflineSync() {
  const [state, setState] = useState<OfflineSyncState>(() => ({
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    queueLength: 0,
    lastDrain: null,
    draining: false,
  }));
  const drainingRef = useRef(false);
  // Every trigger records a generation, including triggers that arrive while
  // a drain is already running. The active runner loops when the generation
  // changes so an action enqueued mid-drain cannot be stranded until the next
  // remount or browser online event.
  const drainRequestSeqRef = useRef(0);

  // Sync queueLength when the component mounts.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const len = await getQueueLength();
        if (!cancelled) setState((s) => ({ ...s, queueLength: len }));
      } catch {
        // best-effort; the banner is OK with stale length
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const triggerDrain = useCallback(async () => {
    drainRequestSeqRef.current += 1;
    if (drainingRef.current) return;
    drainingRef.current = true;
    setState((s) => ({ ...s, draining: true }));
    while (true) {
      const requestSeqAtStart = drainRequestSeqRef.current;
      let result: DrainProgress | null = null;
      let newLen: number | null = null;
      try {
        result = await drainQueue();
        newLen = await getQueueLength();
      } catch {
        // Best-effort. A newer trigger still causes another pass below.
      }
      if (requestSeqAtStart !== drainRequestSeqRef.current) continue;

      // No await between this equality check and releasing the runner: a new
      // trigger can therefore either change the generation above or observe
      // drainingRef=false and become the next runner; neither path is lost.
      drainingRef.current = false;
      setState((s) => ({
        ...s,
        lastDrain: result ?? s.lastDrain,
        queueLength: newLen ?? s.queueLength,
        draining: false,
      }));
      return;
    }
  }, []);

  useEffect(() => {
    const onOnline = () => {
      setState((s) => ({ ...s, online: true }));
      void triggerDrain();
    };
    const onOffline = () => setState((s) => ({ ...s, online: false }));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [triggerDrain]);

  // Drain on mount too — covers the case where the user opens the app
  // while online but the queue has leftovers from a previous offline
  // session that the page closed before draining.
  useEffect(() => {
    void triggerDrain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A 429 or retryable 503 can arrive while navigator.onLine remains true, so
  // there may be no future "online" event to restart the drain. Honor the
  // queue's bounded backoff suggestion and keep retrying pending work.
  useEffect(() => {
    const progress = state.lastDrain;
    if (
      !state.online
      || state.draining
      || state.queueLength === 0
      || !progress
      || progress.pending === 0
      || progress.retryAfterMs === null
      || (typeof navigator !== 'undefined' && !navigator.onLine)
    ) return;

    const timer = window.setTimeout(() => {
      void triggerDrain();
    }, progress.retryAfterMs);
    return () => window.clearTimeout(timer);
  }, [state.online, state.draining, state.queueLength, state.lastDrain, triggerDrain]);

  /**
   * Fire a mutating request. If we're online, fetches and returns the
   * server's response. If we're offline, queues the action and returns
   * `{ ok: true, queued: true }` so the caller can render optimistic UI.
   */
  const enqueueIfOffline = useCallback(
    async ({ endpoint, body, label }: EnqueueOpts): Promise<FetchResult> => {
      const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
      if (!isOnline) {
        const queued = await enqueueAction({ endpoint, body, label });
        const newLen = await getQueueLength();
        setState((s) => ({ ...s, queueLength: newLen }));
        return { ok: true, queued: true, data: { actionId: queued.id, queued: true } };
      }
      // Online, but if OLDER actions are still queued (from a prior offline
      // stretch), sending this newer write directly would let it hit the server
      // BEFORE those replay — and the later drain would then overwrite it with
      // stale state. Route it through the queue so everything replays in
      // enqueue order, and kick a drain.
      const pending = await getQueueLength().catch(() => 0);
      if (pending > 0) {
        const queued = await enqueueAction({ endpoint, body, label });
        setState((s) => ({ ...s, queueLength: pending + 1 }));
        void triggerDrain();
        return { ok: true, queued: true, data: { actionId: queued.id, queued: true } };
      }
      // Queue empty → safe to send directly (fast path).
      // Always send an idempotency key on the FIRST online attempt. The queue
      // generator includes a UUID fallback for older browsers; leaving this
      // undefined there would make a response-loss replay a distinct action.
      const actionId = generateOfflineActionId();
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, actionId }),
        });
        const json = (await res.json().catch(() => null)) as unknown;
        if (!res.ok) {
          return { ok: false, queued: false, data: json, status: res.status };
        }
        return { ok: true, queued: false, data: json, status: res.status };
      } catch {
        // Network-level fail mid-flight — most likely the connection just
        // dropped. Queue and let the next online event replay. Reuse the
        // actionId sent in the failed request: the server may have committed
        // the mutation before its response was lost, and a newly-minted id
        // would make the replay look like a distinct action.
        const queued = await enqueueAction({ endpoint, body, label, id: actionId });
        const newLen = await getQueueLength();
        setState((s) => ({ ...s, queueLength: newLen, online: false }));
        return { ok: true, queued: true, data: { actionId: queued.id, queued: true } };
      }
    },
    [triggerDrain],
  );

  const dismissFailures = useCallback(async () => {
    await clearFailures();
    const newLen = await getQueueLength();
    setState((s) => ({ ...s, queueLength: newLen }));
  }, []);

  return {
    ...state,
    enqueueIfOffline,
    triggerDrain,
    dismissFailures,
  };
}

export type { QueuedAction };
