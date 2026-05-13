// ─── Room action tools ────────────────────────────────────────────────────
// The five housekeeper-floor actions: mark clean, reset, toggle DND, flag
// issue, request help. Manager + owner can also mark/reset/toggle on behalf
// of housekeepers (operational override).
//
// These bypass the public-link /api/housekeeper/room-action route — those
// callers don't have a Supabase Auth session. The agent caller IS a
// signed-in user, so we just write directly via supabaseAdmin with our own
// auth check (role + property access already verified by executeTool).

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult, type ToolContext } from '../tools';
import { findRoomByNumber } from './_helpers';

// ─── mark_room_clean ──────────────────────────────────────────────────────

registerTool<{ roomNumber: string }>({
  name: 'mark_room_clean',
  description:
    'Mark a room as clean. Use when the user says variations like "302 clean", "marcar 302 limpia", "Im done with 305", "finished cleaning 410". Pass the room number as a string of digits (e.g. "302" not "three oh two").',
  inputSchema: {
    type: 'object',
    properties: {
      roomNumber: {
        type: 'string',
        description: 'The room number to mark clean, as a string of digits.',
      },
    },
    required: ['roomNumber'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk'],
  handler: async ({ roomNumber }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found in this property.` };

    // For housekeepers, also enforce that the room is assigned to them (matches the public-link route's policy).
    if (ctx.user.role === 'housekeeping' && room.assigned_to && room.assigned_to !== ctx.user.accountId) {
      return { ok: false, error: `Room ${roomNumber} is assigned to a different housekeeper.` };
    }

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
    properties: { roomNumber: { type: 'string', description: 'Room number as digits.' } },
    required: ['roomNumber'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk'],
  handler: async ({ roomNumber }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

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
      roomNumber: { type: 'string', description: 'Room number as digits.' },
      on: { type: 'boolean', description: 'true to enable DND, false to disable.' },
      note: { type: 'string', description: 'Optional reason note (only used when on=true).' },
    },
    required: ['roomNumber', 'on'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk'],
  handler: async ({ roomNumber, on, note }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

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
      roomNumber: { type: 'string', description: 'Room number as digits.' },
      note: { type: 'string', description: 'Description of the issue (max 500 chars).' },
    },
    required: ['roomNumber', 'note'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk', 'maintenance'],
  handler: async ({ roomNumber, note }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

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
      roomNumber: { type: 'string', description: 'Optional room number the help is about.' },
      message: { type: 'string', description: 'Optional short message describing what kind of help is needed.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk', 'maintenance'],
  handler: async ({ roomNumber, message }, ctx): Promise<ToolResult> => {
    // If a room was specified, flag the room. Always log the help request to nudges.
    let roomFlagged: string | null = null;
    if (roomNumber) {
      const room = await findRoomByNumber(ctx.propertyId, roomNumber);
      if (room) {
        await supabaseAdmin.from('rooms').update({ help_requested: true }).eq('id', room.id);
        roomFlagged = room.number;
      }
    }

    // Insert a nudge so any manager viewing the chat sees this immediately.
    // dedupe_key prevents the same user from spamming overlapping requests.
    const dedupeKey = `help:${ctx.user.accountId}:${roomFlagged ?? 'general'}`;
    await supabaseAdmin.from('agent_nudges').insert({
      user_id: ctx.user.accountId, // helps surface to manager via property index
      property_id: ctx.propertyId,
      category: 'operational',
      severity: 'urgent',
      payload: {
        summary: `${ctx.user.displayName} requested help${roomFlagged ? ` for room ${roomFlagged}` : ''}${message ? `: ${message}` : ''}`,
        type: 'help_request',
        requester_id: ctx.user.accountId,
        requester_name: ctx.user.displayName,
        room_number: roomFlagged,
        message: message ?? null,
      },
      dedupe_key: dedupeKey,
    });

    return {
      ok: true,
      data: {
        sent: true,
        roomFlagged,
        message: message ?? null,
      },
    };
  },
});
