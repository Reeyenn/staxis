// ═══════════════════════════════════════════════════════════════════════════
// pms/cross-report-reconcile — an INDEPENDENT witness that a report we parsed
// is the report we think it is.
//
// TRANSPLANT of cua-service/src/cross-feed-reconcile.ts (295 lines, pure).
// The robot-era version proved a scraped feed against the hotel's own
// dashboard counters. The report era is the same shape with a different
// noun: the night-audit / dashboard report's house counters are a SECOND
// WITNESS for the row reports. If the arrivals report secretly became a
// "this week" superset, or the room-status report arrived truncated, the row
// count will not reconcile with the house counter. That mismatch is a
// wrong-row-set signal no single-report check can see.
//
// TWO RULES CARRIED OVER VERBATIM, because both are load-bearing:
//
//  1. ABSTAIN BY DEFAULT. A check reports `match` / `mismatch` only when it
//     has the data to do so SOUNDLY; otherwise `abstain`. The overall signal
//     is `fail` only on a genuine contradiction, never on missing data. A
//     hotel with no counts report yields `no_signal` and nothing downstream
//     is penalised.
//
//  2. PAGINATION SOUNDNESS. The lower-bound inequality "report rows ≥
//     counter" is only sound to FAIL on when the row count is the report's
//     TOTAL. A multi-page report (or a report whose first page is all we
//     parsed) gives a SUBSET, so rows < counter is not a contradiction — the
//     rest is on later pages. A partial report page is the exact analogue of
//     a paginated feed, so the completeness gate transplants unchanged.
//     Without it, every correct-but-paginated report would false-fail.
//
// PURE (no I/O) — the caller gathers the observations and passes them in.
// ═══════════════════════════════════════════════════════════════════════════

/** Report keys, matching pms_feed_catalog.feed_key (migration 0339). */
export type ReportKey = 'roomStatus' | 'arrivals' | 'departures' | 'workOrders' | 'dashboardCounts';

/** The report whose house counters witness the row reports. */
export const COUNTS_REPORT: ReportKey = 'dashboardCounts';

/** Canonical room-status values that mean "occupied". */
const OCCUPIED_STATUSES = new Set(['occupied', 'occupied_clean', 'occupied_dirty']);

/**
 * One cross-report check: a house counter witnessing a row report.
 *
 *  - `predicate` present ⟹ when the caller supplies the FULL row set
 *    (rowsComplete), the count of rows matching the predicate must EQUAL the
 *    counter (within tolerance). The strong form.
 *  - `lowerBound` ⟹ otherwise fall back to the SOUND inequality "report total
 *    row count ≥ counter": the counter is a subset of (or bounded by) the
 *    report's rows, so the report can never legitimately have FEWER rows than
 *    the counter. This catches a wrong / empty / truncated report without ever
 *    false-failing a correct superset report.
 */
export interface CrossReportCheck {
  counter: string;
  report: ReportKey;
  predicate?: (row: Record<string, unknown>) => boolean;
  lowerBound: boolean;
}

/**
 * The check table. Each entry is SOUND: the relation holds for any correct
 * report regardless of PMS, so a violation is a real defect, never a quirk.
 *
 * "remaining_today" counters are a SUBSET of the full arrivals / departures
 * report (some guests already arrived or left), so only the lower-bound
 * relation is asserted for them — never equality.
 */
export const CROSS_REPORT_CHECKS: CrossReportCheck[] = [
  { counter: 'arrivals_remaining_today', report: 'arrivals', lowerBound: true },
  { counter: 'departures_remaining_today', report: 'departures', lowerBound: true },
  {
    counter: 'total_occupied_rooms',
    report: 'roomStatus',
    predicate: (r) => OCCUPIED_STATUSES.has(canonicalStatus(r)),
    lowerBound: true,
  },
  {
    counter: 'total_vacant_clean',
    report: 'roomStatus',
    predicate: (r) => canonicalStatus(r) === 'vacant_clean',
    lowerBound: true,
  },
];

function canonicalStatus(row: Record<string, unknown>): string {
  const v = row['status'];
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

/**
 * One row report's observation. `rowCount` is the report's total row count.
 * `rows` is whatever sample the caller has; `rowsComplete` is true ONLY when
 * the observation is the ENTIRE report — every row parsed AND `rowCount` the
 * report total (not one page). It gates BOTH the exact-predicate path AND the
 * lower-bound SHORTFALL fail.
 */
export interface ReportObservation {
  rowCount?: number;
  rows?: Array<Record<string, unknown>>;
  rowsComplete?: boolean;
}

export interface CrossReportInput {
  /** Per-report observations keyed by report key. A missing report ⟹ its
   *  checks abstain. */
  reports: Partial<Record<string, ReportObservation>>;
  /** House counters from the counts report: column name → parsed number.
   *  Unparseable / absent counters ⟹ their checks abstain. */
  counters: Record<string, number | null | undefined>;
  /** Absolute slack (default 2 — guests move between the two reports being
   *  generated). */
  absoluteTolerance?: number;
  /** Fractional tolerance on the counter (default 0.10). */
  fractionalTolerance?: number;
}

export type CheckVerdict = 'match' | 'mismatch' | 'abstain';

export interface CrossReportCheckResult {
  counter: string;
  report: ReportKey;
  verdict: CheckVerdict;
  mode: 'exact' | 'lower_bound' | '';
  counterValue?: number;
  observed?: number;
  reason: string;
}

export interface CrossReportResult {
  /** 'pass' = ≥1 check matched and none mismatched; 'fail' = ≥1 mismatched;
   *  'no_signal' = every check abstained. */
  signal: 'pass' | 'fail' | 'no_signal';
  matched: number;
  mismatched: number;
  abstained: number;
  checks: CrossReportCheckResult[];
}

function tolerance(counter: number, input: CrossReportInput): number {
  const abs = input.absoluteTolerance ?? 2;
  const frac = input.fractionalTolerance ?? 0.1;
  return Math.max(abs, Math.ceil(Math.abs(counter) * frac));
}

function safePredicate(
  fn: (row: Record<string, unknown>) => boolean,
  row: Record<string, unknown>,
): boolean {
  try {
    return fn(row);
  } catch {
    return false;
  }
}

/**
 * Reconcile the house counters against the row reports. Abstain-by-default:
 * any check lacking sound data reports `abstain` and does not affect the
 * signal.
 */
export function reconcileCrossReport(input: CrossReportInput): CrossReportResult {
  const checks: CrossReportCheckResult[] = [];

  for (const check of CROSS_REPORT_CHECKS) {
    const counterRaw = input.counters[check.counter];
    const obs = input.reports[check.report];

    const base: CrossReportCheckResult = {
      counter: check.counter,
      report: check.report,
      verdict: 'abstain',
      mode: '',
      reason: '',
    };

    if (counterRaw == null || !Number.isFinite(counterRaw)) {
      checks.push({ ...base, reason: 'counter_unavailable' });
      continue;
    }
    const counterValue = Math.trunc(counterRaw);
    if (counterValue < 0) {
      checks.push({ ...base, counterValue, reason: 'counter_negative' });
      continue;
    }
    if (!obs) {
      checks.push({ ...base, counterValue, reason: 'report_unavailable' });
      continue;
    }
    const tol = tolerance(counterValue, input);

    // Strong form: an exact predicate count over the COMPLETE row set.
    if (check.predicate && obs.rowsComplete && Array.isArray(obs.rows)) {
      const observed = obs.rows.filter((r) => safePredicate(check.predicate!, r)).length;
      const ok = Math.abs(observed - counterValue) <= tol;
      checks.push({
        counter: check.counter,
        report: check.report,
        verdict: ok ? 'match' : 'mismatch',
        mode: 'exact',
        counterValue,
        observed,
        reason: ok ? 'exact_within_tolerance' : `exact_off_by:${observed - counterValue}`,
      });
      continue;
    }

    // Sound fallback: total report rows must be ≥ the counter.
    if (check.lowerBound && typeof obs.rowCount === 'number' && Number.isFinite(obs.rowCount)) {
      if (counterValue === 0) {
        checks.push({ ...base, counterValue, observed: obs.rowCount, reason: 'counter_zero_uninformative' });
        continue;
      }
      const complete = obs.rowsComplete === true;
      // An EMPTY report that is KNOWN-COMPLETE can never witness a POSITIVE
      // counter — the exact wrong/empty-report signal, and the drift tolerance
      // must NOT swallow it (with abs tolerance 2, rowCount 0 would otherwise
      // "match" a counter of 1 or 2). Checked BEFORE the tolerance comparison.
      if (complete && obs.rowCount === 0) {
        checks.push({
          counter: check.counter,
          report: check.report,
          verdict: 'mismatch',
          mode: 'lower_bound',
          counterValue,
          observed: 0,
          reason: `lower_bound_violated:empty_report_vs_counter=${counterValue}`,
        });
        continue;
      }
      // A lower-bound SATISFACTION is sound regardless of completeness: a page
      // already meeting the counter witnesses it whether or not more follow.
      if (obs.rowCount >= counterValue - tol) {
        checks.push({
          counter: check.counter,
          report: check.report,
          verdict: 'match',
          mode: 'lower_bound',
          counterValue,
          observed: obs.rowCount,
          reason: 'lower_bound_satisfied',
        });
        continue;
      }
      // SHORTFALL. A real contradiction ONLY when the observation is the WHOLE
      // report — see PAGINATION SOUNDNESS in the module header.
      if (!complete) {
        checks.push({
          ...base,
          counterValue,
          observed: obs.rowCount,
          reason: `lower_bound_incomplete:rows=${obs.rowCount}<counter=${counterValue}_but_report_not_known_complete`,
        });
        continue;
      }
      checks.push({
        counter: check.counter,
        report: check.report,
        verdict: 'mismatch',
        mode: 'lower_bound',
        counterValue,
        observed: obs.rowCount,
        reason: `lower_bound_violated:rows=${obs.rowCount}<counter=${counterValue}`,
      });
      continue;
    }

    checks.push({ ...base, counterValue, reason: 'no_report_count' });
  }

  const matched = checks.filter((c) => c.verdict === 'match').length;
  const mismatched = checks.filter((c) => c.verdict === 'mismatch').length;
  const abstained = checks.filter((c) => c.verdict === 'abstain').length;
  const signal: CrossReportResult['signal'] =
    mismatched > 0 ? 'fail' : matched > 0 ? 'pass' : 'no_signal';

  return { signal, matched, mismatched, abstained, checks };
}

/**
 * Parse a report's counter cell → integer (or null). Handles thousands
 * separators and surrounding label text ("Occupied: 42"); refuses anything
 * with no digits. Kept here so the module stays dependency-free.
 */
export function parseCounter(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/,/g, '').match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0]!, 10);
  return Number.isFinite(n) ? n : null;
}
