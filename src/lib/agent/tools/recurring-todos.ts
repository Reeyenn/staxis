// ─── Recurring to-do tools ─────────────────────────────────────────────────
//
// Daily/weekly checklists that reappear as normal to-dos. Backed by
// recurring_task_templates (migration 0303) + src/lib/recurring-tasks/store.ts.
// The process-agent-schedules cron materializes each due active template
// into a plain comms_tasks row, so the to-do pane shows recurring instances
// exactly like any other task.
//
//   create_recurring_todo — MUTATION (card): define a recurring checklist item.
//   stop_recurring_todo   — MUTATION (card): stop future spawns of a template.
//   list_recurring_todos  — READ: the active recurring templates.
//
// Template management UI is out of scope — the assistant is the only manager.
// Manager-tier (admin/owner/general_manager), matching the other schedule/comms
// management actions. Attributed to the caller when linked (created_by_staff_id).
//
// ADDITIVE + self-registering — add `import './recurring-todos';` to index.ts.

import { registerTool, type ToolResult, type ToolContext } from '../tools';
import {
  createTemplate,
  stopTemplate,
  listActiveTemplates,
  RECURRING_DEPARTMENTS,
  RECURRING_CADENCES,
  type RecurringCadence,
  type RecurringPriority,
} from '@/lib/recurring-tasks/store';
import { resolveStaffByName } from './_helpers';

const PRIORITIES = ['normal', 'high', 'urgent'] as const;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Parse a weekday from a name or a number (0=Sun … 6=Sat). null if unreadable. */
function parseWeekday(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= 6) return input;
  const s = String(input).trim().toLowerCase();
  if (/^[0-6]$/.test(s)) return Number(s);
  const idx = WEEKDAY_NAMES.findIndex((d) => d.toLowerCase() === s || d.toLowerCase().startsWith(s));
  return idx >= 0 ? idx : null;
}

// ─── create_recurring_todo ─────────────────────────────────────────────────

interface CreateRecurringTodoArgs {
  title: string;
  cadence: string;
  weekday?: string | number;
  assignee?: string;
  department?: string;
  priority?: string;
}

registerTool<CreateRecurringTodoArgs>({
  name: 'create_recurring_todo',
  description:
    'Create a recurring to-do — a checklist item that reappears on the shared to-do list on a schedule. ' +
    'Use for "every morning, check the pool chemicals", "every Monday deep-clean the lobby", "cada día, revisar el desayuno". ' +
    'title = what the task says. cadence is "daily", "weekdays" (Mon–Fri), or "weekly"; for weekly, give weekday (a day name like "Monday" or 0–6 with 0=Sunday). ' +
    'Optionally assign it to a person (assignee, by name) or a department (front_desk/housekeeping/maintenance/general), and set priority (normal/high/urgent). ' +
    'A fresh to-do is spawned each day it\'s due; the manager checks it off like any other task.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the recurring task says. Max 200 chars.' },
      cadence: { type: 'string', enum: [...RECURRING_CADENCES], description: 'daily, weekdays (Mon–Fri), or weekly.' },
      weekday: { type: 'string', description: 'For weekly cadence — the day, e.g. "Monday" or 0–6 (0=Sunday).' },
      assignee: { type: 'string', description: 'Optional staff member to assign it to, by name.' },
      department: { type: 'string', enum: [...RECURRING_DEPARTMENTS], description: 'Optional department to assign it to.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Optional priority. Defaults to normal.' },
    },
    required: ['title', 'cadence'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  mutates: true,
  approval: 'card',
  handler: async ({ title, cadence, weekday, assignee, department, priority }, ctx: ToolContext): Promise<ToolResult> => {
    const cleanTitle = String(title ?? '').trim().slice(0, 200);
    if (!cleanTitle) return { ok: false, error: 'Give the recurring to-do a short title.' };

    const cad = (RECURRING_CADENCES as readonly string[]).includes(cadence) ? (cadence as RecurringCadence) : null;
    if (!cad) return { ok: false, error: 'Say how often it repeats: daily, weekdays, or weekly.' };

    let wd: number | null = null;
    if (cad === 'weekly') {
      wd = parseWeekday(weekday);
      if (wd === null) return { ok: false, error: 'For a weekly to-do, tell me which day (e.g. "every Monday").' };
    }

    const dept = department && (RECURRING_DEPARTMENTS as readonly string[]).includes(department) ? department : null;
    const prio: RecurringPriority = (PRIORITIES as readonly string[]).includes(priority ?? '')
      ? (priority as RecurringPriority) : 'normal';

    // Resolve an assignee by name when supplied. Ambiguity → ask the user.
    let assignedStaffId: string | null = null;
    let assignedName: string | null = null;
    if (assignee && String(assignee).trim()) {
      const res = await resolveStaffByName(ctx.propertyId, assignee);
      if (res.kind === 'none') return { ok: false, error: `No active staff member matching "${assignee}".` };
      if (res.kind === 'ambiguous') {
        return {
          ok: false,
          error: `Several staff match "${assignee}": ${res.candidates.map((c) => c.name).join(', ')}. Ask which one, then try again.`,
          data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, department: c.department })) },
        };
      }
      assignedStaffId = res.staff.id;
      assignedName = res.staff.name;
    }

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, title: cleanTitle, cadence: cad, weekday: wd, assignee: assignedName, department: dept, priority: prio } };
    }

    try {
      const { id } = await createTemplate({
        propertyId: ctx.propertyId,
        createdByStaffId: ctx.staffId,
        title: cleanTitle,
        assignedStaffId,
        assignedDepartment: dept,
        priority: prio,
        cadence: cad,
        weekday: wd,
      });
      return {
        ok: true,
        data: {
          templateId: id,
          title: cleanTitle,
          cadence: cad,
          weekday: wd,
          weekdayName: wd !== null ? WEEKDAY_NAMES[wd] : null,
          assignee: assignedName,
          department: dept,
          priority: prio,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to create the recurring to-do.' };
    }
  },
});

// ─── stop_recurring_todo ───────────────────────────────────────────────────

interface StopRecurringTodoArgs {
  templateId: string;
}

registerTool<StopRecurringTodoArgs>({
  name: 'stop_recurring_todo',
  description:
    'Stop a recurring to-do so it no longer reappears. Use after list_recurring_todos when the user says "stop the pool-check one" or "cancel the Monday lobby task". ' +
    'templateId is the id from list_recurring_todos. To-dos already spawned stay on the list; only future days stop.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: { type: 'string', description: 'The id of the recurring to-do to stop (from list_recurring_todos).' },
    },
    required: ['templateId'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  mutates: true,
  approval: 'card',
  handler: async ({ templateId }, ctx: ToolContext): Promise<ToolResult> => {
    const id = String(templateId ?? '').trim();
    if (!id) return { ok: false, error: 'Which recurring to-do? I need its id (from the list).' };

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, templateId: id } };
    }

    try {
      const stopped = await stopTemplate(ctx.propertyId, id);
      if (!stopped) {
        return { ok: false, error: 'That recurring to-do is already stopped or doesn\'t exist.' };
      }
      return { ok: true, data: { templateId: id, stopped: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to stop the recurring to-do.' };
    }
  },
});

// ─── list_recurring_todos ──────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'list_recurring_todos',
  description:
    'List the active recurring to-dos (checklists that reappear) for this property. Use for "what recurring tasks are set?", "what repeats every week?", "qué tareas se repiten?". ' +
    'Returns each one\'s id, title, how often it repeats, and who it\'s for. Call this before stop_recurring_todo so you have the id.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  // Chat-only (default) — the whole new ability set is scoped to the chat surface.
  handler: async (_args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const templates = await listActiveTemplates(ctx.propertyId);
      const staffIds = Array.from(new Set(templates.map((t) => t.assignedStaffId).filter((x): x is string => !!x)));
      const nameById = new Map<string, string>();
      if (staffIds.length) {
        const { supabaseAdmin } = await import('@/lib/supabase-admin');
        const { data } = await supabaseAdmin.from('staff').select('id, name').eq('property_id', ctx.propertyId).in('id', staffIds);
        for (const s of data ?? []) nameById.set(s.id as string, (s.name as string) ?? 'Unknown');
      }
      const rows = templates.map((t) => ({
        id: t.id,
        title: t.title,
        cadence: t.cadence,
        weekday: t.weekday !== null ? WEEKDAY_NAMES[t.weekday] : null,
        priority: t.priority,
        assignedTo: t.assignedStaffId
          ? (nameById.get(t.assignedStaffId) ?? 'a staff member')
          : (t.assignedDepartment ? `${t.assignedDepartment} (department)` : null),
      }));
      return { ok: true, data: { count: rows.length, recurringTodos: rows } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to load recurring to-dos.' };
    }
  },
});
