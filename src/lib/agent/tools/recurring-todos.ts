// ─── Recurring to-do tools ─────────────────────────────────────────────────
//
// Daily, weekly, biweekly and monthly checklists that reappear as normal
// to-dos. Backed by
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

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  createTemplate,
  stopTemplate,
  listActiveTemplates,
  RECURRING_DEPARTMENTS,
  RECURRING_CADENCES,
  MIN_INTERVAL_DAYS,
  MAX_INTERVAL_DAYS,
  type RecurringCadence,
  type RecurringPriority,
} from '@/lib/recurring-tasks/store';
import { resolveStaffByName } from './_helpers';
import { assigneeBlockedReason } from '@/lib/worklist/assignable';

const PRIORITIES = ['normal', 'high', 'urgent'] as const;
/** Exported because list_scheduled_items (tools/reminders.ts) renders recurring
 *  rows alongside reminders and must spell the weekday the same way this file
 *  does — two copies of this array is exactly how they drift. */
export const RECURRING_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_NAMES = RECURRING_WEEKDAY_NAMES;

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
  dayOfMonth?: number;
  intervalDays?: number;
  assignee?: string;
  department?: string;
  priority?: string;
}

registerTool<CreateRecurringTodoArgs>({
  name: 'create_recurring_todo',
  description:
    'Set up a repeating checklist item — a to-do that comes back on the shared list every time it is due. ' +
    'Use when: the user describes a routine, not a one-off — "every morning check the pool chemicals", "every Monday deep-clean the lobby", "cada día revisar el desayuno". A single task is create_todo; a message at one future time is create_reminder. ' +
    'Args: title — what the task says, capped at 200 characters. cadence — "daily", "weekdays" (Mon–Fri), "weekly", "biweekly" (every other week), "monthly", or "every_n_days" for a gap of so many days. weekday — required for weekly and biweekly; a day name like "Monday" or 0–6 with 0 = Sunday. dayOfMonth — required for monthly; 1 to 28. intervalDays — required for every_n_days; 2 to 365. assignee — optional person by name. department — optional. priority — normal (default), high or urgent. ' +
    'Returns: the template id, its title, cadence and target. A proposal until the manager approves the card. ' +
    'Refuses: an empty title, a cadence it does not recognise, a weekly item with no weekday, and an assignee matching several people. Two things to be straight about: this creates the RULE, not today\'s task — nothing appears until the next time it is due — and it notifies nobody when it spawns. Stopping it later needs stop_recurring_todo; to-dos already spawned stay on the list.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the recurring task says. Max 200 chars.' },
      cadence: { type: 'string', enum: [...RECURRING_CADENCES], description: 'daily, weekdays (Mon–Fri), weekly, biweekly (every other week), monthly, or every_n_days.' },
      weekday: { type: 'string', description: 'For weekly and biweekly cadence — the day, e.g. "Monday" or 0–6 (0=Sunday).' },
      dayOfMonth: { type: 'number', description: 'For monthly cadence — which day of the month, 1 to 28.' },
      intervalDays: { type: 'number', description: 'For every_n_days cadence — how many days apart, 2 to 365.' },
      assignee: { type: 'string', description: 'Optional staff member to assign it to, by name.' },
      department: { type: 'string', enum: [...RECURRING_DEPARTMENTS], description: 'Optional department to assign it to.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Optional priority. Defaults to normal.' },
    },
    required: ['title', 'cadence'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  mutates: true,
  approval: 'card',
  handler: async ({ title, cadence, weekday, dayOfMonth, intervalDays, assignee, department, priority }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const cleanTitle = String(title ?? '').trim().slice(0, 200);
    if (!cleanTitle) return { ok: false, error: 'Give the recurring to-do a short title.' };

    const cad = (RECURRING_CADENCES as readonly string[]).includes(cadence) ? (cadence as RecurringCadence) : null;
    if (!cad) return { ok: false, error: 'Say how often it repeats: daily, weekdays, weekly, biweekly, monthly, or every so many days.' };

    let wd: number | null = null;
    if (cad === 'weekly' || cad === 'biweekly') {
      wd = parseWeekday(weekday);
      if (wd === null) return { ok: false, error: 'For a weekly or biweekly to-do, tell me which day (e.g. "every Monday").' };
    }
    let dom: number | null = null;
    if (cad === 'monthly') {
      dom = Number.isInteger(dayOfMonth) ? Number(dayOfMonth) : NaN;
      if (!Number.isInteger(dom) || dom! < 1 || dom! > 28) {
        return { ok: false, error: 'For a monthly to-do, tell me which day of the month, 1 to 28.' };
      }
    }
    let gap: number | null = null;
    if (cad === 'every_n_days') {
      gap = Number.isInteger(intervalDays) ? Number(intervalDays) : NaN;
      if (!Number.isInteger(gap) || gap! < MIN_INTERVAL_DAYS || gap! > MAX_INTERVAL_DAYS) {
        return {
          ok: false,
          error: `For a to-do that repeats every so many days, tell me how many, ${MIN_INTERVAL_DAYS} to ${MAX_INTERVAL_DAYS}.`,
        };
      }
    }

    const dept = department && (RECURRING_DEPARTMENTS as readonly string[]).includes(department) ? department : null;
    const prio: RecurringPriority = (PRIORITIES as readonly string[]).includes(priority ?? '')
      ? (priority as RecurringPriority) : 'normal';

    // Resolve an assignee by name when supplied. Ambiguity → ask the user.
    let assignedStaffId: string | null = null;
    let assignedName: string | null = null;
    if (assignee && String(assignee).trim()) {
      const res = await resolveStaffByName(ctx.db, assignee);
      if (res.kind === 'none') return { ok: false, error: `No active staff member matching "${assignee}".` };
      if (res.kind === 'ambiguous') {
        return {
          ok: false,
          error: `Several staff match "${assignee}": ${res.candidates.map((c) => c.name).join(', ')}. Ask which one, then try again.`,
          data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, department: c.department })) },
        };
      }
      // A standing to-do aimed at a housekeeper is the worst version of the
      // bug: it would spawn a fresh invisible task every single day.
      const blocked = assigneeBlockedReason(res.staff);
      if (blocked) return { ok: false, error: blocked };
      assignedStaffId = res.staff.id;
      assignedName = res.staff.name;
    }

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, title: cleanTitle, cadence: cad, weekday: wd, dayOfMonth: dom, intervalDays: gap, assignee: assignedName, department: dept, priority: prio } };
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
        dayOfMonth: dom,
        intervalDays: gap,
      });
      return {
        ok: true,
        data: {
          templateId: id,
          title: cleanTitle,
          cadence: cad,
          weekday: wd,
          dayOfMonth: dom,
          intervalDays: gap,
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
    'Stop a repeating checklist item so it stops coming back. ' +
    'Use when: the user says "stop the pool-check one", "cancel the Monday lobby task", "ya no repitas eso". Always call list_scheduled_items first to get the id. To cancel a one-shot reminder use cancel_reminder instead — its ids are not valid here. ' +
    'Args: templateId — the id of a "recurring" row from list_scheduled_items. ' +
    'Returns: the id and confirmation it was stopped. A proposal until the manager approves the card. ' +
    'Refuses: a missing id, and any template already stopped or not at this hotel. Say clearly what stopping does: only FUTURE spawns stop. Every to-do this rule has already put on the list stays there and still has to be checked off or removed by hand — do not tell the manager the task is gone.',
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
  handler: async ({ templateId }, ctx: ToolHandlerContext): Promise<ToolResult> => {
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

// list_recurring_todos lived here until 2026-07-27. It merged into
// list_scheduled_items (tools/reminders.ts) alongside list_reminders, because
// "what's scheduled?" is one question and two list tools made the model pick a
// kind before it had seen either. The wire-name still resolves via TOOL_ALIASES.
