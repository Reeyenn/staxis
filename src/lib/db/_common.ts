// ═══════════════════════════════════════════════════════════════════════════
// Shared infrastructure for the data access layer (db/*).
//
// Lifted out of the original src/lib/db.ts monolith on 2026-04-28 when the
// data access layer was split into per-domain files. Every db/*.ts module
// imports the supabase client + logErr + subscribeTable from here.
//
// Keep this file small. Domain-specific code goes in its domain module —
// only truly shared utilities belong here.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '../supabase';

export { supabase };

// ─── tiny utilities ─────────────────────────────────────────────────────────

export function logErr(tag: string, err: unknown): void {
  // Supabase PostgrestError is a plain object ({ message, details, hint,
  // code }), not an Error subclass — String(err) returns "[object Object]"
  // and hides the actual failure, which is the worst possible outcome in
  // a logger. Extract .message + .code + .hint + .details manually.
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code    === 'string') parts.push(`code=${e.code}`);
    if (typeof e.hint    === 'string') parts.push(`hint=${e.hint}`);
    if (typeof e.details === 'string') parts.push(`details=${e.details}`);
    msg = parts.length ? parts.join(' ') : JSON.stringify(err);
  } else {
    msg = String(err);
  }
   
  console.error(`[Supabase] ${tag}:`, msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// Realtime helper: initial fetch + postgres_changes subscription
// ═══════════════════════════════════════════════════════════════════════════
//
// Postgres Realtime delivers one row per event. Instead of diff-merging on
// the client, each change triggers a cheap re-fetch so the callback always
// receives the full, consistent list — mirrors Firestore's `onSnapshot`
// semantics exactly.
//
// `filter` is a Postgres-level filter (e.g. `property_id=eq.xxx`). Realtime
// only supports a single binary filter expression, so for multi-column
// scoping (e.g. property_id AND date) the caller can pass a `shouldRefetch`
// predicate that inspects the change payload and returns false when the
// changed row is outside the caller's slice — that suppresses unnecessary
// re-fetches when, e.g., another date's row is updated for the same
// property.
//
// `doFetch` is the initial + refresh loader. Returns an unsubscribe function.

/** Shape of the postgres_changes payload that Realtime delivers to listeners. */
export interface PostgresChangesPayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

/**
 * Optional reducer that applies a postgres_changes payload directly to the
 * current row list, avoiding a full table re-fetch. Implementations should:
 *   - INSERT: append (or skip if outside the slice this subscription cares about)
 *   - UPDATE: replace by id
 *   - DELETE: filter out by id
 * Return `null` to signal "I can't safely apply this — please refetch."
 * That fallback fires when payload.new is missing fields (e.g. when
 * REPLICA IDENTITY FULL hasn't been set on the underlying table) or when
 * the diff is shape-incompatible with the local type.
 *
 * The reducer MUST return a new array (no mutation) so React-style consumers
 * see a referentially-new value.
 *
 * Audit cost recommendation #4 (.claude/reports/cost-hotpaths-audit.md):
 * the previous design fired one full re-fetch per row change, so bulk
 * updates (manager bulk-marks 20 rooms) produced 20 amplified refetches.
 */
export type ApplyPayloadReducer<T> = (
  payload: PostgresChangesPayload,
  currentRows: readonly T[],
) => T[] | null;

/**
 * Build an applyPayload reducer for the common "upsert by id, optionally
 * filtered by slice" pattern. Three of the hot subscriptions (rooms,
 * cleaning_events, shift_confirmations) share this shape; an `id` field
 * identifies the row and a date-like column scopes the slice.
 *
 * The reducer:
 *   - DELETE: filter by old.id.
 *   - INSERT / UPDATE where row IS in slice: upsert mapped row by id.
 *   - INSERT / UPDATE where row WAS in slice but is no longer (date changed):
 *     remove the old id from the list.
 *   - INSERT / UPDATE outside the slice both before and after: no-op.
 * Returns null when the payload doesn't carry an `id` (caller falls back
 * to a refetch).
 */
export function makeUpsertByIdReducer<T extends { id: string }>(opts: {
  mapRow: (raw: Record<string, unknown>) => T;
  /** Defaults to "always in slice" — for subscriptions with no date filter. */
  isInSlice?: (raw: Record<string, unknown>) => boolean;
  /** Defaults to `isInSlice` applied to the OLD payload. */
  wasInSlice?: (raw: Record<string, unknown>) => boolean;
}): ApplyPayloadReducer<T> {
  const inSlice = opts.isInSlice ?? (() => true);
  const wasIn = opts.wasInSlice ?? inSlice;
  return (payload, currentRows) => {
    if (payload.eventType === 'DELETE') {
      const id = (payload.old as { id?: string } | null)?.id;
      if (!id) return null;
      return currentRows.filter(r => r.id !== id);
    }
    if (!payload.new || typeof (payload.new as { id?: unknown }).id !== 'string') {
      return null;
    }
    const newRaw = payload.new;
    const oldRaw = payload.old;
    const inSliceNow = inSlice(newRaw);
    const wasInSliceBefore = oldRaw ? wasIn(oldRaw) : false;
    const newId = (newRaw as { id: string }).id;
    if (!inSliceNow && wasInSliceBefore) {
      return currentRows.filter(r => r.id !== newId);
    }
    if (!inSliceNow) {
      // Row was never relevant; UI shouldn't change but we still bump
      // the seq via publish so the subscription stays consistent.
      return currentRows.slice();
    }
    const incoming = opts.mapRow(newRaw);
    const idx = currentRows.findIndex(r => r.id === incoming.id);
    if (idx === -1) return [...currentRows, incoming];
    const next = currentRows.slice();
    next[idx] = incoming;
    return next;
  };
}

export function subscribeTable<T>(
  channelName: string,
  table: string,
  filter: string | null,
  doFetch: () => Promise<T[]>,
  callback: (rows: T[]) => void,
  /**
   * Optional predicate run on every postgres_changes payload. Return false
   * to skip the re-fetch — used to scope subscriptions tighter than what
   * Realtime's single-column filter allows. The initial fetch is always
   * performed regardless of the predicate (caller wants the snapshot).
   */
  shouldRefetch?: (payload: PostgresChangesPayload) => boolean,
  /**
   * Optional reducer that applies a payload directly to the local row list,
   * skipping the refetch. When provided, the refetch becomes a safety net
   * (initial load, visibility recovery, reducer-returns-null fallback).
   */
  applyPayload?: ApplyPayloadReducer<T>,
): () => void {
  let active = true;
  // 2026-05-12 (Codex audit): every realtime event fires its own doFetch
  // with no sequencing. If fetch A starts, fetch B starts before A
  // resolves, and A resolves AFTER B, we publish A's older snapshot on
  // top of B's newer one — UIs briefly revert to stale state on rapid
  // changes. Monotonic request ID guards against out-of-order publishes:
  // any fetch whose ID is less than the latest published ID is silently
  // discarded. Reducer publishes also bump the seq so a slow doFetch in
  // flight can't roll back a fresh reducer publish.
  let requestSeq = 0;
  let lastPublishedSeq = -1;
  let currentRows: readonly T[] = [];

  const publish = (rows: T[]) => {
    currentRows = rows;
    callback(rows);
  };

  const fire = () => {
    if (!active) return;
    const myReq = ++requestSeq;
    doFetch()
      .then(rows => {
        if (!active) return;
        if (myReq <= lastPublishedSeq) return;  // a newer fetch already published
        lastPublishedSeq = myReq;
        publish(rows);
      })
      .catch(err => logErr(`Listener error in ${channelName}`, err));
  };

  // ── Burst-debounce for postgres_changes events ─────────────────────────
  // Audit follow-up 2026-05-17 (P2.2 — realtime re-fetch hot path):
  // every change event used to fire its own doFetch. A housekeeper tapping
  // Done on five rooms in five seconds produced five full re-fetches per
  // open manager tab — wasteful when the second through fifth fetches
  // observe the same final state as the first. Coalesce a burst of events
  // into a single fetch by deferring fire() by REFETCH_DEBOUNCE_MS;
  // each new event resets the timer. The monotonic requestSeq guard
  // above still protects the rare case where a deferred fetch and a
  // visibility-driven fetch interleave.
  //
  // 80ms is below the perceptual threshold for "instant UI update" and
  // wide enough to absorb the typical 10-50ms gap between coupled
  // INSERTs in a transaction (e.g. one tap → rooms UPDATE + cleaning_events
  // INSERT both broadcast within a few ms of each other).
  const REFETCH_DEBOUNCE_MS = 80;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const fireDebounced = () => {
    if (!active) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      fire();
    }, REFETCH_DEBOUNCE_MS);
  };

  // Channel listener: optionally gate on shouldRefetch, then prefer the
  // reducer path (apply payload locally → publish, no refetch). When no
  // reducer is provided OR the reducer returns null (payload too sparse to
  // apply safely), fall back to the burst-debounced refetch. Reducer is
  // the better path because it eliminates the refetch entirely; debounce
  // is the safety net that still coalesces bursts when refetch is needed.
  const onChange = (payload: PostgresChangesPayload) => {
    if (!active) return;
    if (shouldRefetch && !shouldRefetch(payload)) return;
    if (applyPayload) {
      const next = applyPayload(payload, currentRows);
      if (next !== null) {
        // Bump the seq so any in-flight doFetch with a lower id will be
        // dropped when it lands — otherwise a slow fetch could clobber
        // the reducer's fresh state. Also cancel any pending debounced
        // refetch since the reducer already produced the fresh state.
        lastPublishedSeq = ++requestSeq;
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        publish(next);
        return;
      }
    }
    fireDebounced();
  };

  fire();

  const filterSpec = filter
    ? { event: '*', schema: 'public', table, filter }
    : { event: '*', schema: 'public', table };

  // `let`, not `const`: visibility recovery may swap the channel out for a
  // fresh one if iOS Safari (or any other mobile browser) silently kills
  // the WebSocket while the tab is backgrounded.
  let channel = supabase
    .channel(channelName)
    .on('postgres_changes' as never, filterSpec, onChange as never)
    .subscribe();

  // ── Mobile Safari / phone-wake recovery ────────────────────────────────
  // Realtime over WebSockets dies silently when iOS Safari throttles a
  // backgrounded tab. The channel object stays in memory but no events
  // fire after the tab returns to the foreground. Without recovery, every
  // page in this app looks frozen until the user hard-refreshes — and
  // housekeepers, who use this on shared phones in the back office, never
  // hard-refresh anything.
  //
  // On every visibility change back to "visible":
  //   1. Always refetch — guarantees the UI is correct even if no realtime
  //      events arrive while we're re-establishing the WebSocket.
  //   2. If the channel state is 'closed' or 'errored', tear it down and
  //      create a fresh subscription with the same name + filter so future
  //      mutations resume propagating.
  const onVisibility = () => {
    if (!active) return;
    if (typeof document === 'undefined' || document.hidden) return;
    fire();
    // .state isn't in the public type but is exposed at runtime.
    type WithState = { state?: string };
    const state = (channel as unknown as WithState).state;
    if (state === 'closed' || state === 'errored') {
      try { void supabase.removeChannel(channel); } catch { /* best effort */ }
      channel = supabase
        .channel(channelName)
        .on('postgres_changes' as never, filterSpec, onChange as never)
        .subscribe();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    active = false;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    void supabase.removeChannel(channel);
  };
}
