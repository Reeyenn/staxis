// ─── What one AI employee costs ─────────────────────────────────────────────
//
// The arithmetic behind the money lines on an AI Staff card and on Mission
// Control's roster: fold the ledger rows into per-feature totals, then ask what
// each employee's own share of them is.
//
// It lives here rather than in /api/admin/mission/ai-staff because THREE
// callers need it and one of them cannot reach a route module without a cycle:
// the route reads the ledger, the AI Staff page renders the figure and the
// honesty caveat beside it, and Mission Control's roster draws today's number.
// The route already imports this module, so the shared pieces cannot live over
// there and be imported back.
//
// It also makes the sum testable in the one case that matters and that the
// route's own suite cannot reach: the ONE hired employee has ONE feature, so
// "sums its own features" and "sums everything the read returned" produce the
// same number through the route and no test there can tell them apart. That
// stops being true the moment employee #2 arrives with two features in its
// bundle, which is the whole reason `agent_costs.feature` exists (0374). Here a
// synthetic two-feature employee can be handed to it directly.
//
// The LEDGER READ stays in the route. This module is pure.

import { getAiFeatureDefinition } from '@/lib/ai/feature-registry';
import type { AiFeatureKey } from '@/lib/ai/types';
import { AI_EMPLOYEES, type AiEmployee } from '@/lib/ai/employee-registry';

/** How far back the spend figure looks. Matches the existing admin cost
 *  reporting window so surfaces quoting "recent AI spend" agree. */
export const SPEND_WINDOW_DAYS = 30;

export interface SpendRow {
  feature: string;
  cost_usd: number | string;
  created_at: string;
}

/** Both windows, keyed by feature. One read answers both — the day is a subset
 *  of the month, so a second query would only be a second chance to disagree. */
export interface SpendTotals {
  window: Map<string, number>;
  today: Map<string, number>;
}

/**
 * Fold ledger rows into a thirty-day total and a today total per feature.
 *
 * Exported for the standing test, and pure so that test needs no database:
 * every judgement worth checking — which rows count as today, what an
 * unparseable cost does — is decided here.
 *
 * A row whose cost will not parse is dropped, because carrying it forward
 * turns the whole feature's total into NaN — one bad row would take the entire
 * figure down with it, and `$NaN` is not a number anybody can act on.
 *
 * WHICH rows it is handed is the caller's business, and since 0374 that is the
 * BOOKS (`agent_costs`, finalized and unswept) rather than the findings GATE —
 * see INV-43. The fold does not care, which is the point: both windows come out
 * of one list, so they cannot end up quoting two different ledgers.
 */
export function foldSpendRows(rows: readonly SpendRow[], dayStartMs: number): SpendTotals {
  const totals: SpendTotals = { window: new Map(), today: new Map() };
  for (const row of rows) {
    const usd = typeof row.cost_usd === 'number' ? row.cost_usd : Number(row.cost_usd);
    if (!Number.isFinite(usd)) continue;
    totals.window.set(row.feature, (totals.window.get(row.feature) ?? 0) + usd);
    const at = new Date(row.created_at).getTime();
    if (Number.isFinite(at) && at >= dayStartMs) {
      totals.today.set(row.feature, (totals.today.get(row.feature) ?? 0) + usd);
    }
  }
  return totals;
}

export interface EmployeeSpend {
  /** false when the ledger could not be read, or when nothing in this
   *  employee's bundle produces a per-call bill at all. The card then shows the
   *  feature list and a link to the whole AI bill, not a number. */
  known: boolean;
  usd: number | null;
  /** The same ledger, narrowed to today. Mission Control's roster quotes spend
   *  per day next to the copilot's, and a thirty-day total under a column
   *  headed "spent today" would be a number nothing backs. Null exactly when
   *  `usd` is — the two come from one read. */
  todayUsd: number | null;
  windowDays: number;
  /** Bundled features that never produce a per-call provider bill — our own
   *  models, and anything that runs in the browser. Nothing is missing from the
   *  figure on their account; there is nothing to miss. */
  untracked: string[];
}

/**
 * Does this feature ever produce a per-call provider bill?
 *
 * Derived from the registry rather than listed here, because the registry is
 * what knows: a feature whose model runs in the browser (free dictation) or is
 * one of our own (`in_house` — the ML service on Fly) makes no call anybody
 * invoices per token, so no ledger has a row for it and none is missing. An
 * employee bundling only those is reported as "no separate bill" rather than as
 * $0.00, which would read as "this one is free" about work that costs hosting.
 */
export function billsPerCall(key: AiFeatureKey): boolean {
  const provider = getAiFeatureDefinition(key).runtimeProvider;
  return provider !== 'browser' && provider !== 'in_house';
}

/** Every feature any hired employee claims a bill for, deduped — the exact key
 *  set the ledger read has to ask for, and nothing wider. */
export function billedBundleKeys(roster: readonly AiEmployee[] = AI_EMPLOYEES): string[] {
  const keys = new Set<string>();
  for (const e of roster) {
    if (!e.hired) continue;
    for (const k of e.bundle.features) if (billsPerCall(k)) keys.add(k);
  }
  return [...keys];
}

/**
 * One card's money line.
 *
 * `totals` is what the ledger returned, keyed by feature; null means the read
 * failed, which is reported as "we could not work it out" rather than as zero.
 * Zero is a claim.
 */
export function employeeSpend(
  e: AiEmployee,
  totals: SpendTotals | null,
  windowDays: number = SPEND_WINDOW_DAYS,
): EmployeeSpend | null {
  if (!e.hired) return null;
  const untracked = e.bundle.features.filter((k) => !billsPerCall(k));
  const billed = e.bundle.features.filter(billsPerCall);
  if (totals === null || billed.length === 0) {
    return {
      known: false, usd: null, todayUsd: null,
      windowDays, untracked: [...untracked],
    };
  }
  // ONLY this employee's own features. `totals` may legitimately carry another
  // employee's keys — one read serves the whole roster — so summing the maps
  // rather than the bundle would bill every card for all of it.
  //
  // Rounded to the cent it is quoted in. The ledger stores six decimal places
  // because a single Haiku call costs a fraction of one.
  const cents = (m: Map<string, number>) =>
    Math.round(billed.reduce((acc, k) => acc + (m.get(k) ?? 0), 0) * 100) / 100;
  return {
    known: true,
    usd: cents(totals.window),
    todayUsd: cents(totals.today),
    windowDays,
    untracked: [...untracked],
  };
}

/**
 * The one honest caveat on the money: are the figures below covering the whole
 * window, or only the part of it since the ledger learned to attribute?
 *
 * Returns null once `attributedSince` is older than the window, which is when
 * the caveat stops being true — it retires itself rather than becoming a
 * permanent piece of furniture nobody reads.
 */
export function spendAttributionNote(p: {
  attributionReadable: boolean;
  attributedSince: string | null;
  windowDays: number;
  now?: number;
}): { kind: 'none' } | { kind: 'partial'; since: string } | null {
  if (!p.attributionReadable) return null;
  if (p.attributedSince === null) return { kind: 'none' };
  const since = Date.parse(p.attributedSince);
  if (!Number.isFinite(since)) return null;
  const windowStart = (p.now ?? Date.now()) - p.windowDays * 86_400_000;
  return since > windowStart ? { kind: 'partial', since: p.attributedSince } : null;
}
