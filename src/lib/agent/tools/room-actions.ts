// ─── Room action tools ────────────────────────────────────────────────────
// The five housekeeper-floor actions: mark clean, reset, toggle DND, flag
// issue, request help. Manager + owner can also mark/reset/toggle on behalf
// of housekeepers (operational override).
//
// These bypass the public-link /api/housekeeper/room-action route — those
// callers don't have a Supabase Auth session. The agent caller IS a
// signed-in user, so we just write directly via supabaseAdmin with our own
// auth check (role + property access already verified by executeTool).
//
// Floor-role scope enforcement: every housekeeping/maintenance-allowed
// MUTATION uses `assertFloorRoleCanMutateRoom` from _helpers — verifies the
// caller's staffId matches the room's assigned_to, refuses otherwise. Codex
// review fix C2 (2026-05-13): previously only mark_room_clean had this
// check, so a housekeeper could reset/DND/flag any room in the property.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber, assertFloorRoleCanMutateRoom } from './_helpers';
import { getNudgeRecipients } from '../nudges';

// JSON Schema fragment reused by every tool that takes a room number. Adds
// a regex pattern so the model emits clean digit-or-suite-letter strings
// instead of integers (which would throw inside .trim()). Codex review fix B4.
const ROOM_NUMBER_SCHEMA = {
  type: 'string' as const,
  pattern: '^[0-9]+[A-Za-z]?$',
  description: 'Room number as digits, optionally followed by a letter suffix (e.g. "302", "410B").',
};

// ─── mark_room_clean ──────────────────────────────────────────────────────

registerTool<{ roomNumber: string }>({
  name: 'mark_room_clean',
  description:
    'Mark a room as clean. Use when the user says variations like "302 clean", "marcar 302 limpia", "Im done with 305", "finished cleaning 410". Pass the room number as a string of digits (e.g. "302" not "three oh two").',
  inputSchema: {
    type: 'object',
    properties: { roomNumber: ROOM_NUMBER_SCHEMA },
    required: ['roomNumber'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk'],
  handler: async ({ roomNumber }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found in this property.` };

    const scopeError = assertFloorRoleCanMutateRoom(room, ctx);
    if (scopeError) return { ok: false, error: scopeError };

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('rooms')
      .update({
        status: 'clean',
        completed_at: now,
        started_at: room.started_at ?? now,
      })
      .eq('id', room.id);
    if (error) return { ok: false, error: 'Failed to mark room clean. Please try again.' };

    return {
      ok: true,
      data: {
        roomNumber: room.number,
        previousStatus: room.status,
        newStatus: 'clean',
        completedAt: now,
      },
    };
  },
});

// ─── reset_room ───────────────────────────────────────────────────────────

registerTool<{ roomNumber: string }>({
  name: 'reset_room',
  description:
    'Reset a room back to dirty status. Use when a housekeeper says they marked the wrong room clean, or a manager wants to undo a clean status. Pass room number as digits.',
  inputSchema: {
    type: 'object',
    properties: { roomNumber: ROOM_NUMBER_SCHEMA },
    required: ['roomNumber'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk'],
  handler: async ({ roomNumber }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

    const scopeError = assertFloorRoleCanMutateRoom(room, ctx);
    if (scopeError) return { ok: false, error: scopeError };

    const { error } = await supabaseAdmin
      .from('rooms')
      .update({ status: 'dirty', started_at: null, completed_at: null })
      .eq('id', room.id);
    if (error) return { ok: false, error: 'Failed to reset room.' };

    return {
      ok: true,
      data: {
        roomNumber: room.number,
        previousStatus: room.status,
        newStatus: 'dirty',
      },
    };
  },
});

// ─── toggle_dnd ───────────────────────────────────────────────────────────

registerTool<{ roomNumber: string; on: boolean; note?: string }>({
  name: 'toggle_dnd',
  description:
    'Mark a room as Do-Not-Disturb (on=true) or remove the DND flag (on=false). Use when guest hangs DND sign, or to clear it when guest leaves.',
  inputSchema: {
    type: 'object',
    properties: {
      roomNumber: ROOM_NUMBER_SCHEMA,
      on: { type: 'boolean', description: 'true to enable DND, false to disable.' },
      note: { type: 'string', description: 'Optional reason note (only used when on=true).' },
    },
    required: ['roomNumber', 'on'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk'],
  handler: async ({ roomNumber, on, note }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

    const scopeError = assertFloorRoleCanMutateRoom(room, ctx);
    if (scopeError) return { ok: false, error: scopeError };

    const updates: Record<string, unknown> = { is_dnd: on };
    if (on) updates.dnd_note = note ?? null;
    else updates.dnd_note = null;

    const { error } = await supabaseAdmin.from('rooms').update(updates).eq('id', room.id);
    if (error) return { ok: false, error: 'Failed to toggle DND.' };

    return { ok: true, data: { roomNumber: room.number, dnd: on, note: note ?? null } };
  },
});

// ─── flag_issue ───────────────────────────────────────────────────────────

registerTool<{ roomNumber: string; note: string }>({
  name: 'flag_issue',
  description:
    'Flag an issue or problem with a room (e.g. "broken TV in 302", "missing towels in 410"). Records the note for the manager to see. Use when the user describes a problem they noticed during cleaning or inspection.',
  inputSchema: {
    type: 'object',
    properties: {
      roomNumber: ROOM_NUMBER_SCHEMA,
      note: { type: 'string', description: 'Description of the issue (max 500 chars).' },
    },
    required: ['roomNumber', 'note'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk', 'maintenance'],
  handler: async ({ roomNumber, note }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

    const scopeError = assertFloorRoleCanMutateRoom(room, ctx);
    if (scopeError) return { ok: false, error: scopeError };

    const trimmed = (note ?? '').slice(0, 500);
    const { error } = await supabaseAdmin
      .from('rooms')
      .update({ issue_note: trimmed || null })
      .eq('id', room.id);
    if (error) return { ok: false, error: 'Failed to flag issue.' };

    return { ok: true, data: { roomNumber: room.number, issue: trimmed } };
  },
});

// ─── request_help ─────────────────────────────────────────────────────────

registerTool<{ roomNumber?: string; message?: string }>({
  name: 'request_help',
  description:
    'Send a help signal to the manager. Use when a housekeeper says "I need help", "help me", "necesito ayuda", or describes a situation needing manager attention. Optionally include a room number and a short message.',
  inputSchema: {
    type: 'object',
    properties: {
      roomNumber: { ...ROOM_NUMBER_SCHEMA, description: 'Optional room number the help is about.' },
      message: { type: 'string', description: 'Optional short message describing what kind of help is needed.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk', 'maintenance'],
  handler: async ({ roomNumber, message }, ctx): Promise<ToolResult> => {
    // For housekeepers/maintenance, scope by staffId. Managers can flag
    // help on any room (operational override).
    let roomFlagged: string | null = null;
    if (roomNumber) {
      const room = await findRoomByNumber(ctx.propertyId, roomNumber);
      if (room) {
        const scopeError = assertFloorRoleCanMutateRoom(room, ctx);
        if (scopeError) return { ok: false, error: scopeError };
        await supabaseAdmin.from('rooms').update({ help_requested: true }).eq('id', room.id);
        roomFlagged = room.number;
      }
    }

    // Route the help nudge to the people who can act on it — owners and
    // general managers of this property. Insert one nudge per recipient
    // with user_id matching their account so the agent_nudges_select_own
    // RLS policy lets each manager see it. Codex review fix #B1: the
    // previous version inserted with user_id=requester, which hid the
    // nudge from every manager via RLS.
    const recipients = await getNudgeRecipients(ctx.propertyId);
    const summary = `${ctx.user.displayName} requested help${roomFlagged ? ` for room ${roomFlagged}` : ''}${message ? `: ${message}` : ''}`;

    if (recipients.length === 0) {
      // No manager / owner is linked to this property — surface that to the
      // user. We don't silently fail because the housekeeper expects someone
      // to come help.
      return {
        ok: false,
        error: 'No manager or owner is linked to this property to receive the request. Ask your supervisor.',
      };
    }

    const rows = recipients.map(managerAccountId => ({
      user_id: managerAccountId,
      property_id: ctx.propertyId,
      category: 'operational' as const,
      severity: 'urgent' as const,
      payload: {
        summary,
        type: 'help_request',
        requester_id: ctx.user.accountId,
        requester_name: ctx.user.displayName,
        room_number: roomFlagged,
        message: message ?? null,
      },
      // Dedupe per recipient + requester + room so the same housekeeper
      // can't spam multiple unresolved help nudges for the same room.
      dedupe_key: `help:${managerAccountId}:${ctx.user.accountId}:${roomFlagged ?? 'general'}`,
    }));

    const { error } = await supabaseAdmin.from('agent_nudges').insert(rows);
    if (error) {
      console.error('[request_help] failed to insert nudges', error);
      return { ok: false, error: 'Failed to deliver the help request. Try again or ask your supervisor directly.' };
    }

    return {
      ok: true,
      data: {
        sent: true,
        recipientCount: recipients.length,
        roomFlagged,
        message: message ?? null,
      },
    };
  },
});
