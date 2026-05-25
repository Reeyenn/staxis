/**
 * Type definitions for the sick-callout coverage flow.
 *
 * Kept in a leaf file with no runtime imports so tests and the cua-service
 * worker can reuse these shapes without dragging Supabase into their bundle.
 */

export type CalloutReporter = 'self' | 'manager' | 'sms';
export type CalloutReason = 'sick' | 'family' | 'personal' | 'other';
export type CalloutLeaveTiming = 'now' | 'in_15_min' | 'after_current_room';
export type CalloutStatus = 'active' | 'reverted';

/**
 * One element of callout_events.impacted_assignments. Captured at the moment
 * we redistribute so the revert path knows exactly what to put back.
 *
 * task_status_at_redistribute is the status the cleaning_tasks row had at
 * redistribute-time. Combined with the CURRENT status at revert-time, the
 * revert path applies the rule: "if the new assignee already started the
 * task (status moved to in_progress or beyond), it STAYS with them; if
 * it's still scheduled/ready_now, return it to the original assignee."
 */
export interface ImpactedAssignment {
  task_id: string;
  room_number: string;
  original_assignee_id: string;
  redistributed_to: string | null;   // null = unassigned (no eligible HK)
  task_status_at_redistribute: string;
}

export interface RevertOutcomeEntry {
  task_id: string;
  room_number: string;
  returned_to_original: boolean;
  stayed_with: string | null;     // when returned_to_original=false, who kept it (null = unassigned)
  reason: 'returned' | 'already_started' | 'task_completed' | 'task_missing';
}

export interface CalloutEvent {
  id: string;
  property_id: string;
  staff_id: string;
  business_date: string;             // YYYY-MM-DD
  reported_at: string;               // ISO
  reported_by: CalloutReporter;
  reported_by_user_id: string | null;
  reason: CalloutReason | null;
  note: string | null;
  leave_timing: CalloutLeaveTiming | null;
  status: CalloutStatus;
  redistribute_at: string | null;    // ISO
  redistributed_at: string | null;   // ISO
  impacted_assignments: ImpactedAssignment[];
  reverted_at: string | null;
  reverted_by_user_id: string | null;
  reverted_by_staff_id: string | null;
  revert_reason: string | null;
  revert_outcome: RevertOutcomeEntry[] | null;
  created_at: string;
  updated_at: string;
}

/**
 * Manager-facing impact summary used by the CalloutBanner. One entry per
 * active callout. The pickups[] is built from impacted_assignments + a
 * staff lookup so the banner can render "Carlos +2, Lupe +3" without
 * the client having to join multiple tables itself.
 */
export interface CalloutBannerEntry {
  callout_id: string;
  staff_id: string;
  staff_name: string;
  reason: CalloutReason | null;
  reported_at: string;
  reported_by: CalloutReporter;
  redistributed_at: string | null;
  total_redistributed: number;
  /** Receiving HKs sorted by name, with how many they each picked up. */
  pickups: Array<{ staff_id: string | null; staff_name: string; count: number }>;
}
