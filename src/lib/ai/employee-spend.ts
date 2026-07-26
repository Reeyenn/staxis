// ─── What one AI employee costs ─────────────────────────────────────────────
//
// The arithmetic behind the money line on an AI Staff card, kept OUT of
// /api/admin/mission/ai-staff for one blunt reason: a Next.js route module may
// only export the handlers, so nothing inside one can be called by a test. The
// route's own integration suite can prove the figure end-to-end for the ONE
// hired employee — but that employee has exactly one feature, so "sums the
// right features" and "sums every feature it can see" produce the same number
// through the route and no test there can tell them apart.
//
// That stops being true the moment employee #2 arrives with two features in its
// bundle, which is the whole reason `agent_costs.feature` exists (0374). So the
// per-employee sum lives here, where a synthetic two-feature employee can be
// handed to it directly and a mis-attribution fails a test instead of appearing
// on a card as a plausible-looking number.
//
// The LEDGER read stays in the route. This module is pure: given the totals,
// what does each card say.

import { getAiFeatureDefinition } from '@/lib/ai/feature-registry';
import type { AiFeatureKey } from '@/lib/ai/types';
import { AI_EMPLOYEES, type AiEmployee } from '@/lib/ai/employee-registry';

/** How far back the spend figure looks. Matches the AI recommendations screen's
 *  window so two admin surfaces quoting "recent AI spend" mean the same thing. */
export const SPEND_WINDOW_DAYS = 30;

export interface EmployeeSpend {
  /** false when the ledger could not be read, or when nothing in this
   *  employee's bundle produces a per-call bill at all. The card then shows the
   *  feature list and a link to the whole AI bill, not a number. */
  known: boolean;
  usd: number | null;
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
  totals: Map<string, number> | null,
  windowDays: number = SPEND_WINDOW_DAYS,
): EmployeeSpend | null {
  if (!e.hired) return null;
  const untracked = e.bundle.features.filter((k) => !billsPerCall(k));
  const billed = e.bundle.features.filter(billsPerCall);
  if (totals === null || billed.length === 0) {
    return { known: false, usd: null, windowDays, untracked: [...untracked] };
  }
  // ONLY this employee's own features. `totals` may legitimately carry another
  // employee's keys — one read serves the whole roster — so summing the map
  // rather than the bundle would bill every card for all of it.
  //
  // Rounded to the cent it is quoted in. The ledger stores six decimal places
  // because a single Haiku call costs a fraction of one.
  const sum = billed.reduce((acc, k) => acc + (totals.get(k) ?? 0), 0);
  return {
    known: true,
    usd: Math.round(sum * 100) / 100,
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
