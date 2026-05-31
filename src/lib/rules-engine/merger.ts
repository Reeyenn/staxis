/**
 * Merger: combines multiple rule outputs into a single MergedTaskSpec,
 * then renders that into a row ready to upsert into cleaning_tasks.
 *
 * Composition rules:
 *   cleaning_type        — highest-ranked across all rule outputs
 *                          (departure_deep > departure > deep > stayover > refresh
 *                          > room_check > inspection_only > no_clean). Only ONE
 *                          base rule fires per room under normal conditions —
 *                          ranking is a tiebreaker for the rare overlap.
 *   priority             — strongest across rules (urgent > high > normal > low).
 *   due_by               — earliest across rules.
 *   estimated_minutes    — base (from the winning cleaning_type) + sum of deltas.
 *   requires_inspection  — logical OR.
 *   extras               — union, de-duped.
 *   notes                — concatenated with "; ".
 *   status               — derived from current room status: vacant_dirty after a
 *                          departure ⇒ ready_now; everything else ⇒ scheduled.
 */

import { randomUUID } from 'node:crypto';

import type {
  CleaningType,
  Priority,
  TaskExtra,
  TaskStatus,
  RuleFiredEntry,
} from '@/types/cleaning-tasks';
import { PRIORITY_RANK } from '@/types/cleaning-tasks';

import {
  resolveStandardMinutes,
  type CleanTimeStandardsIndex,
} from '@/lib/clean-time-standards';

import { BASE_DURATION_MIN } from './constants';
import type { RoomContext, RuleFireResult } from './types';

/** Higher rank = "more work" — wins when multiple base rules fire. */
const CLEANING_TYPE_RANK: Record<CleaningType, number> = {
  departure_deep: 7,
  departure: 6,
  deep: 5,
  stayover: 4,
  refresh: 3,
  room_check: 2,
  inspection_only: 1,
  no_clean: 0,
};

export interface MergedTaskSpec {
  cleaning_type: CleaningType;
  priority: Priority;
  due_by: Date | null;
  estimated_minutes: number;
  requires_inspection: boolean;
  extras: TaskExtra[];
  notes: string | null;
  status: TaskStatus;
  rules_fired: RuleFiredEntry[];
}

export function mergePartials(
  fires: RuleFireResult[],
  ctx: RoomContext,
  /**
   * Per-property manager-set base minutes (Clean Times, migration 0244).
   * When supplied, the table value for the winning cleaning_type wins over
   * both the rule-supplied base and the static default. Omit it (e.g. in unit
   * tests, or when a property has no standards yet) to keep the legacy
   * rule-base / BASE_DURATION_MIN behaviour unchanged.
   */
  baseIndex?: CleanTimeStandardsIndex,
): MergedTaskSpec | null {
  if (fires.length === 0) return null;

  let cleaningType: CleaningType | null = null;
  let ruleBase: number | null = null;

  for (const f of fires) {
    const t = f.partial.cleaning_type;
    if (!t) continue;
    if (cleaningType === null || CLEANING_TYPE_RANK[t] > CLEANING_TYPE_RANK[cleaningType]) {
      cleaningType = t;
      ruleBase = f.partial.estimated_minutes_base ?? null;
    }
  }
  if (cleaningType === null) return null;

  // Base-minutes precedence:
  //   1. Manager-set Clean Times standard for this cleaning_type (a
  //      room_type-specific row wins over the all-rooms row).
  //   2. The base the winning rule supplied (legacy behaviour).
  //   3. The static BASE_DURATION_MIN default for the type + room size.
  // Step 1 is skipped when no baseIndex is passed or the property has no
  // matching row, so existing behaviour is preserved exactly.
  const tableBase = baseIndex
    ? resolveStandardMinutes(baseIndex, cleaningType, ctx.room_type)
    : undefined;
  let baseMinutes: number;
  if (tableBase != null) {
    baseMinutes = tableBase;
  } else if (ruleBase != null) {
    baseMinutes = ruleBase;
  } else {
    const tbl = BASE_DURATION_MIN[cleaningType];
    baseMinutes = ctx.is_suite ? tbl.suite : tbl.standard;
  }

  const minutesDelta = fires.reduce(
    (sum, f) => sum + (f.partial.estimated_minutes_delta ?? 0),
    0,
  );

  let priority: Priority = 'normal';
  for (const f of fires) {
    const p = f.partial.priority;
    if (!p) continue;
    if (PRIORITY_RANK[p] > PRIORITY_RANK[priority]) priority = p;
  }

  let dueBy: Date | null = null;
  for (const f of fires) {
    const d = f.partial.due_by;
    if (!d) continue;
    if (dueBy === null || d.getTime() < dueBy.getTime()) dueBy = d;
  }

  const requiresInspection = fires.some((f) => f.partial.requires_inspection === true);

  const extras: TaskExtra[] = Array.from(
    new Set(fires.flatMap((f) => f.partial.extras ?? [])),
  );

  const notesList = fires.flatMap((f) => f.partial.notes ?? []);
  const notes = notesList.length ? notesList.join('; ') : null;

  // Status: a departure clean on a vacant_dirty room can start immediately.
  // Everything else is scheduled until further notice.
  const isDeparture = cleaningType === 'departure' || cleaningType === 'departure_deep';
  const status: TaskStatus =
    isDeparture && ctx.current_status === 'vacant_dirty' ? 'ready_now' : 'scheduled';

  return {
    cleaning_type: cleaningType,
    priority,
    due_by: dueBy,
    estimated_minutes: Math.max(0, baseMinutes + minutesDelta),
    requires_inspection: requiresInspection,
    extras,
    notes,
    status,
    rules_fired: fires.map((f) => ({ id: f.id, summary: f.summary })),
  };
}

/** Row shape we hand to supabaseAdmin.from('cleaning_tasks').upsert(...). */
export interface CleaningTaskUpsertRow {
  property_id: string;
  room_number: string;
  business_date: string;
  dedupe_key: string;
  cleaning_type: CleaningType;
  priority: Priority;
  due_by: string | null;
  estimated_minutes: number;
  requires_inspection: boolean;
  extras: TaskExtra[];
  notes: string | null;
  rules_fired: RuleFiredEntry[];
  rule_inputs: Record<string, unknown>;
  status: TaskStatus;
  source_pms_reservation_id: string | null;
  source_engine_run_id: string;
  source_property_timezone: string;
  scheduled_at: string;
  last_evaluated_at: string;
}

/** Build the upsert row. The `engineRunId` ties all rows produced by a
 *  single engine invocation together — useful for debugging which rules
 *  fired when and which property's run produced which tasks. */
export function contextToTaskRow(
  ctx: RoomContext,
  spec: MergedTaskSpec,
  engineRunId: string,
): CleaningTaskUpsertRow {
  const sourcePmsId =
    ctx.departing?.pms_reservation_id ??
    ctx.arriving?.pms_reservation_id ??
    ctx.staying?.pms_reservation_id ??
    null;

  const nowIso = ctx.property.now_utc.toISOString();

  return {
    property_id: ctx.property.property_id,
    room_number: ctx.room_number,
    business_date: ctx.property.business_date,
    dedupe_key: `${ctx.room_number}::${ctx.property.business_date}`,
    cleaning_type: spec.cleaning_type,
    priority: spec.priority,
    due_by: spec.due_by ? spec.due_by.toISOString() : null,
    estimated_minutes: spec.estimated_minutes,
    requires_inspection: spec.requires_inspection,
    extras: spec.extras,
    notes: spec.notes,
    rules_fired: spec.rules_fired,
    rule_inputs: sanitizeContextForStorage(ctx),
    status: spec.status,
    source_pms_reservation_id: sourcePmsId,
    source_engine_run_id: engineRunId,
    source_property_timezone: ctx.property.property_timezone,
    scheduled_at: nowIso,
    last_evaluated_at: nowIso,
  };
}

/** PII filter for rule_inputs storage. Strips guest names, contact info,
 *  free-text notes — keeps loyalty tier, language, and the structural
 *  flags rules need to explain themselves. */
function sanitizeContextForStorage(ctx: RoomContext): Record<string, unknown> {
  return {
    room_type: ctx.room_type,
    is_suite: ctx.is_suite,
    pet_friendly: ctx.pet_friendly,
    current_status: ctx.current_status,
    status_changed_at: ctx.status_changed_at,
    day_of_week: ctx.property.day_of_week,
    departing: ctx.departing
      ? {
          pms_reservation_id: ctx.departing.pms_reservation_id,
          num_nights: ctx.departing.num_nights,
          late_checkout_approved: ctx.departing.late_checkout_approved,
          late_checkout_until: ctx.departing.late_checkout_until,
          actual_checkout_at: ctx.departing.actual_checkout_at,
          is_vip: ctx.departing.is_vip,
          has_pet: ctx.departing.has_pet,
        }
      : null,
    arriving: ctx.arriving
      ? {
          pms_reservation_id: ctx.arriving.pms_reservation_id,
          arrival_time: ctx.arriving.arrival_time,
          early_checkin_approved: ctx.arriving.early_checkin_approved,
          early_checkin_from: ctx.arriving.early_checkin_from,
          is_vip: ctx.arriving.is_vip,
          loyalty_tier: ctx.arriving.loyalty_tier,
          language: ctx.arriving.language,
          has_pet: ctx.arriving.has_pet,
          adults: ctx.arriving.adults,
          children: ctx.arriving.children,
          infants: ctx.arriving.infants,
          has_baby_cot: ctx.arriving.has_baby_cot,
          has_extra_bed: ctx.arriving.has_extra_bed,
          has_early_checkin_request: ctx.arriving.has_early_checkin_request,
        }
      : null,
    staying: ctx.staying
      ? {
          pms_reservation_id: ctx.staying.pms_reservation_id,
          arrival_date: ctx.staying.arrival_date,
          departure_date: ctx.staying.departure_date,
          num_nights: ctx.staying.num_nights,
          day_of_stay: ctx.staying.day_of_stay,
          is_vip: ctx.staying.is_vip,
          loyalty_tier: ctx.staying.loyalty_tier,
          language: ctx.staying.language,
          has_pet: ctx.staying.has_pet,
          eco_stay_opt_in: ctx.staying.eco_stay_opt_in,
          dnd_active: ctx.staying.dnd_active,
          nsr_active: ctx.staying.nsr_active,
        }
      : null,
    pms_hk_assignment: ctx.pms_hk_assignment,
  };
}

/** Generate a fresh engine-run id. Wrapped so tests can stub it. */
export function newEngineRunId(): string {
  return randomUUID();
}
