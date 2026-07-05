/**
 * Cross-feed reconciliation (feature/cua-bestclass-verify, Task 1).
 *
 * reconcileRows (oracle-verify.ts) proves a SINGLE feed against its own DOM
 * oracle. This module adds an INDEPENDENT, cross-feed check: the hotel's own
 * dashboard counters (getDashboardCounts → pms_in_house_snapshot) are a second
 * witness for the row feeds. If getArrivals secretly learned a "this week"
 * superset, or getRoomStatus learned the wrong (or an empty) table, the row
 * count won't reconcile with the dashboard's matching counter. That mismatch is
 * a wrong-row-set signal NO single-feed oracle can see.
 *
 * PURE module: no playwright / supabase / anthropic. The caller gathers the
 * learn-time observations (per-feed row counts from boardTargets previews + the
 * scraped dashboard counters) and passes them in. Fully unit-testable offline.
 *
 * ABSTAIN-BY-DEFAULT, like the rest of the safety core: a check only ever
 * reports `match` / `mismatch` when it has the data to do so SOUNDLY; otherwise
 * `abstain`. The overall signal is `fail` only on a genuine contradiction, never
 * on missing data — so a PMS with no dashboard feed (or a legacy recipe) yields
 * `no_signal` and nothing downstream is penalised.
 *
 * getDashboardCounts is NOT a CORE reconcile target (reconcileRows returns
 * 'not_core_target' for it). It is handled HERE, on its own counter path, and
 * is NEVER routed through reconcileRows.
 */

import type { Recipe } from './types.js';

export type ActionKey = keyof Recipe['actions'];

/** The dashboard feed whose scraped counters witness the row feeds. */
export const DASHBOARD_FEED: ActionKey = 'getDashboardCounts';

/** Canonical room-status values that mean "occupied" (see TARGET_VALUE_CONTRACTS
 *  getRoomStatus.status). Used by the (full-rows) exact occupancy check. */
const OCCUPIED_STATUSES = new Set(['occupied', 'occupied_clean', 'occupied_dirty']);

/**
 * One cross-feed check: a dashboard counter column witnessing a row feed.
 *
 *  - `predicate` present ⟹ when the caller supplies the FULL row set
 *    (rowsComplete), the count of rows matching the predicate must EQUAL the
 *    counter (within tolerance). This is the strong form.
 *  - `lowerBound` ⟹ when full rows aren't available, fall back to the SOUND
 *    inequality "feed total row count ≥ counter": the counter is a subset of (or
 *    bounded by) the feed's rows, so the feed can never legitimately have FEWER
 *    rows than the counter. This is what catches a wrong/empty/too-small feed
 *    without ever false-failing a correct superset feed.
 *
 * PAGINATION SOUNDNESS: the lower-bound inequality is only sound to FAIL on when
 * `rowCount` is the feed's TOTAL row count. A server-paginated feed renders only
 * the first page, so `rowCount` is a page-size SUBSET and `rowCount < counter` is
 * NOT a contradiction — the missing rows are on later pages. So a lower-bound
 * SHORTFALL is a real mismatch only when the observation is known-complete
 * (`rowsComplete`); otherwise it degrades to `abstain` (no signal), matching this
 * module's abstain-by-default rule. A lower-bound SATISFACTION (rowCount ≥ counter)
 * stays a `match` regardless of completeness — a page that already meets/exceeds
 * the counter witnesses it whether or not more rows follow.
 */
export interface CrossFeedCheck {
  counter: string;
  feed: ActionKey;
  predicate?: (row: Record<string, unknown>) => boolean;
  lowerBound: boolean;
}

/**
 * The per-target check table — mirrors DISCOVERY_KEY_COLUMNS in spirit
 * (target-level config, zero PMS-specific logic). Each entry is SOUND: the
 * relation holds for any correct recipe regardless of PMS, so a violation is a
 * real defect, never a quirk.
 *
 * "remaining_today" dashboard counters are a SUBSET of the full arrivals/
 * departures feed (some guests already arrived/left), so only the lower-bound
 * relation is asserted for them — never equality.
 */
export const CROSS_FEED_CHECKS: CrossFeedCheck[] = [
  // Front desk: total arrivals/departures today ≥ those still remaining.
  { counter: 'arrivals_remaining_today', feed: 'getArrivals', lowerBound: true },
  { counter: 'departures_remaining_today', feed: 'getDepartures', lowerBound: true },
  // Housekeeping: occupied rooms is exactly countable from a full room-status
  // set, and is always ≤ the total number of rooms in that feed.
  {
    counter: 'total_occupied_rooms',
    feed: 'getRoomStatus',
    predicate: (r) => OCCUPIED_STATUSES.has(canonicalStatus(r)),
    lowerBound: true,
  },
  {
    counter: 'total_vacant_clean',
    feed: 'getRoomStatus',
    predicate: (r) => canonicalStatus(r) === 'vacant_clean',
    lowerBound: true,
  },
];

function canonicalStatus(row: Record<string, unknown>): string {
  const v = row['status'];
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

/** One row feed's learn-time observation. `rowCount` is the total rows matched
 *  on the feed page (boardTargets preview.rowCount). `rows` is whatever sample
 *  the caller has; `rowsComplete` is true only when the observation is the ENTIRE
 *  feed — i.e. `rows` is every row (so a predicate count over it is exact, not a
 *  truncated undercount) AND `rowCount` is the feed TOTAL (not one page of a
 *  server-paginated feed). `rowsComplete` therefore gates BOTH the exact-predicate
 *  path AND the lower-bound SHORTFALL fail: without it, a lower-bound shortfall is
 *  abstained (it may just be a later page), never failed. */
export interface FeedObservation {
  rowCount?: number;
  rows?: Array<Record<string, unknown>>;
  rowsComplete?: boolean;
}

export interface CrossFeedInput {
  /** Per-feed observations, keyed by action name. Missing feed ⟹ its checks
   *  abstain. */
  feeds: Partial<Record<string, FeedObservation>>;
  /** Scraped dashboard counters: column name → numeric value (already parsed).
   *  Unparseable / absent counters ⟹ their checks abstain. */
  dashboardCounters: Record<string, number | null | undefined>;
  /** Absolute slack added to the percentage tolerance (default 2 — a couple of
   *  guests can move between the feed scrape and the dashboard scrape). */
  absoluteTolerance?: number;
  /** Fractional tolerance on the counter (default 0.10). */
  fractionalTolerance?: number;
}

export type CheckVerdict = 'match' | 'mismatch' | 'abstain';

export interface CrossFeedCheckResult {
  counter: string;
  feed: ActionKey;
  verdict: CheckVerdict;
  /** 'exact' (full-rows predicate count) or 'lower_bound' (rowCount ≥ counter)
   *  or '' when abstained. */
  mode: 'exact' | 'lower_bound' | '';
  counterValue?: number;
  observed?: number;
  reason: string;
}

export interface CrossFeedResult {
  /** 'pass' = ≥1 check matched and none mismatched; 'fail' = ≥1 mismatched;
   *  'no_signal' = every check abstained. */
  signal: 'pass' | 'fail' | 'no_signal';
  matched: number;
  mismatched: number;
  abstained: number;
  checks: CrossFeedCheckResult[];
}

function tolerance(counter: number, input: CrossFeedInput): number {
  const abs = input.absoluteTolerance ?? 2;
  const frac = input.fractionalTolerance ?? 0.10;
  return Math.max(abs, Math.ceil(Math.abs(counter) * frac));
}

/**
 * Reconcile the dashboard counters against the row feeds. Abstain-by-default:
 * any check lacking sound data reports `abstain` and does not affect the signal.
 */
export function reconcileCrossFeed(input: CrossFeedInput): CrossFeedResult {
  const checks: CrossFeedCheckResult[] = [];

  for (const check of CROSS_FEED_CHECKS) {
    const counterRaw = input.dashboardCounters[check.counter];
    const feedObs = input.feeds[check.feed];

    const base: CrossFeedCheckResult = {
      counter: check.counter, feed: check.feed, verdict: 'abstain', mode: '', reason: '',
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
    if (!feedObs) {
      checks.push({ ...base, counterValue, reason: 'feed_unavailable' });
      continue;
    }
    const tol = tolerance(counterValue, input);

    // Strong form: an exact predicate count over the COMPLETE row set.
    if (check.predicate && feedObs.rowsComplete && Array.isArray(feedObs.rows)) {
      const observed = feedObs.rows.filter((r) => safePredicate(check.predicate!, r)).length;
      const ok = Math.abs(observed - counterValue) <= tol;
      checks.push({
        counter: check.counter, feed: check.feed,
        verdict: ok ? 'match' : 'mismatch', mode: 'exact',
        counterValue, observed,
        reason: ok ? 'exact_within_tolerance' : `exact_off_by:${observed - counterValue}`,
      });
      continue;
    }

    // Sound fallback: total feed rows must be ≥ the counter (a subset/bounded
    // counter can never exceed the feed's own row count). Only informative when
    // the counter is positive — "rowCount ≥ 0" proves nothing.
    if (check.lowerBound && typeof feedObs.rowCount === 'number' && Number.isFinite(feedObs.rowCount)) {
      if (counterValue === 0) {
        checks.push({ ...base, counterValue, observed: feedObs.rowCount, reason: 'counter_zero_uninformative' });
        continue;
      }
      const complete = feedObs.rowsComplete === true;
      // An EMPTY feed that is KNOWN-COMPLETE can never witness a POSITIVE counter
      // — that is the exact wrong/empty-feed signal, and the drift tolerance must
      // NOT swallow it (review P1: with abs tolerance 2, rowCount 0 would otherwise
      // "match" a counter of 1 or 2). Checked BEFORE the tolerance comparison, and
      // gated on completeness (a blank first page of a paginated feed is not proof
      // of an empty feed → it abstains via the shortfall path below).
      if (complete && feedObs.rowCount === 0) {
        checks.push({
          counter: check.counter, feed: check.feed,
          verdict: 'mismatch', mode: 'lower_bound',
          counterValue, observed: 0,
          reason: `lower_bound_violated:empty_feed_vs_counter=${counterValue}`,
        });
        continue;
      }
      // A lower-bound SATISFACTION (rowCount ≥ counter within tolerance) is sound
      // regardless of completeness: a page already meeting/exceeding the counter
      // witnesses it whether or not more rows follow.
      if (feedObs.rowCount >= counterValue - tol) {
        checks.push({
          counter: check.counter, feed: check.feed,
          verdict: 'match', mode: 'lower_bound',
          counterValue, observed: feedObs.rowCount,
          reason: 'lower_bound_satisfied',
        });
        continue;
      }
      // SHORTFALL (rowCount < counter - tol). A real contradiction ONLY when the
      // observation is the WHOLE feed. Under server-side pagination rowCount is one
      // page (e.g. 25 of 60), so a shortfall is expected, not a defect — the missing
      // rows are on later pages. Without a completeness guarantee we ABSTAIN, not
      // fail (abstain-by-default). This is the same reality oracle-verify.ts
      // accommodates ("the DOM may legitimately be paginated — showing 25 of 60");
      // a correct-but-paginated feed must never cross-feed-fail.
      if (!complete) {
        checks.push({
          ...base, counterValue, observed: feedObs.rowCount,
          reason: `lower_bound_incomplete:rows=${feedObs.rowCount}<counter=${counterValue}_but_feed_not_known_complete`,
        });
        continue;
      }
      // Known-complete AND still short → a genuine wrong/too-small feed.
      checks.push({
        counter: check.counter, feed: check.feed,
        verdict: 'mismatch', mode: 'lower_bound',
        counterValue, observed: feedObs.rowCount,
        reason: `lower_bound_violated:rows=${feedObs.rowCount}<counter=${counterValue}`,
      });
      continue;
    }

    checks.push({ ...base, counterValue, reason: 'no_feed_count' });
  }

  const matched = checks.filter((c) => c.verdict === 'match').length;
  const mismatched = checks.filter((c) => c.verdict === 'mismatch').length;
  const abstained = checks.filter((c) => c.verdict === 'abstain').length;
  const signal: CrossFeedResult['signal'] =
    mismatched > 0 ? 'fail' : matched > 0 ? 'pass' : 'no_signal';

  return { signal, matched, mismatched, abstained, checks };
}

function safePredicate(
  fn: (row: Record<string, unknown>) => boolean,
  row: Record<string, unknown>,
): boolean {
  try { return fn(row); } catch { return false; }
}

/**
 * Parse a scraped dashboard counter string → integer (or null). Handles thousands
 * separators and surrounding label text ("Occupied: 42"); refuses anything with
 * no digits. Kept here (not via the parser registry) so the module stays
 * dependency-free and self-contained.
 */
export function parseCounter(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/,/g, '').match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0]!, 10);
  return Number.isFinite(n) ? n : null;
}
