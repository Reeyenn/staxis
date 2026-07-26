// ─── log_complaint tool ──────────────────────────────────────────────────────
// Lets a manager/front-desk/housekeeper log a guest complaint by text OR voice
// ("Hey Staxis, log a complaint — room 214, AC not cooling, guest upset").
// Shares createComplaint() with the API route, so the AI categorize + severity +
// auto-route-to-work-order behaviour is identical across surfaces.
//
// NOTE (parallel branches): this file is ADDITIVE. It self-registers on import;
// add the single `import './complaints';` line to tools/index.ts.

import { registerTool, type ToolResult, type ToolContext } from '../tools';
import { createComplaint } from '@/lib/complaints-create';
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
  surfaces: ['chat', 'voice'],
  // Voice: only the GENERAL assistant ("Hey Staxis, log a complaint…"), not the
  // housekeeper_issue entry point. Audited in voice-surface-tools.test.ts.
  voiceModes: ['general'],
  mutates: true,
  approval: 'card',
  handler: async (args: LogComplaintArgs, ctx: ToolContext): Promise<ToolResult> => {
    // Clamp lengths to match /api/complaints/log's validators so a prompt-
    // injected / runaway-long string can't be stored or sent to the
    // classifier unbounded (Codex review #10).
    const description = (args.description ?? '').trim().slice(0, 2000);
    if (!description) return { ok: false, error: 'Please include what the complaint is about.' };

    const roomNumber = (args.roomNumber ?? ctx.currentRoomNumber ?? '').toString().trim().slice(0, 20) || null;
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
        source: ctx.surface === 'voice' ? 'voice' : 'front_desk',
        createdBy: ctx.user.uid,
        createdByName: ctx.user.displayName,
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
