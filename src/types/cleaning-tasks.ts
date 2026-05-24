/**
 * Cleaning task types — the Staxis-side notion of a cleaning task,
 * produced by the rules engine (src/lib/rules-engine/) from live PMS
 * data and stored in the cleaning_tasks table (migration 0210).
 *
 * One row per (property_id, room_number, business_date). Upserted by
 * the engine on (property_id, dedupe_key) for idempotency.
 */

export const CLEANING_TYPES = [
  'departure',
  'departure_deep',
  'stayover',
  'refresh',
  'deep',
  'room_check',
  'inspection_only',
  'no_clean',
] as const;
export type CleaningType = (typeof CLEANING_TYPES)[number];

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Numeric rank for priority comparison — higher number = more urgent. */
export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

export const TASK_STATUSES = [
  'scheduled',           // Created; room not yet ready (guest still in room)
  'ready_now',           // Room vacant/dirty — housekeeper can start
  'in_progress',
  'paused',
  'completed',
  'inspection_pending',
  'inspected_pass',
  'inspected_fail',
  'correction_pending',
  'correction_complete',
  'check_pending',
  'check_complete',
  'deferred',
  'skipped',
  'cancelled',
  'superseded',          // Replaced by a different cleaning_type after state change
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses the engine is allowed to overwrite. Once a human starts the
 *  task (in_progress) or any downstream state, the engine only refreshes
 *  last_evaluated_at and never clobbers the row. */
export const ENGINE_MUTABLE_STATUSES: ReadonlyArray<TaskStatus> = [
  'scheduled',
  'ready_now',
  'deferred',
  'skipped',
  'superseded',
];

export const TASK_EXTRAS = [
  'fruit_basket',
  'champagne',
  'welcome_amenity',
  'honeymoon_amenity',
  'anniversary_amenity',
  'baby_cot',
  'extra_bed',
  'pet_kit',
  'pet_clean_checklist',
  'supervisor_inspection',
  'safety_check',
  'amenity_setup',
] as const;
export type TaskExtra = (typeof TASK_EXTRAS)[number];

/** A single fired rule with its human-readable summary. Stored on each task. */
export interface RuleFiredEntry {
  id: string;
  summary: string;
}

export interface CleaningTask {
  id: string;
  property_id: string;
  room_number: string;
  business_date: string;
  dedupe_key: string;
  cleaning_type: CleaningType;
  priority: Priority;
  due_by: string | null;
  estimated_minutes: number | null;
  requires_inspection: boolean;
  extras: TaskExtra[];
  notes: string | null;
  rules_fired: RuleFiredEntry[];
  rule_inputs: Record<string, unknown> | null;
  status: TaskStatus;
  assignee_id: string | null;
  source_pms_reservation_id: string | null;
  source_engine_run_id: string | null;
  source_property_timezone: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  inspected_at: string | null;
  last_evaluated_at: string;
  created_at: string;
  updated_at: string;
}
