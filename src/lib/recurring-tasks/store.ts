// ═══════════════════════════════════════════════════════════════════════════
// Recurring to-do templates — daily/weekly checklists that reappear.
//
// Backing tables: recurring_task_templates (migration 0303) + the additive
// comms_tasks.(recurring_template_id, recurring_instance_date) columns. Service-
// role only. The create_recurring_todo / stop_recurring_todo / list tools call
// the CRUD helpers; the process-sms-jobs cron calls spawnDueRecurringTodos().
//
// A template SPAWNS a plain comms_tasks row each day it's due, so the existing
// to-do pane shows recurring instances exactly like any other task. Spawning is
// idempotent per (template, local day) via the unique partial index in 0303.
//
// Everything here uses supabaseAdmin (the tables are deny-all RLS).
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export const RECURRING_DEPARTMENTS = ['front_desk', 'housekeeping', 'maintenance', 'general'] as const;
export const RECURRING_CADENCES = ['daily', 'weekdays', 'weekly'] as const;
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
  /** 0=Sun … 6=Sat. Required for cadence='weekly', ignored otherwise. */
  weekday?: number | null;
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
    active: (r.active as boolean | null) ?? true,
    lastSpawnedOn: (r.last_spawned_on as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Create a recurring template. Returns the new row id. */
export async function createTemplate(input: CreateTemplateInput): Promise<{ id: string }> {
  const cadence = input.cadence;
  const weekday = cadence === 'weekly' ? (input.weekday ?? null) : null;
  if (cadence === 'weekly' && (weekday === null || weekday < 0 || weekday > 6)) {
    throw new Error('a weekly recurring to-do needs a weekday (0=Sunday … 6=Saturday)');
  }
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
      weekday,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
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

/** Is a template due to spawn on the given local weekday? */
function isDueOn(template: TemplateRow, weekday: number): boolean {
  switch (template.cadence) {
    case 'daily': return true;
    case 'weekdays': return weekday >= 1 && weekday <= 5; // Mon–Fri
    case 'weekly': return template.weekday === weekday;
    default: return false;
  }
}

export interface SpawnResult {
  properties: number;
  spawned: number;
  skipped: number;
}

/**
 * Spawn today's recurring to-do instances, once per property per local day.
 * Idempotent: the unique (recurring_template_id, recurring_instance_date) index
 * means a second call the same day inserts nothing (duplicate → swallowed). Safe
 * to call from the every-5-min cron. Called from the process-sms-jobs tick.
 */
export async function spawnDueRecurringTodos(now: Date = new Date()): Promise<SpawnResult> {
  // Pull all active templates + their property's timezone in one pass. Small
  // scale today (one property); a join keeps it a single round trip.
  const { data, error } = await supabaseAdmin
    .from('recurring_task_templates')
    .select('id, property_id, title, assigned_staff_id, assigned_department, priority, cadence, weekday, active, last_spawned_on, created_at, properties(timezone)')
    .eq('active', true);
  if (error) {
    log.error('[recurring-tasks] spawn query failed', { err: error.message });
    return { properties: 0, spawned: 0, skipped: 0 };
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const propsSeen = new Set<string>();
  let spawned = 0;
  let skipped = 0;

  for (const raw of rows) {
    const template = mapRow(raw);
    propsSeen.add(template.propertyId);
    const tz = ((raw.properties as { timezone?: string } | null)?.timezone) || 'America/Chicago';
    const { date, weekday } = localDayParts(now, tz);

    // Already spawned for this local day → nothing to do.
    if (template.lastSpawnedOn === date) { skipped += 1; continue; }
    if (!isDueOn(template, weekday)) { skipped += 1; continue; }

    // Insert the instance stamped for idempotency. Do the stamped insert
    // DIRECTLY (not via createTask) so we can set the recurring_* columns and
    // rely on the unique index to swallow a duplicate.
    const nowIso = new Date().toISOString();
    const { error: insErr } = await supabaseAdmin
      .from('comms_tasks')
      .insert({
        property_id: template.propertyId,
        title: template.title,
        assigned_staff_id: template.assignedStaffId,
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
        continue; // leave last_spawned_on so we retry next tick
      }
    } else {
      spawned += 1;
    }

    // Advance bookkeeping so the every-5-min cron doesn't re-spawn today.
    await supabaseAdmin
      .from('recurring_task_templates')
      .update({ last_spawned_on: date, updated_at: nowIso })
      .eq('id', template.id);
  }

  return { properties: propsSeen.size, spawned, skipped };
}
