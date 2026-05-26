/**
 * Top-level orchestrator: for a (property, date) — or a small date window
 * — compute Gaps across all alertable departments, turn each into a
 * Suggestion, and persist via the writer. Returns a summary the caller
 * (pms-changed route, cron handler, tests) can log + return as JSON.
 *
 * NOT a cron handler itself. The /api/internal/pms-changed route invokes
 * this; a future maintenance cron can too (e.g. nightly catch-up).
 */

import type {
  AlertDepartment, PropertyConfig, Suggestion, TriggerKind,
} from './types';
import { computeGapsForAllDepts, type ComputeGapReader } from './compute-gap';
import {
  suggestActionForGap,
  averageWageCentsPerHour as _avgWageStaff,
  DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR,
} from './suggest-action';
import { createAlertFromSuggestion, type ScheduleAlertWriter } from './create-alert';

void _avgWageStaff; // re-exported for tests; suppress lint

export interface RecomputeSummary {
  propertyId: string;
  alertDate: string;
  triggerKind: TriggerKind;
  gapsConsidered: number;
  suggestionsProduced: number;
  alertsCreated: number;
  alertsUpdated: number;
  suggestionsByDept: Record<AlertDepartment, Suggestion | null>;
}

export interface RecomputeOptions {
  triggerKind: TriggerKind;
  /** Average wage cents/hour to use for release_shift savings estimates.
   *  When null, the engine uses DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR
   *  ($14/hr) and tags context.wageDataPending=true. */
  wageCentsPerHourByDept: Partial<Record<AlertDepartment, number | null>>;
}

export async function recomputeAlerts(
  propertyId: string,
  alertDate: string,
  reader: ComputeGapReader,
  cfg: PropertyConfig,
  writer: ScheduleAlertWriter,
  opts: RecomputeOptions,
): Promise<RecomputeSummary> {
  const gaps = await computeGapsForAllDepts(propertyId, alertDate, reader);
  const suggestionsByDept: Record<AlertDepartment, Suggestion | null> = {
    housekeeping: null, front_desk: null, maintenance: null,
    breakfast: null, houseman: null, other: null,
  };
  let suggestionsProduced = 0;
  let alertsCreated = 0;
  let alertsUpdated = 0;

  for (const g of gaps) {
    const deptWage = opts.wageCentsPerHourByDept[g.department];
    const wage = (typeof deptWage === 'number' && deptWage > 0)
      ? deptWage
      : DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR;
    const wagePending = !(typeof deptWage === 'number' && deptWage > 0);

    const s = suggestActionForGap(g, cfg, {
      triggerKind: opts.triggerKind,
      wageCentsPerHour: wage,
    });
    if (!s) {
      suggestionsByDept[g.department] = null;
      continue;
    }
    if (wagePending) s.context = { ...s.context, wageDataPending: true };
    suggestionsByDept[g.department] = s;
    suggestionsProduced++;
    const r = await createAlertFromSuggestion(s, writer);
    if (r.created) alertsCreated++;
    else if (r.id) alertsUpdated++;
  }

  return {
    propertyId,
    alertDate,
    triggerKind: opts.triggerKind,
    gapsConsidered: gaps.length,
    suggestionsProduced,
    alertsCreated,
    alertsUpdated,
    suggestionsByDept,
  };
}
