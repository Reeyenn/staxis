// ═══════════════════════════════════════════════════════════════════════════
// pms/feed-health — the app's reader for pms_feed_health_v1 (migration 0339).
//
// THE SINGLE DEFINITION OF "IS THIS FEED FRESH" LIVES IN SQL, NOT HERE.
// This module deliberately contains NO copy of the state machine — it reads
// `state` and `minutes_late` off the view and never recomputes them. Two
// implementations of a freshness rule is exactly the drift this workstream
// exists to prevent, and a second copy in TypeScript would be the one that
// silently disagrees. What lives here instead:
//
//   • the row shape + a tolerant parser (PostgREST gives us `unknown`);
//   • the ALERT POLICY over those rows (what is a warn, what is a fail) —
//     genuinely app-side, because "who gets woken up" is not a data fact;
//   • the translation from health rows to the PropertyFeedStatus every
//     surface already consumes.
//
// PURE (no I/O) so it is unit-testable; the supabaseAdmin queries live in
// src/lib/pms-feed-status-server.ts and the doctor route.
//
// ── THE MANUAL-HOTEL FAIL-SAFE (do not remove) ────────────────────────────
// A hotel with NO expectation rows produces NO rows in the view, and
// `feedStatusFromHealth` returns null for that case. The caller MUST then
// fall back to the existing session-based derivation, which yields
// NO_PMS_FEED_STATUS for a manual / skip-PMS hotel: mode 'no_pms', every feed
// 'live', countsTrusted true, surfaces render exactly as they do today.
//
// Treating "no expectation row" as "unavailable" instead would flip every
// manual hotel to all-unavailable and neutralise its dashboard and
// housekeeper board — hotels that were never supposed to have PMS data at
// all. 'unavailable' is reserved for an expectation row that EXISTS and is
// disabled: someone deliberately said "this hotel does not send this report".
// ═══════════════════════════════════════════════════════════════════════════

import {
  FEED_TARGETS,
  NO_PMS_FEED_STATUS,
  type FeedKey,
  type FeedState,
  type PropertyFeedStatus,
} from '@/lib/pms/feed-status';

/** Mirror of the `state` column of pms_feed_health_v1. */
export type FeedHealthState = 'live' | 'stale' | 'learning' | 'unavailable';

export type FeedCadenceKind = 'interval' | 'daily_at';
export type FeedAlertChannel = 'none' | 'doctor_warn' | 'doctor_fail';

/** One row of pms_feed_health_v1. */
export interface FeedHealthRow {
  propertyId: string;
  feedKey: string;
  label: string;
  required: boolean;
  targetTable: string | null;
  legacyTarget: string | null;
  reportType: string | null;
  enabled: boolean;
  cadenceKind: FeedCadenceKind | null;
  expectedEveryMinutes: number | null;
  expectedAtLocal: string | null;
  timezone: string | null;
  graceMinutes: number;
  alertChannel: FeedAlertChannel;
  /** Newest row stamp on the feed's target table. */
  lastReportAt: string | null;
  /** Newest successfully-parsed delivery. PRIMARY freshness signal: a report
   *  that legitimately contains zero rows (a hotel with no open work orders)
   *  moves this and not lastReportAt. */
  lastDeliveryAt: string | null;
  /** greatest(lastDeliveryAt, lastReportAt) — what freshness is judged on. */
  lastSignalAt: string | null;
  minutesLate: number | null;
  openQuarantineCount: number;
  openUnmappedCount: number;
  state: FeedHealthState;
}

const CADENCE_KINDS = new Set<string>(['interval', 'daily_at']);
const ALERT_CHANNELS = new Set<string>(['none', 'doctor_warn', 'doctor_fail']);
const HEALTH_STATES = new Set<string>(['live', 'stale', 'learning', 'unavailable']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // numeric columns come back as strings over PostgREST.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Tolerant row parser. Returns null for a row that cannot be trusted (no
 * property, no feed key, or a `state` outside the known vocabulary) rather
 * than coercing it into a confident-looking default — an unrecognised state
 * must never be silently rendered as 'live'.
 */
export function parseFeedHealthRow(raw: unknown): FeedHealthRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const propertyId = str(r.property_id);
  const feedKey = str(r.feed_key);
  const state = str(r.state);
  if (!propertyId || !feedKey || !state || !HEALTH_STATES.has(state)) return null;
  const cadence = str(r.cadence_kind);
  const channel = str(r.alert_channel);
  return {
    propertyId,
    feedKey,
    label: str(r.label) ?? feedKey,
    required: r.required === true,
    targetTable: str(r.target_table),
    legacyTarget: str(r.legacy_target),
    reportType: str(r.report_type),
    enabled: r.enabled === true,
    cadenceKind: cadence && CADENCE_KINDS.has(cadence) ? (cadence as FeedCadenceKind) : null,
    expectedEveryMinutes: num(r.expected_every_minutes),
    expectedAtLocal: str(r.expected_at_local),
    timezone: str(r.timezone),
    graceMinutes: num(r.grace_minutes) ?? 0,
    alertChannel: channel && ALERT_CHANNELS.has(channel) ? (channel as FeedAlertChannel) : 'doctor_warn',
    lastReportAt: str(r.last_report_at),
    lastDeliveryAt: str(r.last_delivery_at),
    lastSignalAt: str(r.last_signal_at),
    minutesLate: num(r.minutes_late),
    openQuarantineCount: num(r.open_quarantine_count) ?? 0,
    openUnmappedCount: num(r.open_unmapped_count) ?? 0,
    state: state as FeedHealthState,
  };
}

export function parseFeedHealthRows(raw: unknown): FeedHealthRow[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedHealthRow[] = [];
  for (const row of raw) {
    const parsed = parseFeedHealthRow(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ─── Alert policy ──────────────────────────────────────────────────────────
// Which breaches wake somebody up. This is a POLICY, not a data fact, so it
// lives in code — but every input it reads (grace, required, alert_channel)
// is a row, so a hotel on a different schedule needs no code change.

export type SloSeverity = 'ok' | 'warn' | 'fail';

export interface FeedSloBreach {
  propertyId: string;
  feedKey: string;
  label: string;
  required: boolean;
  minutesLate: number;
  graceMinutes: number;
  alertChannel: FeedAlertChannel;
  severity: 'warn' | 'fail';
}

export interface FeedSloVerdict {
  status: SloSeverity;
  breaches: FeedSloBreach[];
  /** One human sentence for the doctor's `detail`. */
  detail: string;
  /** Hotels with an expectation row, i.e. hotels this check can speak for. */
  propertiesEvaluated: number;
}

/**
 * A feed is LATE when it is past its grace. It only ESCALATES to a
 * deploy-blocking fail when all three hold: the feed is `required`, its
 * expectation opted into `doctor_fail`, and it is past TWICE its grace.
 *
 * Two multiples of grace, not one, because the first breach is usually a
 * five-minute email delay. Failing on that would amber the fleet daily and
 * train the founder to ignore the signal — the exact failure mode the
 * feed-status module header warns about.
 *
 * A 'learning' feed is NOT a breach: nothing has arrived yet (or the report
 * shape changed), which is the ingest/mapping problem, reported by its own
 * checks. A disabled feed is not a breach either — it was switched off on
 * purpose.
 */
export function evaluateFeedSlos(rows: FeedHealthRow[]): FeedSloVerdict {
  const properties = new Set(rows.map((r) => r.propertyId));
  const breaches: FeedSloBreach[] = [];

  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.alertChannel === 'none') continue;
    if (row.state !== 'stale') continue;
    const late = row.minutesLate;
    if (late === null || late <= row.graceMinutes) continue;

    const hardFail =
      row.required &&
      row.alertChannel === 'doctor_fail' &&
      late > row.graceMinutes * 2;

    breaches.push({
      propertyId: row.propertyId,
      feedKey: row.feedKey,
      label: row.label,
      required: row.required,
      minutesLate: Math.round(late),
      graceMinutes: row.graceMinutes,
      alertChannel: row.alertChannel,
      severity: hardFail ? 'fail' : 'warn',
    });
  }

  if (breaches.length === 0) {
    return {
      status: 'ok',
      breaches,
      detail:
        properties.size === 0
          ? 'no hotel has a PMS report expectation configured yet'
          : `every expected report is inside its grace window (${properties.size} hotel(s))`,
      propertiesEvaluated: properties.size,
    };
  }

  // Worst first, so the truncated detail line always shows the real problem.
  breaches.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
    return b.minutesLate - a.minutesLate;
  });
  const failing = breaches.filter((b) => b.severity === 'fail');
  const summary = breaches
    .slice(0, 5)
    .map((b) => `${b.propertyId} ${b.label} ${b.minutesLate} min late (grace ${b.graceMinutes})`)
    .join('; ');

  return {
    status: failing.length > 0 ? 'fail' : 'warn',
    breaches,
    detail: `${breaches.length} late report(s)${failing.length > 0 ? `, ${failing.length} past 2× grace on a required feed` : ''}: ${summary}`,
    propertiesEvaluated: properties.size,
  };
}

export interface QuarantineBacklogInput {
  /** Open quarantine rows per hotel. */
  perProperty: Array<{ propertyId: string; openRows: number }>;
  /**
   * Deliveries in the last hour where EVERY row was rejected. A parse that
   * rejects everything is a format change, not a data problem, and it is the
   * one ingest condition that must page. Supplied by the intake ledger; 0
   * until that lands (see pms_feed_delivery_signal_v1 in migration 0339).
   */
  allRejectedDeliveriesLastHour?: number;
  /** Open rows above which a hotel is flagged. Default 25. */
  warnThreshold?: number;
}

export interface BacklogVerdict {
  status: SloSeverity;
  detail: string;
}

/**
 * Quarantine backlog. WARN, not 'learning': five bad rows out of three
 * hundred does not make the other 295 untrustworthy, and 'learning' blanks
 * user-visible numbers. The queue is where a human fixes this.
 */
export function evaluateQuarantineBacklog(input: QuarantineBacklogInput): BacklogVerdict {
  const threshold = input.warnThreshold ?? 25;
  const allRejected = input.allRejectedDeliveriesLastHour ?? 0;
  const over = input.perProperty.filter((p) => p.openRows > threshold);

  if (allRejected > 0) {
    return {
      status: 'fail',
      detail: `${allRejected} report(s) in the last hour had EVERY row rejected — the report format almost certainly changed`,
    };
  }
  if (over.length > 0) {
    const summary = over
      .slice(0, 5)
      .map((p) => `${p.propertyId} (${p.openRows} rows)`)
      .join('; ');
    return {
      status: 'warn',
      detail: `${over.length} hotel(s) over the ${threshold}-row quarantine threshold: ${summary}`,
    };
  }
  const total = input.perProperty.reduce((sum, p) => sum + p.openRows, 0);
  return {
    status: 'ok',
    detail: total === 0 ? 'no rows in quarantine' : `${total} row(s) in quarantine, all hotels under the ${threshold}-row threshold`,
  };
}

export interface UnmappedColumnRow {
  propertyId: string;
  reportType: string;
  columnLabel: string;
}

/**
 * An unrecognised column is always worth a human look — it means a hotel's
 * report grew a field we are not reading. Warn (never fail): the value is
 * already captured in `raw->_unmapped`, so nothing is lost while it waits.
 */
export function evaluateUnmappedColumns(rows: UnmappedColumnRow[]): BacklogVerdict {
  if (rows.length === 0) return { status: 'ok', detail: 'no unrecognised report columns' };
  const summary = rows
    .slice(0, 5)
    .map((r) => `${r.propertyId} ${r.reportType}: "${r.columnLabel}"`)
    .join('; ');
  return {
    status: 'warn',
    detail: `${rows.length} unrecognised report column(s) awaiting mapping: ${summary}`,
  };
}

// ─── Health rows → PropertyFeedStatus ──────────────────────────────────────

/** Catalog feed_key → the semantic key every surface already uses. */
const HEALTH_KEY_TO_FEED_KEY: Readonly<Record<string, FeedKey>> = Object.freeze({
  roomStatus: 'roomStatus',
  arrivals: 'arrivals',
  departures: 'departures',
  workOrders: 'workOrders',
  dashboardCounts: 'dashboardCounts',
});

/** The catalog is the single source of "is this feed required" (migration
 *  0339). Exposed so the legacy REQUIRED_TARGETS list has somewhere to defer
 *  to instead of drifting. */
export function requiredFeedKeys(rows: FeedHealthRow[]): FeedKey[] {
  const out = new Set<FeedKey>();
  for (const row of rows) {
    const key = HEALTH_KEY_TO_FEED_KEY[row.feedKey];
    if (key && row.required && row.enabled) out.add(key);
  }
  return [...out];
}

/**
 * Translate the view's rows into the shape every surface already consumes.
 *
 * Returns NULL when there are no rows — see the manual-hotel fail-safe in the
 * module header. The caller must fall back, NOT substitute a default.
 *
 * A feed with no expectation row for a hotel that HAS expectations reads
 * 'unavailable': we are honestly not expecting that report from this hotel.
 *
 * ⚠ ROLLOUT NOTE for whoever builds the report-setup flow: because the FIRST
 * expectation row is what switches a hotel from the legacy derivation to this
 * one, expectations must be created as a SET, in one transaction. Inserting a
 * single row "to try it out" on a live hotel flips the other four feeds to
 * 'unavailable' and blanks its dashboard counts until the rest are added. That
 * is the honest reading of the data — we genuinely are not expecting those
 * reports — but it is an abrupt, visible change and it should not be a
 * side-effect of a half-finished setup screen.
 */
export function feedStatusFromHealth(rows: FeedHealthRow[]): PropertyFeedStatus | null {
  if (rows.length === 0) return null;

  const feeds: Record<FeedKey, FeedState> = {
    roomStatus: 'unavailable',
    arrivals: 'unavailable',
    departures: 'unavailable',
    workOrders: 'unavailable',
    dashboardCounts: 'unavailable',
  };

  let sawKnownFeed = false;
  for (const row of rows) {
    const key = HEALTH_KEY_TO_FEED_KEY[row.feedKey];
    if (!key) continue; // a catalog feed no surface renders (e.g. housekeeping)
    sawKnownFeed = true;
    feeds[key] = row.state;
  }

  // The hotel has expectations, but none for a feed any surface renders.
  // Falling back is more honest than painting every tile 'unavailable'.
  if (!sawKnownFeed) return null;

  const enabled = rows.filter((r) => r.enabled);
  // Replaces the old property_sessions-derived 'pending': a hotel whose every
  // expected report has NEVER arrived has empty pms_* tables, so any zero
  // derived from them is fake. Consumed by isDataPending().
  const neverReceived = enabled.length > 0 && enabled.every((r) => r.lastSignalAt === null);

  const requiredKeys = new Set(requiredFeedKeys(rows));
  const isPartial = [...requiredKeys].some((k) => feeds[k] === 'learning');

  const newestSignal = rows
    .map((r) => r.lastSignalAt)
    .filter((v): v is string => typeof v === 'string')
    .sort()
    .at(-1) ?? null;

  return {
    mode: 'live',
    connection: neverReceived ? 'pending' : 'healthy',
    feeds,
    isPartial,
    // A2's seam (src/lib/pms/feed-status.ts FreshnessSource): 'heartbeat' is
    // the ingestion layer's own per-run signal — the only true "when did we
    // last hear from this hotel" stamp. This is where it plugs in.
    freshness: newestSignal
      ? { capturedAt: newestSignal, source: 'heartbeat' }
      : { capturedAt: null, source: 'none' },
  };
}

/** The property-level "as of" the copilot and dashboard quote. */
export function newestSignalAt(rows: FeedHealthRow[]): string | null {
  return (
    rows
      .map((r) => r.lastSignalAt)
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .at(-1) ?? null
  );
}

/** Every catalog feed key a surface renders, in display order. */
export const RENDERED_FEED_KEYS: readonly FeedKey[] = Object.freeze(
  Object.keys(FEED_TARGETS) as FeedKey[],
);

/** Fail-safe for callers that want a value rather than a null. Exported so
 *  the intent ("this is the manual-hotel render-as-today value") is explicit
 *  at the call site instead of an inline import. */
export const FEED_STATUS_FALLBACK = NO_PMS_FEED_STATUS;
