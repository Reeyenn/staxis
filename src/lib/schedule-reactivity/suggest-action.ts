/**
 * Given a Gap, decide whether it deserves an alert, what action to suggest,
 * and at what severity. Optionally also estimate savings for release_shift.
 *
 * Decision rules:
 *   |gap| < threshold        → null (no alert)
 *   gap > 0 (understaffed)   → suggested_action = 'add_shift'
 *   gap < 0 (overstaffed)    → suggested_action = 'release_shift'
 *   severity = 'red' when |gap| / demand >= redPct, else 'yellow'.
 *
 * Pure: takes a Gap + config + (for release_shift) a wage in cents.
 * No I/O.
 */

import type {
  Gap, PropertyConfig, Suggestion, Severity, TriggerKind,
} from './types';

export interface SuggestActionOptions {
  triggerKind: TriggerKind;
  /** For release_shift only — hourly wage in cents to use when estimating
   *  savings. NULL when 0229 hasn't shipped or when no staff has a wage
   *  set yet. The output Suggestion records suggestedSavingsCents=undefined
   *  so the UI can show "wage data pending — set wages in Staff directory". */
  wageCentsPerHour?: number | null;
}

export function suggestActionForGap(
  gap: Gap,
  cfg: PropertyConfig,
  opts: SuggestActionOptions,
): Suggestion | null {
  const absGap = Math.abs(gap.gapMinutes);
  if (absGap < cfg.gapAlertThresholdMinutes) return null;

  // Don't suggest actions when demand is zero — that's a "model is off" case
  // (e.g. breakfast window pair NULL → demand 0) and shouldn't fire alerts.
  if (gap.demandMinutes <= 0) return null;

  const suggestedAction: Suggestion['suggestedAction'] =
    gap.gapMinutes > 0 ? 'add_shift' : 'release_shift';
  const severity: Severity =
    absGap / gap.demandMinutes >= cfg.gapAlertRedPct ? 'red' : 'yellow';

  const context: Record<string, unknown> = {
    ...gap.context,
    pctOfDemand: gap.demandMinutes > 0
      ? Math.round((absGap / gap.demandMinutes) * 100)
      : null,
  };

  let suggestedSavingsCents: number | undefined;
  if (suggestedAction === 'release_shift') {
    const wage = opts.wageCentsPerHour;
    if (typeof wage === 'number' && wage > 0) {
      // Estimate: minutes-of-overscheduling × wage. Don't try to round
      // to a whole-shift release here — the UI handles that step when
      // the manager picks WHICH shift to release.
      suggestedSavingsCents = Math.round((absGap / 60) * wage);
      context.wageCentsPerHourSource = 'staff_or_default';
    } else {
      context.wageDataPending = true;
    }
  }

  return {
    propertyId: gap.propertyId,
    alertDate: gap.alertDate,
    department: gap.department,
    severity,
    suggestedAction,
    gapMinutes: gap.gapMinutes,
    demandMinutes: gap.demandMinutes,
    scheduledMinutes: gap.scheduledMinutes,
    suggestedSavingsCents,
    triggerKind: opts.triggerKind,
    context,
  };
}

/**
 * Average wage in cents/hour across a list of staff members. Used by the
 * release_shift estimator when picking a representative wage. Returns
 * `null` if no staff have a wage column set; the suggestion will record
 * wageDataPending=true and the UI surfaces "wage data pending — set wages
 * in Staff directory."
 *
 * Falls back to legacy `hourly_wage` (dollars) × 100 when
 * `hourly_wage_cents` is null. The legacy column has a $15 default since
 * migration 0001, so this will almost always return a value once the
 * cost-tracking branch (0229) ships its backfill — but we don't depend on
 * that for correctness.
 */
export function averageWageCentsPerHour(
  staffWages: Array<{ hourlyWageCents: number | null; hourlyWage: number | null }>,
): number | null {
  let total = 0;
  let count = 0;
  for (const s of staffWages) {
    if (typeof s.hourlyWageCents === 'number' && s.hourlyWageCents > 0) {
      total += s.hourlyWageCents;
      count++;
    } else if (typeof s.hourlyWage === 'number' && s.hourlyWage > 0) {
      total += Math.round(s.hourlyWage * 100);
      count++;
    }
  }
  if (count === 0) return null;
  return Math.round(total / count);
}

/** Default placeholder wage. Used when staff_wage data is missing and we
 *  still want to *show* a ballpark savings number rather than nothing. The
 *  context.wageDataPending=true flag tells the UI to add the disclaimer.
 *  Set to $14/hr per the spec. */
export const DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR = 1400;
