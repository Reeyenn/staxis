/**
 * Schedule-reactivity event ping.
 *
 * Goal: when the CUA worker writes a PMS change that could shift the
 * day's expected demand (arrival surge, cancellation wave, VIP added,
 * OOO flip), the manager's schedule alerts UI gets a fresh gap check
 * within ~30s instead of waiting for tomorrow's nightly schedule-auto-
 * fill cron.
 *
 * Mirrors the design of rules-engine-pinger.ts in this directory:
 *   - One singleton per worker process
 *   - 10s debounce window per property — bursts collapse to a single ping
 *   - Fail-quiet on every step; the alerts surface still benefits from
 *     the planned manual-recompute fallback
 *   - DISABLED when SCHEDULE_REACTIVITY_BASE_URL / CRON_SECRET unset (so
 *     local dev / tests don't fire cross-network)
 *
 * Distinct trigger semantics vs. rules-engine-pinger:
 *   - rules-engine-pinger fires on per-room state changes (vacant_dirty,
 *     out_of_order, inspected) because those drive cleaning_tasks.
 *   - schedule-reactivity-pinger fires on aggregate demand-shaping
 *     changes (reservation cancel/no_show, new arrival, in_house
 *     snapshot count delta past a threshold) because those shift the
 *     headcount need.
 */

import { env } from './env.js';
import { log } from './log.js';

export type TriggerKind =
  | 'arrival_surge'
  | 'cancellation_wave'
  | 'vip_added'
  | 'status_flip';

/** Predicate per watched table. Returns null when the row should NOT fire
 *  a ping; otherwise returns the trigger kind for the ping body. */
const TRIGGER_PREDICATES: Record<
  string,
  (row: Record<string, unknown>) => TriggerKind | null
> = {
  // Reservation cancellations / no-shows are the biggest demand drop
  // signal — they retract today's expected cleaning load. New check-ins
  // (and same-day arrivals) are the inverse — they bump arrivals_remaining.
  pms_reservations: (row) => {
    const status = row.status;
    if (status === 'cancelled' || status === 'no_show') return 'cancellation_wave';
    if (status === 'checked_in') return 'arrival_surge';
    if (rowMentionsVip(row)) return 'vip_added';
    return null;
  },

  // Room status flips that change the headcount target.
  pms_room_status_log: (row) => {
    const s = row.status;
    if (s === 'out_of_order' || s === 'vacant_dirty') return 'status_flip';
    return null;
  },

  // The in_house snapshot is upserted every poll. We only ping when the
  // arrivals_remaining_today or departures_remaining_today numbers move
  // by ≥ the property's gap_alert_threshold_minutes equivalent. The
  // hasMaterialChange logic below handles that.
  pms_in_house_snapshot: () => 'status_flip',
};

const VIP_TEXT_RE = /\bvip\b|platinum|diamond|titanium|ambassador/i;

function rowMentionsVip(row: Record<string, unknown>): boolean {
  for (const field of ['notes', 'special_requests', 'rate_code', 'package_name'] as const) {
    const value = row[field];
    if (typeof value === 'string' && VIP_TEXT_RE.test(value)) return true;
  }
  return false;
}

export interface SchedulePingerOptions {
  baseUrl?: string | null;
  cronSecret?: string | null;
  debounceMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void;
}

interface PendingState {
  timer: ReturnType<typeof setTimeout>;
  /** Trigger kind reported on the ping body. When multiple high-priority
   *  events collapse into one window, we keep the FIRST trigger seen —
   *  the recompute pass is identical regardless of kind, but the audit
   *  trail shows what kicked off the chain. */
  trigger: TriggerKind;
}

export class ScheduleReactivityPinger {
  private readonly baseUrl: string | null;
  private readonly cronSecret: string | null;
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly setTimeoutImpl: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (id: ReturnType<typeof setTimeout>) => void;

  private readonly pendingByProperty = new Map<string, PendingState>();

  /** Per-property last-seen counts for in_house snapshot. Without this an
   *  unchanged snapshot upserted every ~30s fires a fresh window every
   *  cycle — same shape as rules-engine-pinger.lastSnapshotSignature. */
  private readonly lastSnapshotCounts = new Map<string, string>();

  /** Per-property pms_reservation_id → status. Diff signal: only fire when
   *  some row's status has materially changed since the last batch. */
  private readonly lastReservationStatus = new Map<string, Map<string, string>>();

  private firedCount = 0;

  constructor(opts: SchedulePingerOptions = {}) {
    this.baseUrl =
      opts.baseUrl ??
      env.SCHEDULE_REACTIVITY_BASE_URL ??
      env.RULES_ENGINE_BASE_URL ??
      null;
    this.cronSecret = opts.cronSecret ?? env.CRON_SECRET ?? null;
    this.debounceMs = opts.debounceMs ?? env.SCHEDULE_REACTIVITY_PING_DEBOUNCE_MS;
    this.timeoutMs = opts.timeoutMs ?? env.SCHEDULE_REACTIVITY_PING_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;

    if (!this.baseUrl) {
      log.warn(
        'schedule-reactivity-pinger: DISABLED (SCHEDULE_REACTIVITY_BASE_URL / RULES_ENGINE_BASE_URL unset) — only the nightly schedule-auto-fill cron will refresh gaps',
      );
    } else if (!this.cronSecret) {
      log.warn(
        'schedule-reactivity-pinger: DISABLED (CRON_SECRET unset) — only the nightly schedule-auto-fill cron will refresh gaps',
      );
    } else {
      log.info('schedule-reactivity-pinger: ENABLED', {
        baseUrl: this.baseUrl,
        debounceMs: this.debounceMs,
        timeoutMs: this.timeoutMs,
      });
    }
  }

  private get isEnabled(): boolean {
    return Boolean(this.baseUrl && this.cronSecret);
  }

  notifyHighPriorityChange(
    propertyId: string,
    tableName: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): void {
    try {
      if (!this.isEnabled) return;
      if (!propertyId) return;
      const predicate = TRIGGER_PREDICATES[tableName];
      if (!predicate) return;

      if (!this.hasMaterialChange(propertyId, tableName, rows)) return;

      let trigger: TriggerKind | null = null;
      for (const row of rows) {
        try {
          const t = predicate(row);
          if (t !== null) {
            trigger = t;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!trigger) return;

      if (this.pendingByProperty.has(propertyId)) return;

      const timer = this.setTimeoutImpl(() => {
        const state = this.pendingByProperty.get(propertyId);
        this.pendingByProperty.delete(propertyId);
        const t = state?.trigger ?? 'status_flip';
        this.firePing(propertyId, t).catch((err) => {
          log.warn('schedule-reactivity-pinger: firePing rejected (fail-quiet)', {
            propertyId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.debounceMs);

      this.pendingByProperty.set(propertyId, { timer, trigger });
    } catch (err) {
      log.warn('schedule-reactivity-pinger: notify threw (swallowed)', {
        propertyId,
        tableName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async firePing(propertyId: string, trigger: TriggerKind): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.baseUrl || !this.cronSecret) return;
      const url = `${this.baseUrl.replace(/\/+$/, '')}/api/internal/pms-changed?propertyId=${encodeURIComponent(propertyId)}`;
      const ctrl = new AbortController();
      timeoutHandle = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cronSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ kind: trigger }),
        signal: ctrl.signal,
      });
      this.firedCount++;
      if (!res.ok) {
        log.warn('schedule-reactivity-pinger: non-2xx (fail-quiet)', {
          propertyId, status: res.status, trigger,
        });
        return;
      }
      log.info('schedule-reactivity-pinger: pinged', {
        propertyId, trigger, status: res.status,
      });
    } catch (err) {
      log.warn('schedule-reactivity-pinger: fetch failed (fail-quiet)', {
        propertyId, trigger,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private hasMaterialChange(
    propertyId: string,
    tableName: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): boolean {
    if (tableName === 'pms_in_house_snapshot') {
      const firstRow = rows[0];
      if (!firstRow) return false;
      const sig = JSON.stringify({
        a: firstRow.arrivals_remaining_today ?? null,
        d: firstRow.departures_remaining_today ?? null,
        i: firstRow.checked_in_today_count ?? null,
        o: firstRow.checked_out_today_count ?? null,
        c: firstRow.cancellations_today ?? null,
        n: firstRow.no_shows_today ?? null,
      });
      const last = this.lastSnapshotCounts.get(propertyId);
      this.lastSnapshotCounts.set(propertyId, sig);
      return last !== sig;
    }

    if (tableName === 'pms_reservations') {
      const newMap = new Map<string, string>();
      let changed = false;
      const prevMap = this.lastReservationStatus.get(propertyId);
      for (const row of rows) {
        const id = row.pms_reservation_id;
        if (typeof id !== 'string' || id.length === 0) {
          // Can't dedup unkeyed rows — over-fire safely.
          return true;
        }
        const status = typeof row.status === 'string' ? row.status : '';
        newMap.set(id, status);
        if (prevMap?.get(id) !== status) changed = true;
      }
      if (prevMap) {
        for (const prevId of prevMap.keys()) {
          if (!newMap.has(prevId)) { changed = true; break; }
        }
      }
      this.lastReservationStatus.set(propertyId, newMap);
      return changed;
    }

    // pms_room_status_log is append-only — every write is a change.
    return true;
  }

  // ─── Test inspection / control ─────────────────────────────────────

  pendingCount(): number {
    return this.pendingByProperty.size;
  }

  isPending(propertyId: string): boolean {
    return this.pendingByProperty.has(propertyId);
  }

  firedSinceBoot(): number {
    return this.firedCount;
  }

  resetForTests(): void {
    for (const state of this.pendingByProperty.values()) {
      this.clearTimeoutImpl(state.timer);
    }
    this.pendingByProperty.clear();
    this.lastSnapshotCounts.clear();
    this.lastReservationStatus.clear();
    this.firedCount = 0;
  }
}

let _singleton: ScheduleReactivityPinger | null = null;

export function getSchedulePingerSingleton(): ScheduleReactivityPinger {
  if (!_singleton) _singleton = new ScheduleReactivityPinger();
  return _singleton;
}

export function setSchedulePingerSingletonForTests(
  p: ScheduleReactivityPinger | null,
): void {
  _singleton = p;
}

export function notifyScheduleHighPriorityChange(
  propertyId: string,
  tableName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  try {
    getSchedulePingerSingleton().notifyHighPriorityChange(propertyId, tableName, rows);
  } catch (err) {
    log.warn('schedule-reactivity-pinger: top-level threw (swallowed)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
