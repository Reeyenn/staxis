// ─── Read-only query tools ────────────────────────────────────────────────
// Everything the agent can ASK the database. Mutations live elsewhere.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber } from './_helpers';

// ─── list_my_rooms ────────────────────────────────────────────────────────
// Housekeeper-only. Their assigned rooms with current status.

registerTool<Record<string, never>>({
  name: 'list_my_rooms',
  description:
    'List the rooms currently assigned to the user (housekeeper). Returns room number, status, and any flags (DND, issue, help requested) for each.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['housekeeping', 'maintenance'],
  handler: async (_, ctx): Promise<ToolResult> => {
    // `rooms.assigned_to` is a `staff.id` — must use ctx.staffId, NOT
    // ctx.user.accountId (different tables). Codex review fix #4, 2026-05-13.
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property. Ask the manager to link it before using the chat.' };
    }
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('number, status, is_dnd, issue_note, help_requested, type')
      .eq('property_id', ctx.propertyId)
      .eq('assigned_to', ctx.staffId)
      .order('number');
    if (error) return { ok: false, error: 'Failed to fetch assigned rooms.' };

    return {
      ok: true,
      data: {
        count: data?.length ?? 0,
        rooms: (data ?? []).map(r => ({
          number: r.number as string,
          status: r.status as string,
          type: r.type as string,
          dnd: !!r.is_dnd,
          issue: (r.issue_note as string) || null,
          helpRequested: !!r.help_requested,
        })),
      },
    };
  },
});

// ─── get_my_next_room ─────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_my_next_room',
  description:
    'Get the next room the housekeeper should clean (first non-clean, non-DND room from their assigned list).',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['housekeeping'],
  handler: async (_, ctx): Promise<ToolResult> => {
    // Codex review fix #4 — see list_my_rooms above.
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property. Ask the manager to link it before using the chat.' };
    }
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('number, status, is_dnd, type')
      .eq('property_id', ctx.propertyId)
      .eq('assigned_to', ctx.staffId)
      .in('status', ['dirty', 'in_progress'])
      .eq('is_dnd', false)
      .order('number')
      .limit(1);
    if (error) return { ok: false, error: 'Failed to find next room.' };

    if (!data?.length) {
      return { ok: true, data: { hasNext: false, message: 'No more rooms to clean — looks like you\'re done for the day.' } };
    }
    const r = data[0];
    return {
      ok: true,
      data: {
        hasNext: true,
        number: r.number,
        status: r.status,
        type: r.type,
      },
    };
  },
});

// ─── query_room_status ────────────────────────────────────────────────────

registerTool<{ roomNumber: string }>({
  name: 'query_room_status',
  description:
    'Get current status of a specific room. Returns status, assigned housekeeper, DND state, any flagged issues. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { roomNumber: { type: 'string', description: 'Room number as digits.' } },
    required: ['roomNumber'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  handler: async ({ roomNumber }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

    let assignedName: string | null = null;
    if (room.assigned_to) {
      const { data: staff } = await supabaseAdmin
        .from('staff')
        .select('name')
        .eq('id', room.assigned_to)
        .maybeSingle();
      if (staff) assignedName = (staff.name as string) ?? null;
    }

    return {
      ok: true,
      data: {
        number: room.number,
        status: room.status,
        type: room.type,
        assignedTo: assignedName,
        dnd: room.is_dnd,
        dndNote: room.dnd_note,
        issueNote: room.issue_note,
        helpRequested: room.help_requested,
        startedAt: room.started_at,
        completedAt: room.completed_at,
      },
    };
  },
});

// ─── get_today_summary ────────────────────────────────────────────────────
// Manager rollup. Used by "what's happening today" or "give me today's status".

registerTool<Record<string, never>>({
  name: 'get_today_summary',
  description:
    'Get a quick rollup of today: rooms cleaned so far, in progress, dirty, DND, active issues, help requests. Useful when the manager asks "how are we doing today?".',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  handler: async (_, ctx): Promise<ToolResult> => {
    const today = new Date().toISOString().slice(0, 10);

    const { data: rooms } = await supabaseAdmin
      .from('rooms')
      .select('status, is_dnd, issue_note, help_requested, completed_at')
      .eq('property_id', ctx.propertyId);
    const { data: events } = await supabaseAdmin
      .from('cleaning_events')
      .select('staff_id, duration_minutes, status')
      .eq('property_id', ctx.propertyId)
      .eq('date', today)
      .neq('status', 'discarded');

    let dirty = 0, inProgress = 0, clean = 0, dnd = 0, issues = 0, helpRequests = 0;
    for (const r of rooms ?? []) {
      if (r.is_dnd) dnd++;
      else if (r.status === 'dirty') dirty++;
      else if (r.status === 'in_progress') inProgress++;
      else if (r.status === 'clean' || r.status === 'inspected') clean++;
      if (r.issue_note) issues++;
      if (r.help_requested) helpRequests++;
    }

    const eventCount = events?.length ?? 0;
    const totalDuration = (events ?? []).reduce(
      (acc, e) => acc + Number(e.duration_minutes ?? 0),
      0,
    );
    const avgDuration = eventCount ? totalDuration / eventCount : 0;
    const uniqueStaff = new Set((events ?? []).map(e => e.staff_id)).size;

    return {
      ok: true,
      data: {
        today,
        rooms: { dirty, inProgress, clean, dnd, total: rooms?.length ?? 0 },
        issues,
        helpRequests,
        cleaningEvents: {
          count: eventCount,
          avgDurationMinutes: Math.round(avgDuration * 10) / 10,
          totalLaborMinutes: Math.round(totalDuration),
          uniqueStaff,
        },
      },
    };
  },
});

// ─── get_deep_clean_queue ─────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_deep_clean_queue',
  description:
    'List rooms currently scheduled for deep cleaning (longer than standard turn). Returns room number, scheduled date, and status. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  handler: async (_, ctx): Promise<ToolResult> => {
    // Deep clean for v1 = stayovers on day 2 of their stay (industry convention:
    // a longer-than-standard refresh on the second day of a multi-night stay).
    // The schema tracks this via rooms.stayover_day (1 or 2). True "deep cleans"
    // (e.g. carpet shampooing, full reset) aren't yet modelled as a separate
    // column — we return what the schema supports and surface a note.
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('number, status, type, stayover_day, completed_at')
      .eq('property_id', ctx.propertyId)
      .eq('date', today)
      .eq('type', 'stayover')
      .eq('stayover_day', 2);
    if (error) {
      return { ok: true, data: { queue: [], note: 'Deep clean queue could not be loaded.' } };
    }

    return {
      ok: true,
      data: {
        count: data?.length ?? 0,
        note: 'Showing stayover-day-2 rooms (the longer mid-stay refresh). Full reset deep cleans are not yet tracked as a separate category.',
        queue: (data ?? []).map(r => ({
          number: r.number,
          status: r.status,
          type: r.type,
          stayoverDay: r.stayover_day,
          lastCompleted: r.completed_at,
        })),
      },
    };
  },
});
