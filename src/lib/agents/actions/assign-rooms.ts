// ─── Action: assign_rooms ───────────────────────────────────────────────────
// Wraps the PURE assignTasks() scoring engine. execute() is self-contained
// (mirrors run-auto-assign/runForProperty): load the day's unassigned
// cleaning_tasks + the housekeeping roster, score, and persist hk_assignments.
// describe() is pure (no I/O) — it states intent for the dry-run receipt.
//
// Payload accepts an optional { floors } filter — a designed extension point
// so a future template can scope the run without reshaping the schema.

import { registerAction } from './registry';
import { persistAssignmentDecisions } from './persist-assignments';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  assignTasks,
  makeAssignmentConfig,
  type AssignmentTask,
  type AssignmentHousekeeper,
  type AssignmentTaskPriority,
} from '@/lib/assignment-engine';
import { fetchCleanTimeBaseDurations } from '@/lib/clean-time-standards-server';
import { validateArray, validateInt } from '@/lib/api-validate';
import type { AgentActionContext, AgentActionResult } from '@/lib/agents/types';

interface AssignRoomsPayload {
  floors?: number[];
}

const AUTO_ASSIGNABLE_STATUSES = ['scheduled', 'ready_now', 'deferred'] as const;

/** Best-effort floor of a room number (leading numeric component). Returns
 *  null when it can't tell, in which case the floors filter keeps the task. */
function roomFloor(roomNumber: string): number | null {
  const digits = (roomNumber.match(/\d+/)?.[0]) ?? '';
  if (!digits) return null;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return null;
  return n >= 100 ? Math.floor(n / 100) : n < 10 ? n : Math.floor(n / 10);
}

function rowToTask(t: Record<string, unknown>): AssignmentTask {
  const allowed: Record<string, AssignmentTaskPriority> = {
    urgent: 'urgent', high: 'high', normal: 'normal', low: 'low',
  };
  const priority = allowed[String(t.priority)] ?? 'normal';
  const extrasArr = Array.isArray(t.extras) ? (t.extras as unknown[]) : [];
  const ri = (t.rule_inputs as Record<string, unknown> | null) ?? {};
  const lang = typeof ri.guest_language === 'string' ? ri.guest_language : null;
  return {
    id: String(t.id),
    property_id: String(t.property_id),
    room_number: String(t.room_number),
    cleaning_type: String(t.cleaning_type),
    priority,
    due_by: (t.due_by as string | null) ?? null,
    estimated_minutes: (t.estimated_minutes as number | null) ?? null,
    requires_inspection: t.requires_inspection === true,
    extras: extrasArr.filter((x): x is string => typeof x === 'string'),
    guest_language: lang === 'es' ? 'es' : lang === 'en' ? 'en' : null,
  };
}

function rowToHk(s: Record<string, unknown>, todayDate: string): AssignmentHousekeeper {
  const vac = (s.vacation_dates as string[] | null) ?? [];
  return {
    id: String(s.id),
    name: String(s.name ?? ''),
    language: s.language === 'es' ? 'es' : 'en',
    isSenior: s.is_senior === true,
    isActive: s.is_active !== false,
    homeFloor: null,
    weeklyHours: (s.weekly_hours as number | null) ?? 0,
    maxWeeklyHours: (s.max_weekly_hours as number | null) ?? 40,
    isOutToday: vac.includes(todayDate) || s.scheduled_today === false,
  };
}

async function computeAndAssign(
  propertyId: string,
  date: string,
  floors: number[] | undefined,
): Promise<{ placed: number; unassigned: number; conflicts: number; failures: number; reason?: string }> {
  // 1. Today's auto-assignable tasks.
  const { data: taskRows, error: taskErr } = await supabaseAdmin
    .from('cleaning_tasks')
    .select('id, property_id, room_number, cleaning_type, priority, due_by, estimated_minutes, requires_inspection, extras, rule_inputs, status')
    .eq('property_id', propertyId)
    .eq('business_date', date)
    .in('status', AUTO_ASSIGNABLE_STATUSES);
  if (taskErr) throw new Error(`load tasks: ${taskErr.message}`);
  let allTasks = (taskRows ?? []) as Record<string, unknown>[];

  if (floors && floors.length > 0) {
    const set = new Set(floors);
    allTasks = allTasks.filter((t) => {
      const f = roomFloor(String(t.room_number));
      return f === null || set.has(f);
    });
  }
  if (allTasks.length === 0) {
    return { placed: 0, unassigned: 0, conflicts: 0, failures: 0, reason: 'no tasks for this day' };
  }

  // 2. Filter out tasks that already have an active assignment (idempotency).
  const { data: existing, error: exErr } = await supabaseAdmin
    .from('hk_assignments')
    .select('cleaning_task_id')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .in('cleaning_task_id', allTasks.map((t) => String(t.id)));
  if (exErr) throw new Error(`load existing assignments: ${exErr.message}`);
  const taken = new Set((existing ?? []).map((r) => r.cleaning_task_id as string));
  const toPlace = allTasks.filter((t) => !taken.has(String(t.id)));
  if (toPlace.length === 0) {
    return { placed: 0, unassigned: 0, conflicts: 0, failures: 0, reason: 'all tasks already assigned' };
  }

  // 3. Housekeeping roster.
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, language, is_senior, is_active, scheduled_today, department, weekly_hours, max_weekly_hours, vacation_dates')
    .eq('property_id', propertyId)
    .eq('department', 'housekeeping');
  if (staffErr) throw new Error(`load staff: ${staffErr.message}`);
  const hks = ((staffRows ?? []) as Record<string, unknown>[])
    .map((s) => rowToHk(s, date))
    .filter((h) => h.isActive && !h.isOutToday);
  if (hks.length === 0) {
    return { placed: 0, unassigned: toPlace.length, conflicts: 0, failures: 0, reason: 'no housekeepers working' };
  }

  // 4. Score + persist.
  const baseDurations = await fetchCleanTimeBaseDurations(propertyId);
  const cfg = makeAssignmentConfig({ baseDurations });
  const result = assignTasks(toPlace.map(rowToTask), hks, cfg);
  const persisted = await persistAssignmentDecisions(propertyId, result.decisions);

  return {
    placed: persisted.placed,
    unassigned: result.unassigned.length + persisted.failures,
    conflicts: persisted.conflicts,
    failures: persisted.failures,
  };
}

registerAction<AssignRoomsPayload>({
  key: 'assign_rooms',
  label: { en: 'Assign rooms to housekeepers', es: 'Asignar habitaciones a las recamareras' },
  inputSchema: {
    type: 'object',
    properties: {
      floors: { type: 'array', items: { type: 'integer' }, description: 'Optional: only assign rooms on these floors' },
    },
  },
  spendsMoney: false,
  contactsGuest: false,
  validate(raw: unknown): { error?: string; value?: AssignRoomsPayload } {
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (body.floors === undefined || body.floors === null) return { value: {} };
    const arr = validateArray<number>(body.floors, { max: 50, label: 'floors' });
    if (arr.error) return { error: arr.error };
    const floors: number[] = [];
    for (const f of arr.value ?? []) {
      const iv = validateInt(f, { min: -5, max: 200, label: 'floor' });
      if (iv.error) return { error: iv.error };
      floors.push(iv.value!);
    }
    return { value: { floors } };
  },
  async execute(payload: AssignRoomsPayload, ctx: AgentActionContext): Promise<AgentActionResult> {
    try {
      const r = await computeAndAssign(ctx.propertyId, ctx.asOfDate, payload.floors);
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  describe(payload: AssignRoomsPayload, ctx: AgentActionContext) {
    const floorsEn = payload.floors?.length ? ` on floor(s) ${payload.floors.join(', ')}` : '';
    const floorsEs = payload.floors?.length ? ` en el/los piso(s) ${payload.floors.join(', ')}` : '';
    return {
      key: 'agents.action.assign_rooms.describe',
      params: { date: ctx.asOfDate, floors: payload.floors ?? [] },
      en: `Would assign the unassigned rooms for ${ctx.asOfDate}${floorsEn} to the housekeepers on shift, using the scoring engine.`,
      es: `Asignaría las habitaciones sin asignar del ${ctx.asOfDate}${floorsEs} a las recamareras de turno, usando el motor de puntuación.`,
    };
  },
});
