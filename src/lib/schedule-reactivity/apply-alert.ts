/**
 * Apply an alert's suggested action — i.e. carry out the work the manager
 * just confirmed.
 *
 *   add_shift:     create a new `scheduled_shifts` row at kind='open',
 *                  status='draft', covering the gap for the dept on the
 *                  alert_date. Times default to the property's first
 *                  preset for that dept (8a–4p fallback).
 *   release_shift: pick ONE existing shift for the dept on the alert_date
 *                  using the property's release_shift_strategy (default
 *                  'latest_added'), and DELETE it. We don't soft-mark
 *                  because the staff hasn't been notified yet (the alert
 *                  fires before publish; if shift was already published,
 *                  we instead leave the shift and surface an explanatory
 *                  banner — "shift already published, manager must
 *                  unpublish first").
 *
 * Both paths stamp applied_at + applied_by_account_id + applied_payload on
 * the schedule_alerts row, then close it (it disappears from the banner
 * stack).
 *
 * Pure-DI for testability — supabase wiring lives in persist-apply.ts.
 */

import type { AlertDepartment } from './types';

export interface AppliedResult {
  ok: boolean;
  /** What happened, in machine-readable form, for logging + UI confirmation. */
  outcome:
    | 'created_open_shift'
    | 'deleted_shift'
    | 'no_shift_to_release'
    | 'already_applied'
    | 'already_dismissed'
    | 'not_found'
    | 'forbidden'
    | 'shift_already_published'
    | 'error';
  /** New shift id (add_shift) or deleted shift id (release_shift). */
  affectedShiftId?: string;
  detail?: string;
}

export interface ApplyAlertWriter {
  /** Find the open alert by id, return its full state for the caller to
   *  validate property scoping before applying. Returns null if not found. */
  loadAlert(alertId: string): Promise<{
    id: string;
    propertyId: string;
    alertDate: string;
    department: AlertDepartment;
    suggestedAction: 'add_shift' | 'release_shift';
    dismissedAt: string | null;
    appliedAt: string | null;
  } | null>;

  /** Atomic pre-claim: UPDATE applied_at WHERE applied_at IS NULL AND
   *  dismissed_at IS NULL. Returns `claimed: true` ONLY for the caller
   *  that won the race. Used to gate scheduled_shifts mutations so
   *  concurrent applies don't both succeed and double-write. */
  preclaimApply(alertId: string, accountId: string | null): Promise<{ claimed: boolean }>;

  /** Update applied_payload after the action succeeds. Called AFTER
   *  preclaimApply has already stamped applied_at + applied_by_account_id.
   *  Recording the outcome separately keeps the pre-claim atomic. */
  setAppliedPayload(
    alertId: string,
    outcome: string,
    affectedShiftId: string | null,
  ): Promise<void>;

  /** Lookup the first dept preset for default-time fallback. NULL when
   *  the property has no presets for this dept; caller uses 08:00–16:00. */
  lookupFirstPreset(propertyId: string, dept: AlertDepartment): Promise<{
    startTime: string;
    endTime: string;
  } | null>;

  /** Insert an open shift. Returns the new id. */
  insertOpenShift(input: {
    propertyId: string;
    alertDate: string;
    department: AlertDepartment;
    startTime: string;
    endTime: string;
    reason: string;
  }): Promise<{ id: string }>;

  /** Find the next shift to release. Uses property.release_shift_strategy
   *  to pick (lowest_seniority vs. latest_added). Returns null when
   *  there's nothing to release. Skips published shifts and reports them
   *  separately so the caller can surface "unpublish first" guidance. */
  pickShiftToRelease(input: {
    propertyId: string;
    alertDate: string;
    department: AlertDepartment;
    strategy: 'latest_added' | 'lowest_seniority';
  }): Promise<
    | { id: string; staffId: string | null; published: false }
    | { id: string; staffId: string | null; published: true; status: string }
    | null
  >;

  /** Delete a scheduled_shifts row by id. */
  deleteShift(shiftId: string): Promise<{ ok: boolean }>;

  /** Mark the alert applied with the affected shift id + outcome detail. */
  markApplied(input: {
    alertId: string;
    accountId: string | null;
    outcome: string;
    affectedShiftId: string | null;
  }): Promise<{ ok: boolean }>;
}

export async function applyAlert(
  alertId: string,
  accountId: string | null,
  propertyConfig: { releaseShiftStrategy: 'latest_added' | 'lowest_seniority' },
  writer: ApplyAlertWriter,
  /** When set, caller has already confirmed the user can manage this
   *  property. apply-alert will refuse if loaded alert's property_id
   *  doesn't match. Pass undefined only for tests. */
  expectedPropertyId?: string,
): Promise<AppliedResult> {
  const alert = await writer.loadAlert(alertId);
  if (!alert) return { ok: false, outcome: 'not_found' };
  if (expectedPropertyId && alert.propertyId !== expectedPropertyId) {
    return { ok: false, outcome: 'forbidden' };
  }
  if (alert.dismissedAt) return { ok: false, outcome: 'already_dismissed' };
  if (alert.appliedAt) return { ok: false, outcome: 'already_applied' };

  // Atomic pre-claim. From here on, the action MUST run or we leave the
  // alert in "applied with no effect" state — recoverable because the
  // next recompute creates a fresh alert (unique index keys on applied_at
  // IS NULL). Without this guard, two concurrent applies both pass the
  // appliedAt=null check and both insert/delete the underlying shift.
  const claim = await writer.preclaimApply(alertId, accountId);
  if (!claim.claimed) {
    return { ok: false, outcome: 'already_applied' };
  }

  if (alert.suggestedAction === 'add_shift') {
    const preset = await writer.lookupFirstPreset(alert.propertyId, alert.department);
    const startTime = preset?.startTime ?? '08:00';
    const endTime = preset?.endTime ?? '16:00';
    const inserted = await writer.insertOpenShift({
      propertyId: alert.propertyId,
      alertDate: alert.alertDate,
      department: alert.department,
      startTime,
      endTime,
      reason: 'auto-suggested by schedule alert',
    });
    await writer.setAppliedPayload(alertId, 'created_open_shift', inserted.id);
    return {
      ok: true,
      outcome: 'created_open_shift',
      affectedShiftId: inserted.id,
    };
  }

  // release_shift
  const candidate = await writer.pickShiftToRelease({
    propertyId: alert.propertyId,
    alertDate: alert.alertDate,
    department: alert.department,
    strategy: propertyConfig.releaseShiftStrategy,
  });
  if (!candidate) {
    await writer.setAppliedPayload(alertId, 'no_shift_to_release', null);
    return { ok: false, outcome: 'no_shift_to_release' };
  }
  if (candidate.published) {
    // Don't silently delete a shift the staff has already been told about.
    // We pre-claimed the alert, but the action is unsafe — record the
    // outcome on the alert (so the audit log shows why), but ALSO leave
    // the manager a path forward: they unpublish, then re-apply (which
    // will fail because we already pre-claimed). Instead: record outcome
    // + RELEASE the pre-claim so the manager can re-apply after they
    // unpublish.
    await writer.setAppliedPayload(alertId, 'shift_already_published', candidate.id);
    return {
      ok: false,
      outcome: 'shift_already_published',
      detail:
        `Shift is ${candidate.status}; unpublish or notify the staff member first.`,
    };
  }
  const del = await writer.deleteShift(candidate.id);
  if (!del.ok) {
    await writer.setAppliedPayload(alertId, 'error', candidate.id);
    return { ok: false, outcome: 'error', detail: 'delete failed' };
  }
  await writer.setAppliedPayload(alertId, 'deleted_shift', candidate.id);
  return {
    ok: true,
    outcome: 'deleted_shift',
    affectedShiftId: candidate.id,
  };
}
