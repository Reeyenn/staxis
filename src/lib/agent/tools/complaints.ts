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
    'Log a guest complaint / service issue so it can be tracked and resolved. Use for things like ' +
    '"log a complaint — room 214, AC not cooling, guest upset", "registrar una queja", "guest in 312 says the room is dirty", ' +
    '"front desk: noise complaint from 405". Pass the guest\'s issue in `description`. Category and severity are auto-detected ' +
    'if you do not pass them. Maintenance and cleanliness complaints automatically open a linked work order.',
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
  handler: async (args: LogComplaintArgs, ctx: ToolContext): Promise<ToolResult> => {
    const description = (args.description ?? '').trim();
    if (!description) return { ok: false, error: 'Please include what the complaint is about.' };

    const roomNumber = (args.roomNumber ?? ctx.currentRoomNumber ?? '').toString().trim() || null;

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
        guestName: args.guestName ?? null,
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
