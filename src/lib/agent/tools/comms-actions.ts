// ─── Comms action tools ────────────────────────────────────────────────────
//
// Four new AI-assistant actions that write into the Communications hub. All are
// `mutates: true` + approval 'card' — they only run after the user approves the
// action on a centered card (see src/lib/agent/approval.ts + the approval gate
// in llm.ts / the resolve-action route).
//
//   send_message      — DM another staff member AS THE CALLER (not as Staxis).
//   create_todo       — add a task to the shared to-do list.
//   add_logbook_entry — write a shift log book entry.
//   post_announcement — broadcast to all staff (manager-gated).
//
// Identity: these post AS the signed-in user, so they need the caller's
// `staff.id`. The chat route resolves `ctx.staffId` from
// `staff.auth_user_id = user.uid` for every role (extended from floor-only). A
// null staffId means the account isn't linked to a staff row on this property —
// the tools that require a staff identity refuse with a clear message rather
// than posting anonymously.
//
// NOTE (parallel branches): this file is ADDITIVE. It self-registers on import;
// add `import './comms-actions';` to tools/index.ts.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  ensureDmConversation,
  postMessage,
  createTask,
  createLogEntry,
  postAnnouncement,
} from '@/lib/comms/core';
import { canForProperty } from '@/lib/capabilities/server';
import { registerAddon } from '../approval';
import { resolveStaffByName, type StaffResolution } from './_helpers';
import type { ScopedDb } from '../scoped-db';

// ─── Shared: resolve a recipient staff member by name (or id) ──────────────
// Ambiguity is a first-class outcome: when several active staff match, we
// return the candidate list AS THE TOOL RESULT (ok:false with a `candidates`
// payload) so the model asks the user which one — never silently picks.
//
// This funnels through the canonical resolveStaffByName in _helpers.ts (the
// single staff-name matcher shared with assign_room) rather than re-querying
// staff a third time. We keep the same discriminated-result shape the handlers
// below already consume.

type RecipientResolution = StaffResolution;

async function resolveRecipient(
  db: ScopedDb,
  recipient: string,
): Promise<RecipientResolution> {
  return resolveStaffByName(db, recipient);
}

const ALL_STAFF_ROLES = [
  'admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance', 'staff',
] as const;

const DEPARTMENTS = ['front_desk', 'housekeeping', 'maintenance', 'general'] as const;
const TASK_PRIORITIES = ['normal', 'high', 'urgent'] as const;

// ─── send_message ────────────────────────────────────────────────────────────

interface SendMessageArgs {
  recipient: string;
  message: string;
}

registerTool<SendMessageArgs>({
  name: 'send_message',
  section: 'communications',
  description:
    'Send a direct message to one colleague, FROM the user — it arrives with their name on it, not Staxis\'s. ' +
    'Use when: the user wants to tell one specific person something — "message Maria that the lobby needs a mop", "tell Carlos his 3pm rooms are ready", "dile a Ana que ya llegaron las toallas". For everyone at once use post_announcement; for something that needs doing use create_todo. ' +
    'Args: recipient — the colleague, by name (a first name is enough when unique) or staff id. message — the body in the user\'s own words, capped at 2000 characters. ' +
    'Returns: the resolved recipient and the message sent. A proposal until the user approves the card, and the card offers to add it to the recipient\'s to-do list as well. ' +
    'Refuses: an empty message, sending to yourself, a recipient matching nobody active at this hotel, and a name matching several people — it returns the candidates so you can ask which one, and must never pick one itself. It also refuses when the user\'s own account is not linked to a staff record, because the message would have no sender. This is in-app only: it does not text, email or phone anyone.',
  inputSchema: {
    type: 'object',
    properties: {
      recipient: { type: 'string', description: 'Who to message — a staff member\'s name (or their staff id).' },
      message: { type: 'string', description: 'The message body, in the user\'s own words. Max 2000 chars.' },
    },
    required: ['recipient', 'message'],
  },
  allowedRoles: [...ALL_STAFF_ROLES],
  mutates: true,
  approval: 'card',
  handler: async ({ recipient, message }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const body = String(message ?? '').trim().slice(0, 2000);
    if (!body) return { ok: false, error: 'There is nothing to send — the message is empty.' };
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property, so I can\'t send a message as you. Ask a manager to link it.' };
    }

    const res = await resolveRecipient(ctx.db, recipient);
    if (res.kind === 'none') {
      return { ok: false, error: `No active staff member matching "${recipient}" on this property.` };
    }
    if (res.kind === 'ambiguous') {
      return {
        ok: false,
        // Data payload the model uses to ask the user to disambiguate. NOT an
        // error the user should see verbatim — the prompt tells the model to
        // ask which person is meant.
        error: `Several staff match "${recipient}": ${res.candidates.map((c) => c.name).join(', ')}. Ask the user which one they mean, then send again with the exact name.`,
        data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, department: c.department })) },
      };
    }
    const staff = res.staff;
    if (staff.id === ctx.staffId) {
      return { ok: false, error: 'You can\'t send a message to yourself.' };
    }

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, recipient: staff.name, message: body } };
    }

    try {
      const convoId = await ensureDmConversation(ctx.propertyId, ctx.staffId, staff.id);
      const posted = await postMessage(ctx.propertyId, convoId, {
        senderStaffId: ctx.staffId, // FROM THE CALLER, not Staxis
        senderKind: 'staff',
        body,
      });
      return {
        ok: true,
        data: {
          messageId: posted.id,
          recipient: staff.name,
          recipientStaffId: staff.id,
          conversationId: convoId,
          message: body,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to send the message.' };
    }
  },
});

// send_message add-on: also add the message to the recipient's to-do list.
registerAddon('send_message', {
  id: 'add_to_recipient_todo',
  label: (args) => {
    const who = String(args.recipient ?? 'them').trim() || 'them';
    return {
      en: `Also add this to ${who}'s to-do list`,
      es: `También agregar esto a la lista de tareas de ${who}`,
    };
  },
  run: async (ctx) => {
    const r = (ctx.primaryResult ?? {}) as { recipientStaffId?: string; message?: string; messageId?: string };
    if (!r.recipientStaffId) throw new Error('recipient staff id missing from message result');
    const title = String(r.message ?? '').slice(0, 120) || 'Follow-up';
    await createTask(ctx.propertyId, {
      title,
      assignedStaffId: r.recipientStaffId,
      createdByStaffId: ctx.callerStaffId,
      sourceMessageId: r.messageId ?? null,
    });
    return { note: 'Added to their to-do list.' };
  },
});

// ─── create_todo ─────────────────────────────────────────────────────────────

interface CreateTodoArgs {
  title: string;
  notes?: string;
  assignee?: string;
  department?: string;
  dueAt?: string;
  priority?: string;
}

registerTool<CreateTodoArgs>({
  name: 'create_todo',
  section: 'communications',
  description:
    'Add ONE task to the shared to-do list — something that needs doing once. ' +
    'Use when: the user asks for a job to be recorded — "add a to-do: restock the linen closet", "someone needs to check the pool heater", "crear una tarea: revisar el gimnasio". For something that should repeat on a schedule use create_recurring_todo; for a message at a specific future time use create_reminder; for a note about a room use flag_issue. ' +
    'Args: title — the task, capped at 200 characters. notes — optional longer detail. assignee — optional person by name. department — optional, one of front_desk / housekeeping / maintenance / general. dueAt — optional ISO-8601 timestamp; work the date out from the user\'s words rather than passing their phrase through. priority — normal (default), high or urgent. ' +
    'Returns: the created task with its resolved assignee, department, due time and priority. A proposal until the user approves the card. ' +
    'Refuses: an empty title, an assignee matching nobody, and an assignee matching several people — it hands back the candidates rather than choosing. It also refuses when the user is not linked to a staff record, because a to-do created by nobody is an orphan. Adding a to-do notifies no one and starts nothing: it appears on the list for whoever looks.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short task title. Max 200 chars.' },
      notes: { type: 'string', description: 'Optional longer detail.' },
      assignee: { type: 'string', description: 'Optional staff member to assign it to, by name.' },
      department: { type: 'string', enum: [...DEPARTMENTS], description: 'Optional department to assign it to.' },
      dueAt: { type: 'string', description: 'Optional due date/time as ISO-8601 (e.g. "2026-07-06T17:00:00Z").' },
      priority: { type: 'string', enum: [...TASK_PRIORITIES], description: 'Optional priority. Defaults to normal.' },
    },
    required: ['title'],
  },
  allowedRoles: [...ALL_STAFF_ROLES],
  mutates: true,
  approval: 'card',
  handler: async ({ title, notes, assignee, department, dueAt, priority }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const cleanTitle = String(title ?? '').trim().slice(0, 200);
    if (!cleanTitle) return { ok: false, error: 'Give the to-do a short title.' };
    // Post AS the caller — a to-do created by "nobody" is an orphaned row that
    // contradicts this file's identity contract. Refuse rather than insert
    // anonymously (same message + reasoning as send_message).
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property, so I can\'t create a to-do as you. Ask a manager to link it.' };
    }
    const cleanNotes = notes ? String(notes).trim().slice(0, 2000) : null;
    const dept = department && (DEPARTMENTS as readonly string[]).includes(department) ? department : null;
    const prio = priority && (TASK_PRIORITIES as readonly string[]).includes(priority)
      ? (priority as (typeof TASK_PRIORITIES)[number])
      : 'normal';

    // dueAt: accept an ISO-8601 timestamp; drop anything that doesn't parse.
    let due: string | null = null;
    if (dueAt) {
      const t = new Date(String(dueAt));
      if (!Number.isNaN(t.getTime())) due = t.toISOString();
    }

    // Resolve an assignee by name when supplied. Ambiguity → ask the user.
    let assignedStaffId: string | null = null;
    let assignedName: string | null = null;
    if (assignee && String(assignee).trim()) {
      const res = await resolveRecipient(ctx.db, assignee);
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
      return { ok: true, data: { dryRun: true, title: cleanTitle, assignee: assignedName, department: dept, priority: prio } };
    }

    try {
      const task = await createTask(ctx.propertyId, {
        title: cleanTitle,
        notes: cleanNotes,
        assignedStaffId,
        assignedDepartment: dept,
        dueAt: due,
        priority: prio,
        createdByStaffId: ctx.staffId,
      });
      return {
        ok: true,
        data: {
          taskId: task.id,
          title: cleanTitle,
          assignee: assignedName,
          department: dept,
          dueAt: due,
          priority: prio,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to create the to-do.' };
    }
  },
});

// ─── add_logbook_entry ───────────────────────────────────────────────────────

interface AddLogbookEntryArgs {
  title: string;
  body?: string;
  category?: string;
}

registerTool<AddLogbookEntryArgs>({
  name: 'add_logbook_entry',
  section: 'communications',
  description:
    'Write an entry in the shift log book — the running record the next shift reads at handover. ' +
    'Use when: the user is recording what happened rather than asking for something to be done — "log book: elevator 2 was out 2-4pm", "note that we ran low on towels", "anotar en la bitácora que el aire de la 210 sigue fallando". If it needs doing, use create_todo; if a guest is unhappy, use log_complaint. ' +
    'Args: title — a short headline, capped at 200 characters. body — optional detail, capped at 4000. category — front_desk, housekeeping, maintenance or general (the default). ' +
    'Returns: the entry id, title and category, attributed to the user. A proposal until they approve the card. ' +
    'Refuses: an empty title, and any caller whose account is not linked to a staff record — a log entry has an author or it is not a log entry. Writing here notifies nobody and creates no task; it is a record for whoever reads the book.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short headline for the entry. Max 200 chars.' },
      body: { type: 'string', description: 'Optional longer detail.' },
      category: { type: 'string', enum: [...DEPARTMENTS], description: 'Which area this entry is about. Defaults to general.' },
    },
    required: ['title'],
  },
  allowedRoles: [...ALL_STAFF_ROLES],
  mutates: true,
  approval: 'card',
  handler: async ({ title, body, category }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const cleanTitle = String(title ?? '').trim().slice(0, 200);
    if (!cleanTitle) return { ok: false, error: 'Give the log entry a short title.' };
    // Log book entries are attributed to their author — refuse rather than
    // write an anonymous entry (same identity contract as send_message).
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property, so I can\'t add a log entry as you. Ask a manager to link it.' };
    }
    const cleanBody = body ? String(body).trim().slice(0, 4000) : null;
    const cat = category && (DEPARTMENTS as readonly string[]).includes(category) ? category : 'general';

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, title: cleanTitle, category: cat } };
    }

    try {
      const entry = await createLogEntry(ctx.propertyId, {
        authorStaffId: ctx.staffId,
        title: cleanTitle,
        body: cleanBody,
        category: cat,
      });
      return { ok: true, data: { entryId: entry.id, title: cleanTitle, category: cat } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to add the log entry.' };
    }
  },
});

// ─── post_announcement ───────────────────────────────────────────────────────

interface PostAnnouncementArgs {
  message: string;
  requiresAck?: boolean;
}

registerTool<PostAnnouncementArgs>({
  name: 'post_announcement',
  section: 'communications',
  description:
    'Broadcast one announcement to EVERY member of staff at this hotel — the announcements feed and the notice banner housekeepers see. ' +
    'Use when: the user genuinely means everyone — "announce that breakfast starts at 6am tomorrow", "tell everyone the pool is closed", "avisar a todos que habrá reunión a las 3". For one person use send_message. When it is not clearly hotel-wide, ask before broadcasting: this reaches every phone and cannot be unsent. ' +
    'Args: message — the announcement text, capped at 2000 characters. requiresAck — true when every recipient must tick that they read it; use it for anything about safety, pay or a rule change, not for routine notices. ' +
    'Returns: the announcement id, the text posted, and whether acknowledgement was required. A proposal until the user approves the card. ' +
    'Refuses: an empty message, and any role without announcement permission at this hotel — including a manager an admin has switched off for it. There is no edit and no recall once it is out, so do not promise to fix or delete one afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The announcement text. Max 2000 chars.' },
      requiresAck: { type: 'boolean', description: 'When true, every recipient must confirm they read it.' },
    },
    required: ['message'],
  },
  // allowedRoles is a coarse first gate; the handler does the SAME per-hotel
  // capability check the /api/comms/announce route uses (post_announcements),
  // so an admin who switched a manager OFF for announcements at this property
  // is honored here too.
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  mutates: true,
  approval: 'card',
  handler: async ({ message, requiresAck }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const text = String(message ?? '').trim().slice(0, 2000);
    if (!text) return { ok: false, error: 'The announcement is empty.' };

    // Per-hotel capability gate — mirrors the announce route (canForUserId →
    // post_announcements). We already have the role on ctx, so use
    // canForProperty directly (admin short-circuits inside).
    const allowed = await canForProperty({ role: ctx.user.role }, 'post_announcements', ctx.propertyId);
    if (!allowed) {
      return { ok: false, error: 'Posting announcements is restricted for your role at this property. Only managers with that permission can broadcast to all staff.' };
    }

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, message: text, requiresAck: requiresAck === true } };
    }

    try {
      const res = await postAnnouncement(ctx.propertyId, {
        body: text,
        sourceLang: 'en',
        senderStaffId: ctx.staffId,
        senderAccountId: ctx.user.accountId,
        requiresAck: requiresAck === true,
      });
      return { ok: true, data: { announcementId: res.id, message: text, requiresAck: requiresAck === true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to post the announcement.' };
    }
  },
});

// ─── Add-ons for the card-tier tools that create work ──────────────────────
// "Also add to the to-do list" for log_complaint. Assigns the follow-up task
// to the maintenance department (that's who acts on a complaint). Deterministic
// — no model free-text.

registerAddon('log_complaint', {
  id: 'add_to_maintenance_todo',
  label: () => ({
    en: 'Also add to the to-do list',
    es: 'También agregar a la lista de tareas',
  }),
  run: async (ctx) => {
    const r = (ctx.primaryResult ?? {}) as { complaintId?: string; roomNumber?: string | null };
    const a = ctx.args as { description?: string };
    const room = r.roomNumber ? `Room ${r.roomNumber}: ` : '';
    const title = `${room}${String(a.description ?? 'Complaint follow-up').slice(0, 160)}`.slice(0, 200);
    await createTask(ctx.propertyId, {
      title,
      assignedDepartment: 'maintenance',
      priority: 'high',
      createdByStaffId: ctx.callerStaffId,
    });
    return { note: 'Added to the maintenance to-do list.' };
  },
});

