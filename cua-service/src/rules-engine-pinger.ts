/**
 * Rules-engine event ping.
 *
 * Goal: when the CUA worker writes a high-priority PMS change (a guest
 * checks out, a new arrival lands, a room goes OOO, etc.), housekeeping
 * gets the resulting cleaning task within ~10s instead of waiting up to
 * 5 minutes for the next /api/cron/run-rules-engine tick.
 *
 * Design (per-property debouncer):
 *   - First high-priority event for a property arms a 10s timer.
 *   - Additional events within the window are absorbed (no extra timer,
 *     no extra fetch) — the engine endpoint is idempotent, but firing
 *     N times for the same window costs us nothing useful.
 *   - When the timer fires, a single POST goes to
 *     /api/cron/run-rules-engine?propertyId=<uuid>.
 *   - The slot clears BEFORE the network call so events arriving while
 *     the fetch is in flight start a fresh window — they don't get
 *     swallowed by an in-flight ping for an older state.
 *
 * Fail-quiet:
 *   - Any error in the predicate, scheduler, or fetch is caught, logged
 *     at warn level, and swallowed. The 5-minute cron is the safety net.
 *   - The pinger MUST NOT cause a PMS write to fail.
 *
 * Idempotency:
 *   - The engine endpoint upserts on (property_id, dedupe_key). Multiple
 *     pings for the same window produce one row each, identical content.
 *     No duplicates ever land in cleaning_tasks.
 *
 * Disabled when RULES_ENGINE_BASE_URL or CRON_SECRET is unset (local
 * dev, tests, fresh fly machine pre-secret-set). The 5-min cron still
 * works either way.
 */

import { env } from './env.js';
import { log } from './log.js';

/** Predicate per watched table. Tables not in this map never produce a
 *  ping. Each predicate receives one row dict (post-validation) and
 *  returns true iff THAT row is a high-priority signal.
 *
 *  Why explicit instead of "any write to a watched table fires":
 *  pms_reservations gets re-upserted on every poll (~30s) with the
 *  same dates. Without the predicate filter, every poll fires. With
 *  it, only status transitions and same-day arrivals fire. */
const HIGH_PRIORITY_PREDICATES: Record<
  string,
  (row: Record<string, unknown>) => boolean
> = {
  // Status transitions are always interesting — the CUA pull only writes
  // on a real state change (delta extractor), so any insert here is a
  // material event. We narrow further to the specific transitions that
  // change what housekeeping should be doing right now.
  pms_room_status_log: (row) => {
    const s = row.status;
    return s === 'vacant_dirty' || s === 'out_of_order' || s === 'inspected';
  },

  // Reservations get re-upserted by every CUA poll (the writer can't
  // distinguish new from unchanged rows). Filter to material signals:
  // status transitions and any same-day arrival/departure context. The
  // VIP keyword check catches "VIP just got assigned to a room" via
  // the same notes/special_requests fields the engine reads.
  pms_reservations: (row) => {
    const status = row.status;
    if (status === 'checked_in' || status === 'checked_out') return true;
    if (status === 'cancelled' || status === 'no_show') return true; // tasks must be retracted
    if (rowMentionsVip(row)) return true;
    return false;
  },

  // In-house snapshot is upserted every poll. We fire on every write —
  // the debouncer collapses bursts and the engine endpoint is idempotent.
  // Worst case: one ping every poll cycle (~30s), which IS the cron
  // cadence we want anyway when arrivals/departures are active.
  pms_in_house_snapshot: () => true,
};

const VIP_TEXT_RE = /\bvip\b|platinum|diamond|titanium|ambassador/i;

function rowMentionsVip(row: Record<string, unknown>): boolean {
  for (const field of ['notes', 'special_requests', 'rate_code', 'package_name'] as const) {
    const value = row[field];
    if (typeof value === 'string' && VIP_TEXT_RE.test(value)) return true;
  }
  return false;
}

export interface PingerOptions {
  baseUrl?: string | null;
  cronSecret?: string | null;
  debounceMs?: number;
  timeoutMs?: number;
  /** Dependency-injected for tests. Production uses globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Dependency-injected for tests. Production uses globalThis.setTimeout. */
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Dependency-injected for tests. Production uses globalThis.clearTimeout. */
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void;
}

export class RulesEnginePinger {
  private readonly baseUrl: string | null;
  private readonly cronSecret: string | null;
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly setTimeoutImpl: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (id: ReturnType<typeof setTimeout>) => void;

  /** Per-property pending timers. Presence in this map = "ping scheduled
   *  for this property, no need to schedule another." Cleared BEFORE the
   *  network call so events arriving during the fetch start a fresh window. */
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Per-property last-seen signature for `pms_in_house_snapshot`. Without
   *  this, an unchanged snapshot upserted every ~30s poll arms a fresh
   *  debounce window every cycle. (Codex follow-up Major #2.) */
  private readonly lastSnapshotSignature = new Map<string, string>();

  /** Per-property map of pms_reservation_id → "status|vipFlag" signature.
   *  Without this, the upserter reports every poll's rows as `inserted`, so an
   *  unchanged reservation in any high-priority state fires every cycle. We only
   *  fire when ≥1 reservation_id's signature differs from what we last saw. The
   *  signature folds in a VIP-mention flag so a VIP note added to an existing
   *  reservation (no status change) still fires. (Codex follow-up Major #1.) */
  private readonly lastReservationStatus = new Map<string, Map<string, string>>();

  /** Counter exposed for tests — how many fetches have actually fired. */
  private firedCount = 0;

  constructor(opts: PingerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? env.RULES_ENGINE_BASE_URL ?? null;
    this.cronSecret = opts.cronSecret ?? env.CRON_SECRET ?? null;
    this.debounceMs = opts.debounceMs ?? env.RULES_ENGINE_PING_DEBOUNCE_MS;
    this.timeoutMs = opts.timeoutMs ?? env.RULES_ENGINE_PING_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;

    // Startup signal — names the pinger state so operators tailing Fly
    // logs catch partial env config (e.g. CRON_SECRET set on Vercel but
    // missing on Fly) on the FIRST line of the worker, not 5 minutes
    // later when nothing got faster. (Codex follow-up Major #4.)
    if (!this.baseUrl) {
      log.warn('rules-engine-pinger: DISABLED (RULES_ENGINE_BASE_URL unset) — only the 5-min cron will run the engine');
    } else if (!this.cronSecret) {
      log.warn('rules-engine-pinger: DISABLED (CRON_SECRET unset) — only the 5-min cron will run the engine');
    } else {
      log.info('rules-engine-pinger: ENABLED', {
        baseUrl: this.baseUrl,
        debounceMs: this.debounceMs,
        timeoutMs: this.timeoutMs,
      });
    }
  }

  /** Whether the pinger has the env config it needs to actually fire.
   *  Useful as a fast no-op check before computing predicates. */
  private get isEnabled(): boolean {
    return Boolean(this.baseUrl && this.cronSecret);
  }

  /**
   * Inspect rows for high-priority triggers; schedule a debounced ping
   * if any match. Fire-and-forget — never throws.
   */
  notifyHighPriorityChange(
    propertyId: string,
    tableName: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): void {
    try {
      if (!this.isEnabled) return;
      if (!propertyId) return;
      const predicate = HIGH_PRIORITY_PREDICATES[tableName];
      if (!predicate) return;

      // Diff-signal check (Codex follow-up Major #1 + #2). Without this,
      // the CUA polling cadence (~30s) re-upserts the same reservation
      // and snapshot rows, the generic-table-writer reports them as
      // inserts, and every poll fires a ping — drowning the engine in
      // no-op work. Compare incoming state to what we last saw for this
      // property; if nothing material changed, return early.
      if (!this.hasMaterialChange(propertyId, tableName, rows)) return;

      // Any matching row in the batch is enough — we only need a single
      // signal to fire one ping for the property.
      let hit = false;
      for (const row of rows) {
        try {
          if (predicate(row)) { hit = true; break; }
        } catch {
          // A malformed row in the batch shouldn't kill the whole notify.
          continue;
        }
      }
      if (!hit) return;

      if (this.pendingTimers.has(propertyId)) {
        // Already armed; coalesce. Don't reset the timer — that would let
        // a busy property defer pings indefinitely under sustained load.
        return;
      }

      const timer = this.setTimeoutImpl(() => {
        // Clear BEFORE firing so events during the fetch arm a fresh window.
        this.pendingTimers.delete(propertyId);
        // .catch() on the call site closes the unhandled-rejection
        // window for any sync throw inside firePing that escapes its
        // own try/catch. (Codex follow-up Major #3.)
        this.firePing(propertyId).catch((err) => {
          log.warn('rules-engine-pinger: firePing rejected (fail-quiet)', {
            propertyId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.debounceMs);

      this.pendingTimers.set(propertyId, timer);
    } catch (err) {
      log.warn('rules-engine-pinger: notify threw (swallowed)', {
        propertyId,
        tableName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Actually fire one POST. Fail-quiet — never throws.
   *
   *  ALL setup (URL construction, AbortController, setTimeout) is inside
   *  the try/catch so a sync throw from any of them is swallowed instead
   *  of escaping as an unhandled rejection in the long-running worker
   *  process. (Codex follow-up Major #3.) */
  private async firePing(propertyId: string): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Guard against being called when baseUrl/cronSecret were unset between
      // construction and now (env vars are immutable in practice, but the
      // null check makes TS happy and future-proofs).
      if (!this.baseUrl || !this.cronSecret) return;

      const url = `${this.baseUrl.replace(/\/+$/, '')}/api/cron/run-rules-engine?propertyId=${encodeURIComponent(propertyId)}`;
      const ctrl = new AbortController();
      timeoutHandle = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cronSecret}` },
        signal: ctrl.signal,
      });
      this.firedCount++;
      if (!res.ok) {
        log.warn('rules-engine-pinger: non-2xx response (fail-quiet)', {
          propertyId,
          status: res.status,
        });
        return;
      }
      log.info('rules-engine-pinger: pinged', { propertyId, status: res.status });
    } catch (err) {
      log.warn('rules-engine-pinger: fetch failed (fail-quiet)', {
        propertyId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /** Compare incoming rows to last-seen state for this (property, table).
   *  Returns false when nothing material changed (skip the ping). Returns
   *  true when at least one row's signature differs (proceed to predicate
   *  check). Per-table heuristics — only tables where the CUA writer
   *  re-upserts identical data every poll need this. */
  private hasMaterialChange(
    propertyId: string,
    tableName: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): boolean {
    if (tableName === 'pms_in_house_snapshot') {
      // 1-row upsert per poll. Hash the count fields the engine cares
      // about; if identical to last seen, skip.
      const firstRow = rows[0];
      if (!firstRow) return false;
      const sig = JSON.stringify({
        total_guests_in_house: firstRow.total_guests_in_house ?? null,
        total_occupied_rooms: firstRow.total_occupied_rooms ?? null,
        total_vacant_clean: firstRow.total_vacant_clean ?? null,
        total_vacant_dirty: firstRow.total_vacant_dirty ?? null,
        total_ooo: firstRow.total_ooo ?? null,
        arrivals_remaining_today: firstRow.arrivals_remaining_today ?? null,
        departures_remaining_today: firstRow.departures_remaining_today ?? null,
        checked_in_today_count: firstRow.checked_in_today_count ?? null,
        checked_out_today_count: firstRow.checked_out_today_count ?? null,
      });
      const last = this.lastSnapshotSignature.get(propertyId);
      this.lastSnapshotSignature.set(propertyId, sig);
      return last !== sig;
    }

    if (tableName === 'pms_reservations') {
      // Per-row diff against last-seen status. Build the new map first
      // so we can store it unconditionally — the engine reading stale
      // last-state on the next call would over-fire, but never under-fire.
      //
      // Bias toward over-firing on the unusual cases:
      //   - Any row missing pms_reservation_id → we can't dedup, return
      //     true so the predicate gets a chance to fire (e.g. ad-hoc
      //     test fixtures, future PMSes that don't always expose IDs).
      //   - Fewer rows in the new batch than the last batch → a
      //     reservation disappeared (cancellation, move, etc.) — material.
      const newMap = new Map<string, string>();
      let changed = false;
      const prevMap = this.lastReservationStatus.get(propertyId);
      for (const row of rows) {
        const id = row.pms_reservation_id;
        if (typeof id !== 'string' || id.length === 0) {
          // Unkeyed row — can't dedup, over-fire and skip caching.
          return true;
        }
        // Signature = status + a VIP-relevance marker. Status-only would let a
        // VIP note (notes / special_requests / rate_code / package_name) added
        // to an already-cached reservation slip past this gate with changed=false,
        // so the rowMentionsVip predicate never runs and the "VIP just got
        // assigned" fast ping (the feature's whole point) is silently lost. The
        // marker flips the signature the moment a reservation gains/loses a VIP
        // mention, arming the ping the same as a status transition would.
        const status = typeof row.status === 'string' ? row.status : '';
        const sig = `${status}|${rowMentionsVip(row) ? '1' : '0'}`;
        newMap.set(id, sig);
        if (prevMap?.get(id) !== sig) changed = true;
      }
      // Detect disappeared rows: any prevMap key missing from newMap.
      if (prevMap) {
        for (const prevId of prevMap.keys()) {
          if (!newMap.has(prevId)) { changed = true; break; }
        }
      }
      this.lastReservationStatus.set(propertyId, newMap);
      return changed;
    }

    // pms_room_status_log is append-only — every write IS a state change.
    // Other tables aren't in HIGH_PRIORITY_PREDICATES, so this branch is
    // effectively only reached for room_status_log. Allow all.
    return true;
  }

  // ─── Test-only inspection / control ────────────────────────────────

  /** How many pending property timers right now. */
  pendingCount(): number {
    return this.pendingTimers.size;
  }

  /** Whether a specific property is currently armed. */
  isPending(propertyId: string): boolean {
    return this.pendingTimers.has(propertyId);
  }

  /** Total pings fired since construction. */
  firedSinceBoot(): number {
    return this.firedCount;
  }

  /** Cancel all pending timers + reset diff-signal state. Tests call
   *  between cases. */
  resetForTests(): void {
    for (const timer of this.pendingTimers.values()) {
      this.clearTimeoutImpl(timer);
    }
    this.pendingTimers.clear();
    this.lastSnapshotSignature.clear();
    this.lastReservationStatus.clear();
    this.firedCount = 0;
  }
}

// ─── Process-singleton wired with env defaults ────────────────────────────
//
// The generic-table-writer calls `notifyHighPriorityChange(...)`
// after every successful write. We don't want a fresh pinger per call —
// that would defeat the debouncer (each new instance has its own
// pendingTimers map). One singleton per worker process is right.

let _singleton: RulesEnginePinger | null = null;

/** Lazy singleton accessor. Tests can swap it via setPingerSingleton(). */
export function getPingerSingleton(): RulesEnginePinger {
  if (!_singleton) _singleton = new RulesEnginePinger();
  return _singleton;
}

/** Replace the singleton (tests only). */
export function setPingerSingletonForTests(p: RulesEnginePinger | null): void {
  _singleton = p;
}

/**
 * Public convenience wrapper used by generic-table-writer. Fire-and-
 * forget. Top-level try/catch belt-and-suspenders the per-method
 * try/catch inside notifyHighPriorityChange — we MUST NOT let a pinger
 * exception bubble into a CUA pull.
 */
export function notifyHighPriorityChange(
  propertyId: string,
  tableName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  try {
    getPingerSingleton().notifyHighPriorityChange(propertyId, tableName, rows);
  } catch (err) {
    log.warn('rules-engine-pinger: top-level threw (swallowed)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
