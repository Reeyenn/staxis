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
  // eslint-disable-next-line no-console
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
): () => void {
  let active = true;
  // 2026-05-12 (Codex audit): every realtime event fires its own doFetch
  // with no sequencing. If fetch A starts, fetch B starts before A
  // resolves, and A resolves AFTER B, we publish A's older snapshot on
  // top of B's newer one — UIs briefly revert to stale state on rapid
  // changes. Monotonic request ID guards against out-of-order publishes:
  // any fetch whose ID is less than the latest published ID is silently
  // discarded.
  let requestSeq = 0;
  let lastPublishedSeq = -1;

  const fire = () => {
    if (!active) return;
    const myReq = ++requestSeq;
    doFetch()
      .then(rows => {
        if (!active) return;
        if (myReq <= lastPublishedSeq) return;  // a newer fetch already published
        lastPublishedSeq = myReq;
        callback(rows);
      })
      .catch(err => logErr(`Listener error in ${channelName}`, err));
  };

  // Channel listener: optionally gate on shouldRefetch.
  const onChange = (payload: PostgresChangesPayload) => {
    if (!active) return;
    if (shouldRefetch && !shouldRefetch(payload)) return;
    fire();
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
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    void supabase.removeChannel(channel);
  };
}
