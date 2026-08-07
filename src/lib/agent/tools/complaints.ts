// ─── log_complaint tool ──────────────────────────────────────────────────────
// Lets a manager/front-desk/housekeeper log a guest complaint by chat
// ("Log a complaint — room 214, AC not cooling, guest upset").
// Shares createComplaint() with the API route, so the AI categorize + severity +
// auto-route-to-work-order behaviour is identical across surfaces.
//
// NOTE (parallel branches): this file is ADDITIVE. It self-registers on import;
// add the single `import './complaints';` line to tools/index.ts.

import { registerTool, type ToolResult, type ToolContext } from '../tools';
import { createComplaint } from '@/lib/complaints-create';
import { createWorkOrderForComms } from '@/lib/comms/core';
import {
  COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES,
  type ComplaintCategory, type ComplaintSeverity,
} from '@/lib/complaints-shared';

interface LogComplaintArgs {
  description: string;
  roomNumber?: string;
  guestName?: string;
  category?: ComplaintCategory;
  severity?: ComplaintSeverity;
}

registerTool<LogComplaintArgs>({
  name: 'log_complaint',
  description:
    'Log a GUEST complaint so it is tracked through to resolution. ' +
    'Use when: a guest is unhappy about something — "room 214, AC not cooling, guest upset", "guest in 312 says the room is dirty", "noise complaint from 405", "registrar una queja". This is the right tool whenever a guest is involved: flag_issue only writes a note on the room and nobody is accountable for it. ' +
    'Args: description — the guest\'s issue in their terms, capped at 2000 characters. roomNumber and guestName when mentioned. category and severity — only pass these when the user states them explicitly; left off, both are classified automatically, which is usually better than your guess. ' +
    'Returns: the complaint id, its resolved category, severity and status, whether a work order was opened, and repeatIssue / priorSimilarCount when this room has had the same trouble before — mention a repeat, because it changes what the manager should do. A proposal until the user approves the card. ' +
    'Refuses: an empty description. Two things to state accurately: maintenance and cleanliness complaints DO automatically open a linked work order, so say so; and everything else does not, so do not tell the guest someone is on the way when only a record was created. Logging a complaint never contacts the guest or issues any compensation.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What the guest is complaining about (the issue).' },
      roomNumber: { type: 'string', description: 'Room number if mentioned (digits, e.g. "214").' },
      guestName: { type: 'string', description: 'Guest name if mentioned.' },
      category: {
        type: 'string', enum: [...COMPLAINT_CATEGORIES],
        description: 'Optional — only set if the category is explicit; otherwise it is auto-classified.',
      },
      severity: {
        type: 'string', enum: [...COMPLAINT_SEVERITIES],
        description: 'Optional — only set if clearly stated (e.g. "very upset" → high); otherwise auto-classified.',
      },
    },
    required: ['description'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  // Also offered in a staff thread — the old private @Staxis catalog's
  // `create_complaint`. There it wrote INLINE with no approval card; here it is
  // the same registered tool as everywhere else, so it is proposed and waits.
  surfaces: ['chat', 'messages'],
  mutates: true,
  approval: 'card',
  handler: async (args: LogComplaintArgs, ctx: ToolContext): Promise<ToolResult> => {
    // Clamp lengths to match /api/complaints/log's validators so a prompt-
    // injected / runaway-long string can't be stored or sent to the
    // classifier unbounded (Codex review #10).
    const description = (args.description ?? '').trim().slice(0, 2000);
    if (!description) return { ok: false, error: 'Please include what the complaint is about.' };

    const roomNumber = (args.roomNumber ?? '').toString().trim().slice(0, 20) || null;
    const guestName = (args.guestName ?? '').toString().trim().slice(0, 120) || null;

    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          dryRun: true, description, roomNumber,
          category: args.category ?? '(auto)', severity: args.severity ?? '(auto)',
        },
      };
    }

    try {
      const res = await createComplaint({
        propertyId: ctx.propertyId,
        description,
        roomNumber,
        guestName,
        category: args.category ?? null,
        severity: args.severity ?? null,
        source: 'front_desk',
        createdBy: ctx.user.uid,
        createdByName: ctx.user.displayName,
      }, {
        // `createComplaint` runs the complaint classifier when the caller did
        // not state a category and severity, which is the usual case here.
        // Without a ledger that model call was a real Anthropic charge with no
        // row anywhere: /api/complaints/log has always passed one, and this
        // path, reached whenever somebody logs a complaint by chat, never did.
        // The chat turn's own reservation covers the money either way; what was
        // missing is the record, and a hold nobody reconciles against is not
        // accounting.
        ledger: {
          userId: ctx.user.accountId,
          propertyId: ctx.propertyId,
          requestId: ctx.requestId,
          feature: 'complaints.classification',
        },
      });

      return {
        ok: true,
        data: {
          complaintId: res.complaint.id,
          category: res.complaint.category,
          severity: res.complaint.severity,
          roomNumber: res.complaint.roomNumber,
          status: res.complaint.status,
          workOrderCreated: !!res.linkedWorkOrderId,
          linkedWorkOrderId: res.linkedWorkOrderId,
          // Surface the repeat-issue flag so the assistant can warn the user.
          repeatIssue: res.repeatCount > 0,
          priorSimilarCount: res.repeatCount,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to log the complaint.' };
    }
  },
});

// ─── create_work_order ─────────────────────────────────────────────────────
//
// The last of the five capabilities the private @Staxis thread catalog owned.
// It is a NEW registration rather than an extension of an existing tool because
// there was no work-order CREATOR in the registry at all: `flag_issue` writes a
// note on a room and replaces the previous one, `log_complaint` opens a linked
// ticket only for maintenance and cleanliness complaints, and
// `get_work_order_history` reads. Mapping "@Staxis the AC in 214 is dead, open a
// ticket" onto either of the first two would have quietly changed what the
// person got.
//
// SURFACE: messages ONLY. The chat bar never had this tool, and folding the
// thread assistant in is not a licence to hand the chat bar a new mutation
// nobody asked for. `executeTool` enforces the same surface a second time.
//
// APPROVAL: 'card'. In the old loop this wrote to `work_orders` the moment the
// model called it, which is the exact thing the companion's charter says never
// happens. Now it is a proposal and the person who asked has to say yes.

interface CreateWorkOrderArgs {
  description: string;
  roomNumber?: string;
  severity?: 'low' | 'medium' | 'high';
}

registerTool<CreateWorkOrderArgs>({
  name: 'create_work_order',
  description:
    'Open a maintenance work order for something that is broken and needs fixing. '
    + 'Use when: somebody reports a fault in a thread — "the AC in 214 is dead", "leak under the sink in 305", "the ice machine on 2 stopped". If a GUEST is unhappy about it, use log_complaint instead: that one is tracked to resolution and opens the ticket itself. '
    + 'Args: description — what needs fixing, capped at 1000 characters. roomNumber — the room when it is room-specific, left off when it is not. severity — low, medium or high; medium when unstated. '
    + 'Returns: the work order id. A proposal until the user approves the card. '
    + 'Refuses: an empty description. Say accurately how little this does: it files a ticket. It does not page anybody, text anybody, or assign the work, so never tell the user that maintenance is on the way.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What needs fixing.' },
      roomNumber: { type: 'string', description: 'Room number, left off when it is not room-specific.' },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How urgent it is. Only set this when the person said so; left off it is medium.',
      },
    },
    required: ['description'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  surfaces: ['messages'],
  mutates: true,
  approval: 'card',
  handler: async (args: CreateWorkOrderArgs, ctx: ToolContext): Promise<ToolResult> => {
    const description = (args.description ?? '').trim().slice(0, 1000);
    if (!description) return { ok: false, error: 'Please include what needs fixing.' };
    const roomNumber = (args.roomNumber ?? '').toString().trim().slice(0, 20) || null;
    const severity = args.severity === 'low' || args.severity === 'high' ? args.severity : 'medium';

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, description, roomNumber, severity } };
    }

    try {
      // The SAME writer the thread assistant used before the fold, so the row
      // that lands in `work_orders` is byte-for-byte the row it used to write.
      const created = await createWorkOrderForComms(ctx.propertyId, {
        roomNumber,
        description,
        severity,
        byName: `Staxis (via ${ctx.user.displayName})`,
      });
      return { ok: true, data: { workOrderId: created.id, roomNumber, severity, description } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to open the work order.' };
    }
  },
});
