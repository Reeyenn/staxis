/**
 * Shared types for the schedule-reactivity engine.
 *
 * The engine runs in two contexts:
 *   1. Recurring cron / cua-service ping — for every relevant
 *      (property, date, department) it computes a Gap and may create or
 *      update a schedule_alerts row.
 *   2. UI banner read — manager-facing API maps DB rows to the same
 *      Alert shape the engine writes, so the UI doesn't have to know
 *      about the DB column layout.
 *
 * Everything in this module is pure / DI-friendly so unit tests don't
 * touch Supabase.
 */

export type AlertDepartment =
  | 'housekeeping'
  | 'front_desk'
  | 'maintenance'
  | 'breakfast'
  | 'houseman'
  | 'other';

export type Severity = 'yellow' | 'red';
export type SuggestedAction = 'add_shift' | 'release_shift';

export type TriggerKind =
  | 'arrival_surge'
  | 'cancellation_wave'
  | 'vip_added'
  | 'status_flip'
  | 'manual_recompute'
  | 'cron_recompute';

/** Output of compute-gap for a single (property, date, dept). */
export interface Gap {
  propertyId: string;
  alertDate: string;        // YYYY-MM-DD
  department: AlertDepartment;
  /** Total minutes the demand model says this dept needs on this date. */
  demandMinutes: number;
  /** Total minutes currently scheduled (kind='shift', not declined). */
  scheduledMinutes: number;
  /** demandMinutes - scheduledMinutes. >0 = understaffed. <0 = overstaffed. */
  gapMinutes: number;
  /** Free-form context the suggest-action layer will pass through into
   *  schedule_alerts.context.jsonb so the UI can render explainers. */
  context: Record<string, unknown>;
}

/** Output of suggest-action: a fully-described would-be alert, or null. */
export interface Suggestion {
  propertyId: string;
  alertDate: string;
  department: AlertDepartment;
  severity: Severity;
  suggestedAction: SuggestedAction;
  gapMinutes: number;
  demandMinutes: number;
  scheduledMinutes: number;
  /** Only present for release_shift. */
  suggestedSavingsCents?: number;
  triggerKind: TriggerKind;
  context: Record<string, unknown>;
}

/** Property-level config the suggest-action layer needs. */
export interface PropertyConfig {
  gapAlertThresholdMinutes: number;   // default 60
  gapAlertRedPct: number;             // default 0.20
  releaseShiftStrategy: 'latest_added' | 'lowest_seniority';
  frontDeskCoverageHours: number | null;
  maintenanceShiftsPerDay: number | null;
  housemanShiftsPerDay: number | null;
  breakfastWindowStart: string | null;  // 'HH:MM' or 'HH:MM:SS'
  breakfastWindowEnd: string | null;
  shiftMinutes: number | null;  // default-shift length (8h)
}
