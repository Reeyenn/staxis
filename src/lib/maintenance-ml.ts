// ═══════════════════════════════════════════════════════════════════════════
// Maintenance ML — failure prediction + repair-vs-replace economics.
//
// Two layers, one file. Pure functions: no DB calls, no fetches, no React.
// Caller passes equipment + work_orders + preventive_tasks, callee returns
// alerts / predictions / recommendations. Trivially testable.
//
// Layer 1 (cold-start, rules-based) is the immediate-value path. Works on
// day one with zero training data. Five rules:
//   - Recurrence:      3+ work orders in 90d on same asset → warning
//                      5+ → critical
//   - Cost threshold:  cumulative repair cost > 60% replacement → eval
//                      > 80% → recommend replacement
//   - Spatial pattern: 3+ work orders in same location within 60d → flag
//                      a systemic issue (shared plumbing/electrical run)
//   - PM overdue:      now - last_pm_at > pm_interval_days → overdue
//   - Age warning:     age > 80% of expected_lifetime_years → near EOL
//
// Layer 2 (statistical, activates after ~20 work orders + ≥2 months) adds:
//   - Weibull survival per category (MLE on time-between-failures)
//   - Bayesian-flavored cost regression (linear trajectory + 12-month
//     projection, compared to replacement cost)
//   - Seasonal decomposition (which months historically spike per category)
//
// Layer 3 (multi-factor XGBoost, cross-property learning, optimal PM
// interval, budget forecasting) is sketched as TODO interfaces only —
// requires 6+ months of cross-property data to be useful.
//
// Why client-side JS instead of the Python service: per-property data
// volume is tiny (hundreds of work orders, not millions). Run locally,
// stay reactive to UI state, no round trip needed. If usage outgrows
// this, lift the same interfaces into the Python service later.
// ═══════════════════════════════════════════════════════════════════════════

import type { Equipment, WorkOrder, PreventiveTask, ServiceContract } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MaintenanceAlert {
  equipmentId: string;
  alertType: 'recurrence' | 'cost_threshold' | 'spatial_pattern' | 'pm_overdue' | 'age_warning';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  recommendation: string;
  data: Record<string, unknown>;
}

export interface FailurePrediction {
  equipmentId: string;
  probabilityOfFailure30d: number;   // 0..1
  probabilityOfFailure60d: number;
  probabilityOfFailure90d: number;
  estimatedDaysToNextFailure: number | null;
  confidenceLevel: 'low' | 'medium' | 'high';
  factors: string[];
}

export interface RepairReplaceRecommendation {
  equipmentId: string;
  cumulativeRepairCost: number;
  projectedNextYearRepairCost: number;
  replacementCost: number;
  recommendation: 'repair' | 'monitor' | 'plan_replacement' | 'replace_now';
  reasoning: string;
  breakEvenDate?: Date;
}

export interface SeasonalPattern {
  category: Equipment['category'];
  monthlyMultipliers: number[];      // length 12, multiplier vs annual mean per month
  spikeMonths: number[];              // 1-indexed months that exceed 1.5× mean
}

// Layer 3 hooks — interfaces only, no impl yet.
export interface MultifactorFailureFeatures {
  // TODO: Layer 3 — requires 6+ months of data
  equipmentId: string;
  ageDays: number;
  daysSinceLastFailure: number;
  cumulativeFailures: number;
  occupancyLast30d: number;
  category: Equipment['category'];
  monthOfYear: number;
}

export interface OptimalPmInterval {
  // TODO: Layer 3 — requires cross-property training data
  equipmentId: string;
  currentIntervalDays: number;
  optimalIntervalDays: number;
  expectedAnnualCostReduction: number;
}

// ─── Constants / config ─────────────────────────────────────────────────────

const RECURRENCE_WINDOW_DAYS = 90;
const SPATIAL_WINDOW_DAYS = 60;
const RECURRENCE_WARNING = 3;
const RECURRENCE_CRITICAL = 5;
const COST_THRESHOLD_WARNING = 0.6;
const COST_THRESHOLD_CRITICAL = 0.8;
const AGE_WARNING_PCT = 0.8;
const SPATIAL_THRESHOLD = 3;
const MIN_FAILURES_FOR_LAYER2 = 5;
const MIN_TOTAL_WORK_ORDERS_FOR_LAYER2 = 20;

const DAY_MS = 1000 * 60 * 60 * 24;

// ─── Layer 1: cold-start rule-based alerts ─────────────────────────────────

export function generateColdStartAlerts(
  equipment: Equipment[],
  workOrders: WorkOrder[],
  preventiveTasks: PreventiveTask[],
  serviceContracts: ServiceContract[] = [],
): MaintenanceAlert[] {
  const now = Date.now();
  const alerts: MaintenanceAlert[] = [];

  // Pre-bucket work orders by equipment_id and by location for fast scans.
  const ordersByEquipment = new Map<string, WorkOrder[]>();
  const ordersByLocation = new Map<string, WorkOrder[]>();
  for (const o of workOrders) {
    if (o.equipmentId) {
      const list = ordersByEquipment.get(o.equipmentId) ?? [];
      list.push(o);
      ordersByEquipment.set(o.equipmentId, list);
    }
    const loc = o.roomNumber ?? '';
    if (loc) {
      const list = ordersByLocation.get(loc) ?? [];
      list.push(o);
      ordersByLocation.set(loc, list);
    }
  }

  // ── Per-equipment rules: recurrence + cost + age + PM ───────────────────
  for (const eq of equipment) {
    const orders = ordersByEquipment.get(eq.id) ?? [];
    const recent = orders.filter(o => o.createdAt && now - o.createdAt.getTime() < RECURRENCE_WINDOW_DAYS * DAY_MS);

    // Recurrence
    if (recent.length >= RECURRENCE_CRITICAL) {
      alerts.push({
        equipmentId: eq.id,
        alertType: 'recurrence',
        severity: 'critical',
        message: `${eq.name} has failed ${recent.length} times in the last ${RECURRENCE_WINDOW_DAYS} days`,
        recommendation: 'Investigate root cause or schedule immediate replacement evaluation.',
        data: { count: recent.length, windowDays: RECURRENCE_WINDOW_DAYS },
      });
    } else if (recent.length >= RECURRENCE_WARNING) {
      alerts.push({
        equipmentId: eq.id,
        alertType: 'recurrence',
        severity: 'warning',
        message: `${eq.name} has failed ${recent.length} times in the last ${RECURRENCE_WINDOW_DAYS} days`,
        recommendation: 'Monitor closely; likely indicates a deeper issue than a one-off failure.',
        data: { count: recent.length, windowDays: RECURRENCE_WINDOW_DAYS },
      });
    }

    // Cost threshold (cumulative repair cost vs replacement cost)
    if (eq.replacementCost && eq.replacementCost > 0) {
      const cumulative = orders.reduce((s, o) => s + (o.repairCost ?? 0), 0);
      const ratio = cumulative / eq.replacementCost;
      if (ratio >= COST_THRESHOLD_CRITICAL) {
        alerts.push({
          equipmentId: eq.id,
          alertType: 'cost_threshold',
          severity: 'critical',
          message: `${eq.name} has cost ${formatCurrencyShort(cumulative)} in repairs (${Math.round(ratio * 100)}% of $${eq.replacementCost} replacement)`,
          recommendation: 'Replace now — ongoing repair spend has exceeded 80% of replacement cost.',
          data: { cumulative, replacementCost: eq.replacementCost, ratio },
        });
      } else if (ratio >= COST_THRESHOLD_WARNING) {
        alerts.push({
          equipmentId: eq.id,
          alertType: 'cost_threshold',
          severity: 'warning',
          message: `${eq.name} has cost ${formatCurrencyShort(cumulative)} in repairs (${Math.round(ratio * 100)}% of replacement cost)`,
          recommendation: 'Evaluate replacement during next planned downtime window.',
          data: { cumulative, replacementCost: eq.replacementCost, ratio },
        });
      }
    }

    // PM overdue + pre-emptive "due soon" alerts. If we've never recorded
    // a PM (lastPmAt is null), don't claim it's "Infinity days overdue" —
    // the equipment may be brand new. Fall back to installDate, then
    // equipment.createdAt as the anchor.
    if (eq.pmIntervalDays && eq.pmIntervalDays > 0) {
      const anchor = eq.lastPmAt?.getTime()
        ?? eq.installDate?.getTime()
        ?? eq.createdAt?.getTime()
        ?? 0;
      if (anchor > 0) {
        const daysSinceAnchor = (now - anchor) / DAY_MS;
        if (daysSinceAnchor > eq.pmIntervalDays) {
          const overdueDays = Math.round(daysSinceAnchor - eq.pmIntervalDays);
          const neverDone = !eq.lastPmAt;
          alerts.push({
            equipmentId: eq.id,
            alertType: 'pm_overdue',
            severity: overdueDays > eq.pmIntervalDays ? 'critical' : 'warning',
            message: neverDone
              ? `${eq.name} has no recorded preventive maintenance — ${overdueDays} day${overdueDays === 1 ? '' : 's'} past the recommended ${eq.pmIntervalDays}-day cadence`
              : `${eq.name} preventive maintenance is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`,
            recommendation: `Recommended PM interval: every ${eq.pmIntervalDays} days. Schedule a PM visit.`,
            data: { overdueDays, intervalDays: eq.pmIntervalDays, neverDone },
          });
        } else {
          const daysUntilDue = Math.ceil(eq.pmIntervalDays - daysSinceAnchor);
          const preDueSeverity = preDueSeverityFor(daysUntilDue);
          if (preDueSeverity) {
            alerts.push({
              equipmentId: eq.id,
              alertType: 'pm_overdue',
              severity: preDueSeverity,
              message: `${eq.name} preventive maintenance due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`,
              recommendation: `Recommended PM interval: every ${eq.pmIntervalDays} days. Schedule a PM visit before it's overdue.`,
              data: { daysUntilDue, intervalDays: eq.pmIntervalDays, preDue: true },
            });
          }
        }
      }
    }

    // Age warning
    if (eq.installDate && eq.expectedLifetimeYears && eq.expectedLifetimeYears > 0) {
      const ageYears = (now - eq.installDate.getTime()) / DAY_MS / 365;
      const ratio = ageYears / eq.expectedLifetimeYears;
      if (ratio >= AGE_WARNING_PCT) {
        alerts.push({
          equipmentId: eq.id,
          alertType: 'age_warning',
          severity: ratio >= 1 ? 'warning' : 'info',
          message: `${eq.name} is ${ageYears.toFixed(1)} years old (${Math.round(ratio * 100)}% of ${eq.expectedLifetimeYears}-year expected lifetime)`,
          recommendation: ratio >= 1
            ? 'Past expected lifetime — increase monitoring; budget for replacement.'
            : 'Approaching end of expected lifetime — start planning replacement budget.',
          data: { ageYears, lifetimeYears: eq.expectedLifetimeYears, ratio },
        });
      }
    }
  }

  // ── Spatial pattern: 3+ work orders in same location in 60d ────────────
  for (const [location, orders] of ordersByLocation) {
    const recent = orders.filter(o => o.createdAt && now - o.createdAt.getTime() < SPATIAL_WINDOW_DAYS * DAY_MS);
    if (recent.length >= SPATIAL_THRESHOLD) {
      // Attribute to first equipment we know about in that location, or a synthetic id.
      const repEq = equipment.find(eq => eq.location && eq.location.includes(location)) ?? null;
      alerts.push({
        equipmentId: repEq?.id ?? `location:${location}`,
        alertType: 'spatial_pattern',
        severity: 'warning',
        message: `${recent.length} work orders in ${location} in the last ${SPATIAL_WINDOW_DAYS} days`,
        recommendation: 'Possible systemic issue — investigate shared infrastructure (plumbing/electrical/HVAC runs).',
        data: { location, count: recent.length, windowDays: SPATIAL_WINDOW_DAYS },
      });
    }
  }

  // PM overdue + pre-due alerts can also fire from the preventive_tasks
  // table even when no equipment is linked — same rule, different source.
  for (const t of preventiveTasks) {
    if (!t.lastCompletedAt || !t.frequencyDays) continue;
    const daysSince = (now - t.lastCompletedAt.getTime()) / DAY_MS;
    if (daysSince > t.frequencyDays) {
      alerts.push({
        equipmentId: t.equipmentId ?? `pm:${t.id}`,
        alertType: 'pm_overdue',
        severity: daysSince > t.frequencyDays * 1.5 ? 'critical' : 'warning',
        message: `${t.name} is ${Math.round(daysSince - t.frequencyDays)} day${Math.round(daysSince - t.frequencyDays) === 1 ? '' : 's'} overdue`,
        recommendation: `Frequency: every ${t.frequencyDays} days.`,
        data: { taskId: t.id, overdueDays: Math.round(daysSince - t.frequencyDays) },
      });
    } else {
      const daysUntilDue = Math.ceil(t.frequencyDays - daysSince);
      const preDueSeverity = preDueSeverityFor(daysUntilDue);
      if (preDueSeverity) {
        alerts.push({
          equipmentId: t.equipmentId ?? `pm:${t.id}`,
          alertType: 'pm_overdue',
          severity: preDueSeverity,
          message: `${t.name} due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`,
          recommendation: `Frequency: every ${t.frequencyDays} days. Schedule before it's overdue.`,
          data: { taskId: t.id, daysUntilDue, preDue: true },
        });
      }
    }
  }

  // Service contracts — outsourced recurring services (pool service, fire
  // suppression, pest control). Same threshold logic as PM: pre-due at
  // 30/14/7 days, then escalating overdue.
  for (const c of serviceContracts) {
    if (!c.nextDueAt) continue;
    const daysUntilDue = Math.ceil((c.nextDueAt.getTime() - now) / DAY_MS);
    if (daysUntilDue < 0) {
      const overdueDays = -daysUntilDue;
      alerts.push({
        equipmentId: `contract:${c.id}`,
        alertType: 'pm_overdue',
        severity: overdueDays > 14 ? 'critical' : 'warning',
        message: `${c.name} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`,
        recommendation: c.vendorId
          ? `Schedule next visit with the assigned vendor.`
          : `Schedule next visit; assign a vendor for faster follow-up next time.`,
        data: { contractId: c.id, overdueDays, cadence: c.cadence },
      });
    } else {
      const preDueSeverity = preDueSeverityFor(daysUntilDue);
      if (preDueSeverity) {
        alerts.push({
          equipmentId: `contract:${c.id}`,
          alertType: 'pm_overdue',
          severity: preDueSeverity,
          message: `${c.name} due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`,
          recommendation: `Cadence: ${c.cadence}. Schedule the next visit before it's overdue.`,
          data: { contractId: c.id, daysUntilDue, preDue: true, cadence: c.cadence },
        });
      }
    }
  }

  return alerts;
}

/**
 * Map "days until due" → alert severity. Used by both equipment-PM and
 * preventive-task pre-due alert paths so the thresholds stay in sync.
 *   ≤7d  → critical
 *   ≤14d → warning
 *   ≤30d → info
 *   >30d → null (no alert)
 */
function preDueSeverityFor(daysUntilDue: number): 'info' | 'warning' | 'critical' | null {
  if (daysUntilDue <= 0) return null;
  if (daysUntilDue <= 7) return 'critical';
  if (daysUntilDue <= 14) return 'warning';
  if (daysUntilDue <= 30) return 'info';
  return null;
}

// ─── Layer 2: statistical models ───────────────────────────────────────────

/**
 * Failure prediction using a Weibull survival model fit per equipment
 * category. For each piece of equipment, look up its category's Weibull
 * (shape k, scale λ), then evaluate the survival function at t = days
 * since this equipment's last failure.
 *
 * Returns confidence='low' for any equipment whose category has fewer
 * than MIN_FAILURES_FOR_LAYER2 observed time-between-failures intervals,
 * or when total work-order count across the property is below
 * MIN_TOTAL_WORK_ORDERS_FOR_LAYER2.
 */
export function predictFailures(
  equipment: Equipment[],
  workOrders: WorkOrder[],
): FailurePrediction[] {
  const haveEnoughData = workOrders.length >= MIN_TOTAL_WORK_ORDERS_FOR_LAYER2;
  if (!haveEnoughData) {
    return equipment.map(eq => ({
      equipmentId: eq.id,
      probabilityOfFailure30d: 0,
      probabilityOfFailure60d: 0,
      probabilityOfFailure90d: 0,
      estimatedDaysToNextFailure: null,
      confidenceLevel: 'low',
      factors: ['Not enough data for Layer 2 predictions (need ≥20 work orders)'],
    }));
  }

  // Fit Weibull per category from time-between-failures.
  const fitsByCategory = new Map<Equipment['category'], { shape: number; scale: number; n: number }>();
  for (const cat of CATEGORIES) {
    const eqInCat = equipment.filter(eq => eq.category === cat);
    const intervals: number[] = [];
    for (const eq of eqInCat) {
      const sorted = workOrders
        .filter(o => o.equipmentId === eq.id && o.createdAt)
        .map(o => o.createdAt!.getTime())
        .sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const days = (sorted[i] - sorted[i - 1]) / DAY_MS;
        if (days > 0.5) intervals.push(days); // drop noisy near-zero intervals
      }
    }
    if (intervals.length >= MIN_FAILURES_FOR_LAYER2) {
      fitsByCategory.set(cat, { ...fitWeibullMLE(intervals), n: intervals.length });
    }
  }

  // For each equipment, evaluate hazard at t = now - lastFailure.
  const now = Date.now();
  return equipment.map(eq => {
    const fit = fitsByCategory.get(eq.category);
    if (!fit) {
      return {
        equipmentId: eq.id,
        probabilityOfFailure30d: 0,
        probabilityOfFailure60d: 0,
        probabilityOfFailure90d: 0,
        estimatedDaysToNextFailure: null,
        confidenceLevel: 'low',
        factors: [`Insufficient ${eq.category} failure data — need ≥${MIN_FAILURES_FOR_LAYER2} intervals`],
      } as FailurePrediction;
    }
    const lastFailure = workOrders
      .filter(o => o.equipmentId === eq.id && o.createdAt)
      .map(o => o.createdAt!.getTime())
      .sort((a, b) => b - a)[0] ?? eq.installDate?.getTime() ?? eq.createdAt.getTime();
    const t = (now - lastFailure) / DAY_MS;

    // P(failure within Δ) = 1 - S(t+Δ)/S(t)  (conditional on surviving to t)
    const cond = (delta: number) => {
      const num = weibullSurvival(t + delta, fit.shape, fit.scale);
      const den = weibullSurvival(t, fit.shape, fit.scale);
      if (den <= 0) return 1;
      return Math.min(1, Math.max(0, 1 - num / den));
    };

    // Median residual life: solve S(t+Δ)/S(t) = 0.5 → Δ = scale*((-ln 0.5 + (t/scale)^k)^(1/k)) - t
    const tOverScale = t / fit.scale;
    const inner = Math.pow(tOverScale, fit.shape) + Math.log(2);
    const medianTotal = fit.scale * Math.pow(inner, 1 / fit.shape);
    const estimatedDaysToNextFailure = Math.max(0, medianTotal - t);

    const factors: string[] = [
      `${eq.category} Weibull fit (n=${fit.n}, shape=${fit.shape.toFixed(2)})`,
    ];
    if (eq.installDate && eq.expectedLifetimeYears) {
      const ageYears = (now - eq.installDate.getTime()) / DAY_MS / 365;
      if (ageYears / eq.expectedLifetimeYears > AGE_WARNING_PCT) factors.push('Age > 80% of expected lifetime');
    }

    return {
      equipmentId: eq.id,
      probabilityOfFailure30d: cond(30),
      probabilityOfFailure60d: cond(60),
      probabilityOfFailure90d: cond(90),
      estimatedDaysToNextFailure,
      confidenceLevel: fit.n >= 15 ? 'high' : fit.n >= 8 ? 'medium' : 'low',
      factors,
    } as FailurePrediction;
  });
}

/**
 * Repair-vs-replace using cumulative repair cost trajectory.
 * Fit a linear model to (time → cumulative cost), project 12 months out,
 * compare to replacement cost.
 */
export function repairVsReplace(
  equipment: Equipment[],
  workOrders: WorkOrder[],
): RepairReplaceRecommendation[] {
  const now = Date.now();
  const out: RepairReplaceRecommendation[] = [];
  for (const eq of equipment) {
    if (!eq.replacementCost || eq.replacementCost <= 0) continue;
    const orders = workOrders
      .filter(o => o.equipmentId === eq.id && o.repairCost != null && o.createdAt)
      .sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
    if (orders.length === 0) {
      out.push({
        equipmentId: eq.id,
        cumulativeRepairCost: 0,
        projectedNextYearRepairCost: 0,
        replacementCost: eq.replacementCost,
        recommendation: 'repair',
        reasoning: 'No repairs logged yet; continue normal maintenance.',
      });
      continue;
    }

    const cumulative = orders.reduce((s, o) => s + (o.repairCost ?? 0), 0);

    // Linear fit on (days since first repair, cumulative cost up to & including that point).
    const t0 = orders[0].createdAt!.getTime();
    let cumSoFar = 0;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const o of orders) {
      cumSoFar += o.repairCost ?? 0;
      xs.push((o.createdAt!.getTime() - t0) / DAY_MS);
      ys.push(cumSoFar);
    }
    const { slope, intercept } = linearRegression(xs, ys);
    const daysFromFirstNow = (now - t0) / DAY_MS;
    const projected12mFromNow = slope > 0
      ? Math.max(0, slope * (daysFromFirstNow + 365) + intercept - cumulative)
      : 0;

    const ratio = cumulative / eq.replacementCost;
    const projectedTotal = cumulative + projected12mFromNow;
    let recommendation: RepairReplaceRecommendation['recommendation'];
    let reasoning: string;
    if (ratio < 0.4) {
      recommendation = 'repair';
      reasoning = `Cumulative repair cost (${formatCurrencyShort(cumulative)}) is well below replacement cost. Continue repairing.`;
    } else if (ratio < 0.6) {
      recommendation = 'monitor';
      reasoning = `Repair spend at ${Math.round(ratio * 100)}% of replacement. Track closely; revisit in 30–60 days.`;
    } else if (ratio < 0.8 && slope > 0) {
      recommendation = 'plan_replacement';
      reasoning = `Repair spend at ${Math.round(ratio * 100)}% of replacement and trending up. Schedule replacement in next planned window.`;
    } else if (ratio >= 0.8 || projectedTotal > eq.replacementCost) {
      recommendation = 'replace_now';
      reasoning = ratio >= 0.8
        ? `Cumulative repairs have hit ${Math.round(ratio * 100)}% of replacement cost. Replace now.`
        : `Projected 12-month repair total (${formatCurrencyShort(projectedTotal)}) exceeds replacement cost. Replace now.`;
    } else {
      recommendation = 'monitor';
      reasoning = `Repair spend at ${Math.round(ratio * 100)}% of replacement; cost trajectory is flat.`;
    }

    // Break-even projection: when does cumulative cross replacement?
    let breakEvenDate: Date | undefined;
    if (slope > 0) {
      const daysToBreakEven = (eq.replacementCost - intercept) / slope - daysFromFirstNow;
      if (daysToBreakEven > 0 && daysToBreakEven < 365 * 5) {
        breakEvenDate = new Date(now + daysToBreakEven * DAY_MS);
      }
    }

    out.push({
      equipmentId: eq.id,
      cumulativeRepairCost: cumulative,
      projectedNextYearRepairCost: projected12mFromNow,
      replacementCost: eq.replacementCost,
      recommendation,
      reasoning,
      breakEvenDate,
    });
  }
  return out;
}

/**
 * Seasonal decomposition: per category, what's the 12-month pattern of
 * work-order frequency? Returns multipliers (1.0 = annual mean) and a
 * list of months whose count exceeds 1.5× the mean.
 */
export function seasonalPatterns(
  equipment: Equipment[],
  workOrders: WorkOrder[],
): SeasonalPattern[] {
  const eqById = new Map(equipment.map(e => [e.id, e]));
  const byCat = new Map<Equipment['category'], number[]>(); // month index 0-11
  for (const cat of CATEGORIES) byCat.set(cat, new Array(12).fill(0));

  for (const o of workOrders) {
    if (!o.createdAt || !o.equipmentId) continue;
    const eq = eqById.get(o.equipmentId);
    if (!eq) continue;
    const month = o.createdAt.getMonth();
    const arr = byCat.get(eq.category)!;
    arr[month] += 1;
  }

  const out: SeasonalPattern[] = [];
  for (const [cat, counts] of byCat) {
    const total = counts.reduce((s, v) => s + v, 0);
    if (total < 12) continue; // need at least one a month on average
    const mean = total / 12;
    const multipliers = counts.map(c => mean > 0 ? c / mean : 1);
    const spikeMonths: number[] = [];
    multipliers.forEach((m, i) => { if (m > 1.5) spikeMonths.push(i + 1); });
    out.push({ category: cat, monthlyMultipliers: multipliers, spikeMonths });
  }
  return out;
}

// ─── Layer 3 hooks (TODO: requires 6+ months of data) ──────────────────────

// TODO: Layer 3 — multi-factor XGBoost-style failure model
export function multifactorFailurePredictions(
  _features: MultifactorFailureFeatures[],
): FailurePrediction[] {
  // Placeholder. Wire to a Python service once we have cross-property data.
  return [];
}

// TODO: Layer 3 — optimal PM interval calculator
export function optimalPmIntervals(
  _equipment: Equipment[],
  _workOrders: WorkOrder[],
): OptimalPmInterval[] {
  return [];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const CATEGORIES: Equipment['category'][] = [
  'hvac', 'plumbing', 'electrical', 'appliance', 'structural',
  'elevator', 'pool', 'laundry', 'kitchen', 'other',
];

function formatCurrencyShort(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/**
 * Maximum-likelihood estimation of a Weibull(k, λ).
 *
 * MLE for Weibull doesn't have a closed form for k. Solve the score equation:
 *   sum(x_i^k * ln(x_i)) / sum(x_i^k)  -  1/k  -  mean(ln(x_i)) = 0
 *
 * with a few Newton iterations seeded from the moment estimator. Then
 * λ = (sum(x_i^k) / n)^(1/k).
 */
function fitWeibullMLE(samples: number[]): { shape: number; scale: number } {
  const n = samples.length;
  const lnX = samples.map(x => Math.log(x));
  const meanLnX = lnX.reduce((s, v) => s + v, 0) / n;

  // Seed with a method-of-moments-ish initial guess (CV-based).
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const cv = variance > 0 ? Math.sqrt(variance) / mean : 1;
  let k = Math.max(0.5, Math.min(10, 1 / cv)); // CV ≈ 1/k for shape near 1

  // Newton-Raphson on the score equation.
  for (let iter = 0; iter < 50; iter++) {
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const xk = Math.pow(samples[i], k);
      s0 += xk;
      s1 += xk * lnX[i];
      s2 += xk * lnX[i] * lnX[i];
    }
    if (s0 <= 0) break;
    const f = s1 / s0 - 1 / k - meanLnX;
    const dfdk = (s2 / s0) - (s1 * s1) / (s0 * s0) + 1 / (k * k);
    const step = f / dfdk;
    if (!isFinite(step) || Math.abs(step) < 1e-6) break;
    k = Math.max(0.1, Math.min(20, k - step));
  }

  let sumXk = 0;
  for (const x of samples) sumXk += Math.pow(x, k);
  const lambda = Math.pow(sumXk / n, 1 / k);
  return { shape: k, scale: lambda };
}

/**
 * Weibull survival function: S(t) = exp(-(t/λ)^k).
 */
function weibullSurvival(t: number, k: number, lambda: number): number {
  if (t <= 0) return 1;
  return Math.exp(-Math.pow(t / lambda, k));
}

/** Ordinary least-squares linear regression. Returns slope + intercept. */
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}
