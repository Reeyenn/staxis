/**
 * Shared read-model helpers for the two manager-facing housekeeping views
 * — /api/housekeeping/board and /api/housekeeping/timeline.
 *
 * The routes stay separate on purpose (different payload shapes, different
 * blast radius), but three pieces were byte-identical between them and now
 * live here:
 *
 *   - toShadowAssignmentTask: wrap a cleaning_tasks row in a minimal
 *     AssignmentTask so both views reuse the engine's duration resolver
 *     and show the same minute totals the engine used at assignment time.
 *   - buildDurationConfig: the AssignmentConfig both views pass to
 *     resolveDurationMinutes (baseDurations overlays the property's
 *     manager-set Clean Times on the static defaults).
 *   - computeWorkloadByHk: per-housekeeper sum of NOT-YET-COMPLETED
 *     resolved minutes, so the board bar and the timeline row chip match.
 */

import {
  DEFAULT_BASE_DURATIONS,
  type AssignmentConfig,
  type AssignmentTask,
  type AssignmentTaskPriority,
} from '@/types/assignments';

/** The cleaning_tasks columns the shadow wrapper needs. */
export interface ShadowTaskInput {
  id: string;
  property_id: string;
  room_number: string;
  cleaning_type: string;
  priority: string;
  due_by: string | null;
  estimated_minutes: number | null;
  requires_inspection: boolean | null;
  extras: unknown;
}

/**
 * Wrap a cleaning_tasks row in a minimal AssignmentTask. Only the fields
 * resolveDurationMinutes / the read models care about are populated;
 * guest_language is null because these views don't score, they just
 * resolve durations.
 */
export function toShadowAssignmentTask(t: ShadowTaskInput): AssignmentTask {
  return {
    id: t.id,
    property_id: t.property_id,
    room_number: t.room_number,
    cleaning_type: t.cleaning_type,
    priority: (['urgent', 'high', 'normal', 'low'].includes(t.priority)
      ? t.priority
      : 'normal') as AssignmentTaskPriority,
    due_by: t.due_by,
    estimated_minutes: t.estimated_minutes,
    requires_inspection: t.requires_inspection === true,
    extras: Array.isArray(t.extras) ? (t.extras as string[]) : [],
    guest_language: null,
  };
}

/**
 * Build the AssignmentConfig both read models pass to
 * resolveDurationMinutes. baseDurations overlays the property's
 * manager-set Clean Times (migration 0244) on the static defaults, so
 * the fallback (used only when a task has no stored estimated_minutes)
 * reflects edited minutes. Only baseDurations is read downstream —
 * weights are irrelevant here.
 */
export function buildDurationConfig(opts: {
  shiftMinutes: number;
  cleanTimeBase: Record<string, number>;
}): AssignmentConfig {
  return {
    shiftMinutes: opts.shiftMinutes,
    baseDurations: { ...DEFAULT_BASE_DURATIONS, ...opts.cleanTimeBase },
    weights: {} as never,
    urgentWindowMinutes: 60,
  };
}

/** The per-task fields the workload sum needs. */
export interface WorkloadTask {
  assignee_id: string | null;
  status: string;
  estimated_minutes_resolved: number;
}

/**
 * Sum resolved minutes per housekeeper across NOT-YET-COMPLETED tasks.
 * Completed / cancelled / skipped tasks don't contribute — they've
 * already happened and would mislead the "still on plate" chart.
 */
export function computeWorkloadByHk(tasks: WorkloadTask[]): Map<string, number> {
  const workloadByHk = new Map<string, number>();
  for (const t of tasks) {
    if (!t.assignee_id) continue;
    const dead = t.status === 'completed' || t.status === 'cancelled' || t.status === 'skipped';
    if (dead) continue;
    const cur = workloadByHk.get(t.assignee_id) ?? 0;
    workloadByHk.set(t.assignee_id, cur + t.estimated_minutes_resolved);
  }
  return workloadByHk;
}
