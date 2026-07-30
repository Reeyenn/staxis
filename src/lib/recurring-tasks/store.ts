// ═══════════════════════════════════════════════════════════════════════════
// Recurring to-do templates — daily/weekly checklists that reappear.
//
// Backing tables: recurring_task_templates (migration 0303) + the additive
// comms_tasks.(recurring_template_id, recurring_instance_date) columns. Service-
// role only. The create_recurring_todo / stop_recurring_todo / list tools call
// the CRUD helpers; process-agent-schedules calls spawnDueRecurringTodos().
//
// A template SPAWNS a plain comms_tasks row each day it's due, so the existing
// to-do pane shows recurring instances exactly like any other task. Spawning is
// idempotent per (template, local day) via the unique partial index in 0303.
//
// Everything here uses supabaseAdmin (the tables are deny-all RLS).
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  assignmentBlockedReason,
  isAssignable,
  type AssignableStaffRow,
} from '@/lib/worklist/assignable';

export const RECURRING_DEPARTMENTS = ['front_desk', 'housekeeping', 'maintenance', 'general', 'all_staff'] as const;
export const RECURRING_CADENCES = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];
export type RecurringPriority = 'normal' | 'high' | 'urgent';

export interface CreateTemplateInput {
  propertyId: string;
  createdByStaffId: string | null;
  title: string;
  assignedStaffId?: string | null;
  assignedDepartment?: string | null;
  priority?: RecurringPriority;
  cadence: RecurringCadence;
  /** 0=Sun … 6=Sat. Required for 'weekly' and 'biweekly', ignored otherwise. */
  weekday?: number | null;
  /** 1..28. Required for 'monthly', ignored otherwise. */
  dayOfMonth?: number | null;
  /**
   * A property-local YYYY-MM-DD inside an ON week. Required for 'biweekly';
   * defaults to the day the template was created, which is what "every other
   * Tuesday starting this week" means to the person who typed it.
   */
  anchorDate?: string | null;
}

export interface TemplateRow {
  id: string;
  propertyId: string;
  title: string;
  assignedStaffId: string | null;
  assignedDepartment: string | null;
  priority: RecurringPriority;
  cadence: RecurringCadence;
  weekday: number | null;
  dayOfMonth: number | null;
  anchorDate: string | null;
  active: boolean;
  lastSpawnedOn: string | null;
  createdAt: string;
}

function mapRow(r: Record<string, unknown>): TemplateRow {
  return {
    id: r.id as string,
    propertyId: r.property_id as string,
    title: r.title as string,
    assignedStaffId: (r.assigned_staff_id as string | null) ?? null,
    assignedDepartment: (r.assigned_department as string | null) ?? null,
    priority: ((r.priority as string | null) ?? 'normal') as RecurringPriority,
    cadence: (r.cadence as RecurringCadence),
    weekday: r.weekday === null || r.weekday === undefined ? null : Number(r.weekday),
    dayOfMonth: r.day_of_month === null || r.day_of_month === undefined ? null : Number(r.day_of_month),
    anchorDate: (r.anchor_date as string | null) ?? null,
    active: (r.active as boolean | null) ?? true,
    lastSpawnedOn: (r.last_spawned_on as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/**
 * The parameters a cadence carries, normalized. Pure and exported because the
 * form door and the chat door both go through it, and "biweekly forgot its
 * anchor" must fail the same way for both rather than only at the database.
 */
export interface CadenceParams {
  weekday: number | null;
  dayOfMonth: number | null;
  anchorDate: string | null;
}

const YMD_RX = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeCadence(
  cadence: RecurringCadence,
  input: { weekday?: number | null; dayOfMonth?: number | null; anchorDate?: string | null },
  todayLocal: string,
): CadenceParams {
  const weekday = input.weekday ?? null;
  if (cadence === 'weekly' || cadence === 'biweekly') {
    if (weekday === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error('a weekly recurring to-do needs a weekday (0=Sunday … 6=Saturday)');
    }
  }
  if (cadence === 'monthly') {
    const dom = input.dayOfMonth ?? null;
    if (dom === null || !Number.isInteger(dom) || dom < 1 || dom > 28) {
      // 28 is the cap, not a typo: a monthly task set to the 31st would skip
      // seven months a year and nothing on screen would explain the silence.
      throw new Error('a monthly recurring to-do needs a day of the month between 1 and 28');
    }
    return { weekday: null, dayOfMonth: dom, anchorDate: null };
  }
  if (cadence === 'biweekly') {
    const anchor = input.anchorDate ?? todayLocal;
    if (!YMD_RX.test(anchor)) throw new Error('a biweekly recurring to-do needs a start date');
    return { weekday, dayOfMonth: null, anchorDate: anchor };
  }
  if (cadence === 'weekly') return { weekday, dayOfMonth: null, anchorDate: null };
  return { weekday: null, dayOfMonth: null, anchorDate: null };
}

/** Create a recurring template. Returns the new row id.
 *
 *  Guarded for the same reason createTask is, and more urgently: a template
 *  aimed at somebody who cannot see to-dos does not lose one task, it loses a
 *  fresh one every day until somebody notices, and nobody notices work that
 *  was never visible. */
export async function createTemplate(input: CreateTemplateInput): Promise<{ id: string }> {
  const blocked = await assignmentBlockedReason(input.propertyId, input.assignedStaffId);
  if (blocked) throw new Error(blocked);
  const cadence = input.cadence;
  const params = normalizeCadence(cadence, input, todayLocalIso());
  const { data, error } = await supabaseAdmin
    .from('recurring_task_templates')
    .insert({
      property_id: input.propertyId,
      created_by_staff_id: input.createdByStaffId,
      title: input.title,
      assigned_staff_id: input.assignedStaffId ?? null,
      assigned_department: input.assignedDepartment ?? null,
      priority: input.priority ?? 'normal',
      cadence,
      weekday: params.weekday,
      day_of_month: params.dayOfMonth,
      anchor_date: params.anchorDate,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

function todayLocalIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stop (deactivate) a template. Already-spawned tasks are left alone. Returns
 *  true when an active template was actually stopped. */
export async function stopTemplate(propertyId: string, templateId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('recurring_task_templates')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('property_id', propertyId)
    .eq('id', templateId)
    .eq('active', true)
    .select('id')
    .maybeSingle();
  return !!data;
}

/** List a property's ACTIVE recurring templates. */
export async function listActiveTemplates(propertyId: string, limit = 100): Promise<TemplateRow[]> {
  const { data, error } = await supabaseAdmin
    .from('recurring_task_templates')
    .select('*')
    .eq('property_id', propertyId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

/** Property-local YYYY-MM-DD + weekday (0=Sun … 6=Sat) for `now` in `tz`. */
function localDayParts(now: Date, tz: string): { date: string; weekday: number } {
  // en-CA gives YYYY-MM-DD; a separate weekday format gives the day name.
  let date: string;
  try {
    date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch {
    date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
  }
  // Derive weekday from the local Y-M-D at noon (avoids DST edge flips).
  const [y, m, d] = date.split('-').map((n) => Number(n));
  const weekday = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  return { date, weekday };
}

/** Whole days from the Unix epoch to a property-local YYYY-MM-DD. */
function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map((n) => Number(n));
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Is a template due to spawn on this property-local day?
 *
 * Exported and pure so every cadence can be driven over a run of fake days in a
 * test — "biweekly actually comes back a fortnight later" is not a claim any
 * amount of reading the insert path can settle.
 *
 * Biweekly is anchored rather than counted: the ON weeks are the ones an even
 * number of whole weeks away from `anchorDate`. Candidate days for a biweekly
 * template are exactly seven apart (the weekday has to match first), so the
 * parity alternates on its own and no bookkeeping column can drift. A template
 * that misses a fortnight because the cron was down comes back on the NEXT on
 * week, still on the same fortnight it always had.
 */
export function isTemplateDueOn(
  template: Pick<TemplateRow, 'cadence' | 'weekday' | 'dayOfMonth' | 'anchorDate'>,
  local: { date: string; weekday: number },
): boolean {
  switch (template.cadence) {
    case 'daily': return true;
    case 'weekdays': return local.weekday >= 1 && local.weekday <= 5; // Mon–Fri
    case 'weekly': return template.weekday === local.weekday;
    case 'biweekly': {
      if (template.weekday !== local.weekday) return false;
      if (!template.anchorDate) return false;
      const weeks = Math.floor((dayNumber(local.date) - dayNumber(template.anchorDate)) / 7);
      return ((weeks % 2) + 2) % 2 === 0;
    }
    case 'monthly': {
      if (template.dayOfMonth === null) return false;
      return Number(local.date.slice(8, 10)) === template.dayOfMonth;
    }
    default: return false;
  }
}

export interface SpawnResult {
  properties: number;
  spawned: number;
  skipped: number;
  failed: number;
}

/**
 * Spawn today's recurring to-do instances, once per property per local day.
 * Idempotent: the unique (recurring_template_id, recurring_instance_date) index
 * means a second call the same day inserts nothing (duplicate → swallowed). Safe
 * to call from the every-5-min process-agent-schedules cron.
 */
export async function spawnDueRecurringTodos(now: Date = new Date()): Promise<SpawnResult> {
  // Pull all active templates + their property's timezone in one pass. Small
  // scale today (one property); a join keeps it a single round trip.
  const { data, error } = await supabaseAdmin
    .from('recurring_task_templates')
    .select('id, property_id, title, assigned_staff_id, assigned_department, priority, cadence, weekday, day_of_month, anchor_date, active, last_spawned_on, created_at, properties(timezone)')
    .eq('active', true);
  if (error) {
    log.error('[recurring-tasks] spawn query failed', { err: error.message });
    throw new Error(`failed to load recurring task templates: ${error.message}`);
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Templates written before the assignee rule reached the write paths can
  // still point at somebody who never opens the to-do list. Left alone they
  // would keep manufacturing invisible work every single day, so those
  // instances spawn UNASSIGNED instead: an unassigned to-do sits on the shared
  // list, which is somewhere people actually look.
  const unassignable = await unassignableAssignees(rows);
  const propsSeen = new Set<string>();
  let spawned = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of rows) {
    const template = mapRow(raw);
    propsSeen.add(template.propertyId);
    // ── the Communications gate is gone, on purpose ────────────────────────
    // To-dos moved to the Staxis list; Communications is Messages now. Leaving
    // the old check here meant a hotel that switched off a messaging tab
    // silently stopped spawning its recurring work — and because spawning is
    // per-local-day, a skipped day never comes back. Gating on 'staxis'
    // instead would be the same bug wearing a different section name: a nav
    // toggle must not be able to cancel a hotel's standing work. Section
    // toggles govern what a hotel SEES, never what it may reach.
    const tz = ((raw.properties as { timezone?: string } | null)?.timezone) || 'America/Chicago';
    const { date, weekday } = localDayParts(now, tz);

    // Already spawned for this local day → nothing to do.
    if (template.lastSpawnedOn === date) { skipped += 1; continue; }
    if (!isTemplateDueOn(template, { date, weekday })) { skipped += 1; continue; }

    // Insert the instance stamped for idempotency. Do the stamped insert
    // DIRECTLY (not via createTask) so we can set the recurring_* columns and
    // rely on the unique index to swallow a duplicate.
    const nowIso = new Date().toISOString();
    const assignedStaffId = template.assignedStaffId && unassignable.has(template.assignedStaffId)
      ? null
      : template.assignedStaffId;
    if (assignedStaffId !== template.assignedStaffId) {
      log.warn('[recurring-tasks] template assignee cannot receive to-dos, spawning unassigned', {
        templateId: template.id,
      });
    }
    const { error: insErr } = await supabaseAdmin
      .from('comms_tasks')
      .insert({
        property_id: template.propertyId,
        title: template.title,
        assigned_staff_id: assignedStaffId,
        assigned_department: template.assignedDepartment,
        priority: template.priority,
        created_by_staff_id: null,
        recurring_template_id: template.id,
        recurring_instance_date: date,
        created_at: nowIso,
        updated_at: nowIso,
      });

    if (insErr) {
      // 23505 = duplicate on the unique index → already spawned by a racing
      // tick. Treat as a successful (idempotent) skip, and still advance the
      // bookkeeping so we don't retry every 5 minutes.
      if (insErr.code === '23505') {
        skipped += 1;
      } else {
        log.warn('[recurring-tasks] instance insert failed', { templateId: template.id, err: insErr.message });
        failed += 1;
        continue; // leave last_spawned_on so we retry next tick
      }
    } else {
      spawned += 1;
    }

    // Advance bookkeeping so the every-5-min cron doesn't re-spawn today.
    const { error: bookkeepingError } = await supabaseAdmin
      .from('recurring_task_templates')
      .update({ last_spawned_on: date, updated_at: nowIso })
      .eq('id', template.id);
    if (bookkeepingError) {
      failed += 1;
      log.warn('[recurring-tasks] bookkeeping update failed', {
        templateId: template.id,
        err: bookkeepingError.message,
      });
    }
  }

  return { properties: propsSeen.size, spawned, skipped, failed };
}

/**
 * Of the assignees these templates name, which ones may not receive a to-do.
 *
 * One batched read rather than one per template. FAILS CLOSED: if the staff
 * rows cannot be read, every named assignee is treated as unassignable, which
 * spawns the work onto the shared list. Losing the name is recoverable;
 * spawning onto a list nobody opens is not.
 */
async function unassignableAssignees(rows: Array<Record<string, unknown>>): Promise<Set<string>> {
  const ids = [...new Set(
    rows.map((r) => r.assigned_staff_id).filter((v): v is string => typeof v === 'string' && v.length > 0),
  )];
  if (ids.length === 0) return new Set<string>();

  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, department, is_active')
    .in('id', ids);
  if (error) {
    log.warn('[recurring-tasks] assignee check failed, spawning unassigned', { err: error.message });
    return new Set(ids);
  }
  const allowed = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (isAssignable(row as AssignableStaffRow)) allowed.add(String(row.id));
  }
  return new Set(ids.filter((id) => !allowed.has(id)));
}
