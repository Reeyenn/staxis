// ─── Reminder action tools ─────────────────────────────────────────────────
//
// Delayed one-shot reminders the assistant schedules for later. Backed by
// agent_reminders (migration 0302) + src/lib/reminders/store.ts; fired by the
// process-agent-schedules cron tick.
//
//   create_reminder — MUTATION (card): schedule a reminder to a person or a
//                     department for a specific time. The card shows the exact
//                     text and when it fires.
//   cancel_reminder — MUTATION (quick): call off a still-pending reminder.
//   list_reminders  — READ: what reminders are scheduled and not yet fired.
//
// Identity: a reminder is delivered AS the creator (a DM from them, or a
// department post attributed to them), so create_reminder needs ctx.staffId and
// refuses without it — same contract as the comms tools.
//
// ADDITIVE + self-registering — add `import './reminders';` to index.ts.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  createReminder,
  cancelReminder,
  listPendingReminders,
  REMINDER_DEPARTMENTS,
  type ReminderDepartment,
} from '@/lib/reminders/store';
import { listActiveTemplates } from '@/lib/recurring-tasks/store';
import { resolveStaffByName } from './_helpers';
import { RECURRING_WEEKDAY_NAMES } from './recurring-todos';

// ─── create_reminder ─────────────────────────────────────────────────────────

interface CreateReminderArgs {
  body: string;
  fireAt: string;
  recipient?: string;
  department?: string;
}

registerTool<CreateReminderArgs>({
  name: 'create_reminder',
  description:
    'Schedule a message to be delivered at a specific future time, to one person or one department. ' +
    'Use when: the user wants something said LATER at a known moment — "remind the morning shift about the pool at 8am", "remind Maria to check the gym at 2pm", "recuérdale a mantenimiento revisar la piscina a las 9". For something that repeats use create_recurring_todo; for a job with no particular time use create_todo. ' +
    'Args: body — what the reminder should say, capped at 1000 characters. fireAt — a full ISO-8601 timestamp WITH the timezone offset (e.g. "2026-07-06T08:00:00-05:00"); work the exact instant out from the user\'s words in the hotel\'s timezone rather than passing their phrase through. recipient — one staff member by name, OR department — one of front_desk / housekeeping / maintenance / general. Exactly one of the two. ' +
    'Returns: the reminder id, its text, when it fires and who it is for. A proposal until the user approves the card. ' +
    'Refuses: an empty body, a time it cannot read, any time in the PAST, both a person and a department at once, neither of them, a recipient name matching several people, and any hotel with the Communications section switched off (reminders are delivered through Communications, so there would be no way to deliver it). It delivers in-app only — a direct message from the user, or a post in the department channel — so it will not text, email or call anyone at that hour.',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'What the reminder should say. Max 1000 chars.' },
      fireAt: { type: 'string', description: 'When to send it — a full ISO-8601 timestamp in the future (include the timezone offset).' },
      recipient: { type: 'string', description: 'Optional — one staff member to remind, by name.' },
      department: { type: 'string', enum: [...REMINDER_DEPARTMENTS], description: 'Optional — a department to remind (front_desk/housekeeping/maintenance/general).' },
    },
    required: ['body', 'fireAt'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  mutates: true,
  approval: 'card',
  // A reminder is delivered through Communications and nowhere else, so at a
  // hotel with that section off there is no way to deliver it. Gating CREATION
  // only — cancel_reminder and list_scheduled_items stay ungated so anyone can
  // still see and clear reminders made before the section was switched off.
  // The full reasoning (and why this is the catalog gate rather than a check in
  // the handler) is on the `section` field in ../tools.ts.
  section: 'communications',
  handler: async ({ body, fireAt, recipient, department }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const text = String(body ?? '').trim().slice(0, 1000);
    if (!text) return { ok: false, error: 'The reminder is empty — tell me what it should say.' };
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property, so I can\'t send a reminder as you. Ask a manager to link it.' };
    }

    // Parse + validate the fire time. Must be a real timestamp in the future.
    const when = new Date(String(fireAt ?? ''));
    if (Number.isNaN(when.getTime())) {
      return { ok: false, error: 'I couldn\'t read that time. Tell me a clear date and time to send the reminder.' };
    }
    if (when.getTime() <= Date.now()) {
      return { ok: false, error: 'That time is in the past. Give me a time in the future to schedule the reminder.' };
    }

    // Exactly one target.
    const hasRecipient = !!(recipient && String(recipient).trim());
    const dept = department && (REMINDER_DEPARTMENTS as readonly string[]).includes(department)
      ? (department as ReminderDepartment) : null;
    if (hasRecipient && dept) {
      return { ok: false, error: 'Pick either one person or one department for the reminder, not both.' };
    }
    if (!hasRecipient && !dept) {
      return { ok: false, error: 'Who is the reminder for — a person or a department?' };
    }

    let targetStaffId: string | null = null;
    let targetName: string | null = null;
    if (hasRecipient) {
      const res = await resolveStaffByName(ctx.db, recipient as string);
      if (res.kind === 'none') return { ok: false, error: `No active staff member matching "${recipient}".` };
      if (res.kind === 'ambiguous') {
        return {
          ok: false,
          error: `Several staff match "${recipient}": ${res.candidates.map((c) => c.name).join(', ')}. Ask which one, then try again.`,
          data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, department: c.department })) },
        };
      }
      targetStaffId = res.staff.id;
      targetName = res.staff.name;
    }

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, body: text, fireAt: when.toISOString(), recipient: targetName, department: dept } };
    }

    try {
      const { id } = await createReminder({
        propertyId: ctx.propertyId,
        createdByStaffId: ctx.staffId,
        targetStaffId,
        targetDepartment: dept,
        body: text,
        fireAt: when.toISOString(),
      });
      return {
        ok: true,
        data: { reminderId: id, body: text, fireAt: when.toISOString(), recipient: targetName, department: dept },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to schedule the reminder.' };
    }
  },
});

// ─── cancel_reminder ───────────────────────────────────────────────────────

interface CancelReminderArgs {
  reminderId: string;
}

registerTool<CancelReminderArgs>({
  name: 'cancel_reminder',
  description:
    'Call off a one-shot reminder before it fires. ' +
    'Use when: the user says "cancel that pool reminder", "never mind the 8am one", "cancela el recordatorio". Always call list_scheduled_items first to get the id. To stop a REPEATING checklist use stop_recurring_todo instead — its ids are not valid here. ' +
    'Args: reminderId — the id of a "reminder" row from list_scheduled_items. ' +
    'Returns: the id and confirmation it was cancelled. A proposal until the user approves. ' +
    'Refuses: a missing id, and any reminder that has already fired, was already cancelled, or does not exist at this hotel — it says so plainly rather than reporting a cancellation that did not happen. Never invent or guess an id; a wrong one silently cancels the wrong reminder or nothing at all. A reminder that has already gone out cannot be recalled.',
  inputSchema: {
    type: 'object',
    properties: {
      reminderId: { type: 'string', description: 'The id of the reminder to cancel (from list_reminders).' },
    },
    required: ['reminderId'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  mutates: true,
  approval: 'quick',
  handler: async ({ reminderId }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const id = String(reminderId ?? '').trim();
    if (!id) return { ok: false, error: 'Which reminder? I need its id (from the reminder list).' };

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, reminderId: id } };
    }

    try {
      const canceled = await cancelReminder(ctx.propertyId, id);
      if (!canceled) {
        return { ok: false, error: 'That reminder is already gone — it either fired, was canceled, or doesn\'t exist.' };
      }
      return { ok: true, data: { reminderId: id, canceled: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to cancel the reminder.' };
    }
  },
});

// ─── list_scheduled_items ──────────────────────────────────────────────────
// Everything this hotel has queued to happen later, in one list.
//
// Absorbed list_reminders and list_recurring_todos (2026-07-27). "What's
// scheduled?" is one question, and splitting it across two tools forced the
// model to decide whether the user meant a one-shot reminder or a repeating
// checklist BEFORE it had seen either list — a guess it cannot make from the
// question and would then answer half of, confidently.
//
// Each row carries `kind`, because the two are cancelled by different tools
// (cancel_reminder vs stop_recurring_todo) whose ids are not interchangeable.
// The tools stay separate deliberately: they act on different objects with
// different approval tiers, and once the model has a row it knows which is
// which — the ambiguity was only ever in the listing.

const SCHEDULED_KINDS = ['reminder', 'recurring', 'all'] as const;
type ScheduledKind = (typeof SCHEDULED_KINDS)[number];

registerTool<{ kind?: ScheduledKind }>({
  name: 'list_scheduled_items',
  description:
    'List everything queued to happen later at this hotel — one-shot reminders that have not fired yet, and recurring to-dos that keep reappearing. ' +
    'Use when: the user asks "what\'s scheduled", "what reminders are set", "what repeats every week", "qué hay programado", or wants to cancel something and you need its id first. ' +
    'Args: kind — "reminder" for one-shot reminders only, "recurring" for repeating checklists only, "all" (default) for both. ' +
    'Returns: { count, items[] } where each item carries kind ("reminder" or "recurring"), its id, what it says, when it happens (fireAt for a reminder, cadence + weekday for a recurring one) and who it is for. ' +
    'Refuses: nothing, but the ids are NOT interchangeable — cancel a "reminder" item with cancel_reminder and a "recurring" item with stop_recurring_todo, using the id from this list. Never pass one to the other, and never invent an id.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...SCHEDULED_KINDS],
        description: 'Which kind to list: one-shot reminders, recurring to-dos, or all (default).',
      },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  // Chat-only (default) — the whole new ability set is scoped to the chat surface.
  handler: async ({ kind }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const which: ScheduledKind = (SCHEDULED_KINDS as readonly string[]).includes(kind as string)
      ? (kind as ScheduledKind)
      : 'all';
    const wantReminders = which === 'all' || which === 'reminder';
    // Recurring templates are manager-tier to CREATE; listing them is a read the
    // whole allowed set already has via the to-do pane, so no extra gate here.
    const wantRecurring = which === 'all' || which === 'recurring';

    try {
      const [reminders, templates] = await Promise.all([
        wantReminders ? listPendingReminders(ctx.propertyId) : Promise.resolve([]),
        wantRecurring ? listActiveTemplates(ctx.propertyId) : Promise.resolve([]),
      ]);

      // One batched name lookup across BOTH sources.
      const staffIds = Array.from(new Set([
        ...reminders.map((r) => r.targetStaffId),
        ...templates.map((t) => t.assignedStaffId),
      ].filter((x): x is string => !!x)));
      const nameById = new Map<string, string>();
      if (staffIds.length) {
        const { data } = await ctx.db.from('staff').select('id, name').in('id', staffIds);
        for (const s of data ?? []) nameById.set(s.id as string, (s.name as string) ?? 'Unknown');
      }

      const items = [
        ...reminders.map((r) => ({
          kind: 'reminder' as const,
          id: r.id,
          text: r.body,
          fireAt: r.fireAt,
          cadence: null,
          weekday: null,
          target: r.targetStaffId
            ? (nameById.get(r.targetStaffId) ?? 'a staff member')
            : `${r.targetDepartment} (department)`,
        })),
        ...templates.map((t) => ({
          kind: 'recurring' as const,
          id: t.id,
          text: t.title,
          fireAt: null,
          cadence: t.cadence,
          weekday: t.weekday !== null ? RECURRING_WEEKDAY_NAMES[t.weekday] : null,
          target: t.assignedStaffId
            ? (nameById.get(t.assignedStaffId) ?? 'a staff member')
            : (t.assignedDepartment ? `${t.assignedDepartment} (department)` : 'nobody in particular'),
        })),
      ];

      return { ok: true, data: { kind: which, count: items.length, items } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to load what is scheduled.' };
    }
  },
});
