/**
 * Per-hotel read mutex with timeout and skipped-tick metrics.
 *
 * Plan v4 architecture decision #4 (per Codex's adversarial finding):
 * the polling cadence is ~30 sec, but Choice Advantage page loads can
 * take 60-90 sec under load. Without a mutex, the next tick fires while
 * the previous one is still running — overlapping reads against the
 * same browser context. This module is the guard.
 *
 * Semantics:
 *   - schedule(fn): if a tick is already running for this property,
 *     skip the new tick (count as 'skipped'). Otherwise run fn() under
 *     the mutex with a hard timeout. Returns the result or null on skip.
 *   - hard timeout aborts the read via AbortSignal so a wedged Playwright
 *     promise can't permanently hold the mutex.
 *   - skipped + timed-out + completed counts surface in heartbeat so we
 *     can spot a hotel that's perpetually falling behind.
 *
 * Why per-hotel: each Fly machine in plan v4 hosts ONE hotel (one
 * BrowserContext), so the mutex is naturally per-process. But the
 * supervisor model can in future host multiple hotels per process, so
 * the API is keyed by propertyId from day one.
 */

import { log } from './log.js';

interface SingleFlightState {
  /** True when a tick is currently executing. */
  busy: boolean;
  /** When the current tick started, for timeout enforcement + diagnostics. */
  startedAt: number | null;
  /** Lifetime counters since process start. */
  metrics: {
    completed: number;
    skipped: number;
    timedOut: number;
    failed: number;
  };
  /** Abort controller for the in-flight tick — set when busy=true. */
  abortController: AbortController | null;
}

const states = new Map<string, SingleFlightState>();

function getState(propertyId: string): SingleFlightState {
  let state = states.get(propertyId);
  if (!state) {
    state = {
      busy: false,
      startedAt: null,
      metrics: { completed: 0, skipped: 0, timedOut: 0, failed: 0 },
      abortController: null,
    };
    states.set(propertyId, state);
  }
  return state;
}

export interface SingleFlightMetrics {
  completed: number;
  skipped: number;
  timedOut: number;
  failed: number;
  /** Currently in-flight? */
  inFlight: boolean;
  /** ms since the in-flight tick started, or null. */
  inFlightAgeMs: number | null;
}

/**
 * Schedule a tick under the per-hotel mutex. If a tick is already
 * running, returns null and increments the skipped counter. Otherwise
 * runs fn() with a hard timeout and returns its result.
 *
 * fn receives an AbortSignal — it should propagate this to long-running
 * operations (Playwright actions, Claude calls) so the timeout can
 * actually interrupt them.
 */
export async function schedule<T>(
  propertyId: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const state = getState(propertyId);

  if (state.busy) {
    state.metrics.skipped++;
    const ageMs = state.startedAt ? Date.now() - state.startedAt : 0;
    log.warn('single-flight: skip (prior tick still running)', {
      propertyId,
      inFlightAgeMs: ageMs,
      timeoutMs,
      skippedTotal: state.metrics.skipped,
    });
    return null;
  }

  const abortController = new AbortController();
  state.busy = true;
  state.startedAt = Date.now();
  state.abortController = abortController;

  const timeoutHandle = setTimeout(() => {
    log.warn('single-flight: tick exceeded timeout — aborting', {
      propertyId,
      timeoutMs,
    });
    abortController.abort();
  }, timeoutMs);

  try {
    const result = await fn(abortController.signal);
    state.metrics.completed++;
    return result;
  } catch (err) {
    if (abortController.signal.aborted) {
      state.metrics.timedOut++;
      log.warn('single-flight: tick timed out', {
        propertyId,
        timeoutMs,
        timedOutTotal: state.metrics.timedOut,
      });
    } else {
      state.metrics.failed++;
      log.warn('single-flight: tick failed', {
        propertyId,
        err: err instanceof Error ? err.message : String(err),
        failedTotal: state.metrics.failed,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    state.busy = false;
    state.startedAt = null;
    state.abortController = null;
  }
}

/**
 * Snapshot the metrics for a hotel. Heartbeat publishes these so
 * operators can see if a hotel is falling behind.
 */
export function getMetrics(propertyId: string): SingleFlightMetrics {
  const state = getState(propertyId);
  return {
    completed: state.metrics.completed,
    skipped: state.metrics.skipped,
    timedOut: state.metrics.timedOut,
    failed: state.metrics.failed,
    inFlight: state.busy,
    inFlightAgeMs: state.startedAt ? Date.now() - state.startedAt : null,
  };
}

/**
 * Abort the in-flight tick if any. Used during graceful shutdown so the
 * supervisor can release the mutex before Fly kills the process.
 */
export function abortIfRunning(propertyId: string): void {
  const state = states.get(propertyId);
  if (state?.busy && state.abortController) {
    state.abortController.abort();
  }
}

/**
 * Clear all state for a hotel. Used when the supervisor stops managing
 * a hotel (e.g., admin disabled it). Not used in normal operation.
 */
export function reset(propertyId: string): void {
  states.delete(propertyId);
}
