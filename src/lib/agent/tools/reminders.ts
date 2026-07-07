// ─── Reminder action tools ─────────────────────────────────────────────────
//
// Delayed one-shot reminders the assistant schedules for later. Backed by
// agent_reminders (migration 0302) + src/lib/reminders/store.ts; fired by the
// process-sms-jobs cron tick.
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

import { registerTool, type ToolResult, type ToolContext } from '../tools';
import {
  createReminder,
  cancelReminder,
  listPendingReminders,
  REMINDER_DEPARTMENTS,
  type ReminderDepartment,
} from '@/lib/reminders/store';
import { resolveStaffByName } from './_helpers';

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
    'Schedule a reminder to fire LATER — a message that goes out at a set time to one person or a whole department. ' +
    'Use for "remind the morning shift about the pool at 8am", "remind Maria to check the gym at 2pm", "recuérdale a mantenimiento revisar la piscina a las 9". ' +
    'body = the reminder text. fireAt = when to send it, as a full ISO-8601 timestamp (e.g. "2026-07-06T08:00:00-05:00"); work out the exact date/time from the user\'s words in the hotel\'s timezone and it must be in the future. ' +
    'Target EITHER one person (recipient, by name) OR one department (front_desk/housekeeping/maintenance/general) — not both. A person gets a direct message from you; a department gets a post in its channel.',
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
  handler: async ({ body, fireAt, recipient, department }, ctx: ToolContext): Promise<ToolResult> => {
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
      const res = await resolveStaffByName(ctx.propertyId, recipient as string);
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
    'Cancel a scheduled reminder before it fires. Use after list_reminders when the user says "cancel that pool reminder" or "never mind the 8am one". ' +
    'reminderId is the id from list_reminders.',
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
  handler: async ({ reminderId }, ctx: ToolContext): Promise<ToolResult> => {
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

// ─── list_reminders ────────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'list_reminders',
  description:
    'List the reminders scheduled for this property that haven\'t fired yet. Use for "what reminders are set?", "what\'s scheduled?", "qué recordatorios hay?". ' +
    'Returns each reminder\'s id, text, when it fires, and who it\'s for. Call this before cancel_reminder so you have the id.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  // Chat-only (default) — the whole new ability set is scoped to the chat surface.
  handler: async (_args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const rows = await listPendingReminders(ctx.propertyId);
      // Resolve target staff names in one batched read.
      const staffIds = Array.from(new Set(rows.map((r) => r.targetStaffId).filter((x): x is string => !!x)));
      const nameById = new Map<string, string>();
      if (staffIds.length) {
        const { supabaseAdmin } = await import('@/lib/supabase-admin');
        const { data } = await supabaseAdmin.from('staff').select('id, name').eq('property_id', ctx.propertyId).in('id', staffIds);
        for (const s of data ?? []) nameById.set(s.id as string, (s.name as string) ?? 'Unknown');
      }
      const reminders = rows.map((r) => ({
        id: r.id,
        body: r.body,
        fireAt: r.fireAt,
        target: r.targetStaffId
          ? (nameById.get(r.targetStaffId) ?? 'a staff member')
          : `${r.targetDepartment} (department)`,
      }));
      return { ok: true, data: { count: reminders.length, reminders } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to load reminders.' };
    }
  },
});
