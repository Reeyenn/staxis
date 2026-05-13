// ─── Manager-tier tools ───────────────────────────────────────────────────
// Assignment, staff performance, scheduling, SMS coordination.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber, findStaffByName } from './_helpers';

// ─── assign_room ──────────────────────────────────────────────────────────

registerTool<{ roomNumber: string; staffName: string }>({
  name: 'assign_room',
  description:
    'Assign a room to a specific housekeeper by name. Use when manager says "assign 302 to Maria" or "give 410 to Carlos". The name match is case-insensitive and partial.',
  inputSchema: {
    type: 'object',
    properties: {
      roomNumber: { type: 'string', description: 'Room number as digits.' },
      staffName: { type: 'string', description: 'Housekeeper name (first name is enough if unique).' },
    },
    required: ['roomNumber', 'staffName'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ roomNumber, staffName }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };
    const staff = await findStaffByName(ctx.propertyId, staffName);
    if (!staff) return { ok: false, error: `No active staff member matching "${staffName}".` };

    const { error } = await supabaseAdmin
      .from('rooms')
      .update({ assigned_to: staff.id })
      .eq('id', room.id);
    if (error) return { ok: false, error: 'Failed to assign room.' };

    return {
      ok: true,
      data: {
        roomNumber: room.number,
        assignedTo: staff.name,
        staffId: staff.id,
      },
    };
  },
});

// ─── get_staff_performance ────────────────────────────────────────────────

registerTool<{ period?: 'today' | 'week' | 'month' }>({
  name: 'get_staff_performance',
  description:
    'Get per-staff cleaning performance metrics over a period. Returns: name, rooms cleaned, average duration in minutes, flagged events. Period defaults to "today".',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time window.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ period = 'today' }, ctx): Promise<ToolResult> => {
    const today = new Date();
    let since: Date;
    if (period === 'today') {
      since = new Date(today.toISOString().slice(0, 10));
    } else if (period === 'week') {
      since = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      since = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    const sinceDate = since.toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin
      .from('cleaning_events')
      .select('staff_id, staff_name, duration_minutes, status, flag_reason')
      .eq('property_id', ctx.propertyId)
      .gte('date', sinceDate)
      .neq('status', 'discarded');
    if (error) return { ok: false, error: 'Failed to fetch performance.' };

    const byStaff = new Map<string, { name: string; count: number; totalDuration: number; flagged: number }>();
    for (const e of data ?? []) {
      const key = (e.staff_id as string) ?? 'unknown';
      const prev = byStaff.get(key) ?? { name: (e.staff_name as string) ?? 'Unknown', count: 0, totalDuration: 0, flagged: 0 };
      prev.count += 1;
      prev.totalDuration += Number(e.duration_minutes ?? 0);
      if (e.status === 'flagged') prev.flagged += 1;
      byStaff.set(key, prev);
    }
    const rows = Array.from(byStaff.values())
      .map(s => ({
        name: s.name,
        roomsCleaned: s.count,
        avgDurationMinutes: s.count ? Math.round((s.totalDuration / s.count) * 10) / 10 : 0,
        flaggedEvents: s.flagged,
      }))
      .sort((a, b) => b.roomsCleaned - a.roomsCleaned);

    return { ok: true, data: { period, rows } };
  },
});

// ─── send_help_sms ────────────────────────────────────────────────────────
// Manager-side: send a text to a specific staff member. Wraps the existing
// /api/help-request route's intent. For v1, we record an outbox nudge — the
// SMS-sender cron picks it up. This avoids embedding Twilio credentials here.

registerTool<{ staffName: string; message: string }>({
  name: 'send_help_sms',
  description:
    'Send a short SMS message to a specific staff member by name. Use when manager wants to ping a housekeeper directly (e.g. "tell Maria to come to the lobby"). Message will be sent via the existing SMS pipeline.',
  inputSchema: {
    type: 'object',
    properties: {
      staffName: { type: 'string', description: 'Staff member name.' },
      message: { type: 'string', description: 'Short message to send (max 320 chars).' },
    },
    required: ['staffName', 'message'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ staffName, message }, ctx): Promise<ToolResult> => {
    const staff = await findStaffByName(ctx.propertyId, staffName);
    if (!staff) return { ok: false, error: `No active staff member matching "${staffName}".` };
    if (!staff.phone) return { ok: false, error: `${staff.name} doesn't have a phone number on file.` };

    const trimmed = (message ?? '').slice(0, 320);
    if (!trimmed) return { ok: false, error: 'Message is empty.' };

    // Insert as a nudge with category 'operational' so the SMS dispatcher
    // (existing cron) can pick it up. Use a unique dedupe_key per send so
    // repeated identical sends are allowed.
    await supabaseAdmin.from('agent_nudges').insert({
      user_id: ctx.user.accountId,
      property_id: ctx.propertyId,
      category: 'operational',
      severity: 'info',
      payload: {
        summary: `Outbound SMS to ${staff.name}: ${trimmed}`,
        type: 'sms_outbox',
        recipient_staff_id: staff.id,
        recipient_name: staff.name,
        recipient_phone: staff.phone,
        message: trimmed,
        requested_by: ctx.user.displayName,
      },
      dedupe_key: null,
    });

    return {
      ok: true,
      data: { recipient: staff.name, message: trimmed, queued: true },
    };
  },
});

// ─── generate_schedule ────────────────────────────────────────────────────
// Stub for v1: explains the current state. Real schedule generation goes
// through /api/send-shift-confirmations and the existing ML routing.

registerTool<{ date?: string }>({
  name: 'generate_schedule',
  description:
    'Generate (or look up) the housekeeper schedule for a given date. Returns which housekeepers are scheduled and how many rooms each has assigned. Date format: YYYY-MM-DD. Defaults to today.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'ISO date YYYY-MM-DD. Defaults to today.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ date }, ctx): Promise<ToolResult> => {
    const target = date ?? new Date().toISOString().slice(0, 10);

    // Group assigned rooms by housekeeper for the target date.
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('assigned_to, status, number')
      .eq('property_id', ctx.propertyId)
      .eq('date', target)
      .not('assigned_to', 'is', null);
    if (error) return { ok: false, error: 'Failed to load schedule.' };

    const byStaff = new Map<string, { roomCount: number; rooms: string[] }>();
    for (const r of data ?? []) {
      const key = r.assigned_to as string;
      const prev = byStaff.get(key) ?? { roomCount: 0, rooms: [] };
      prev.roomCount += 1;
      prev.rooms.push(r.number as string);
      byStaff.set(key, prev);
    }

    // Resolve staff names.
    const ids = Array.from(byStaff.keys());
    const { data: staffRows } = ids.length
      ? await supabaseAdmin.from('staff').select('id, name').in('id', ids)
      : { data: [] };
    const nameById = new Map<string, string>();
    for (const s of staffRows ?? []) nameById.set(s.id as string, (s.name as string) ?? 'Unknown');

    const schedule = Array.from(byStaff.entries()).map(([id, info]) => ({
      staffId: id,
      name: nameById.get(id) ?? 'Unknown',
      roomCount: info.roomCount,
      rooms: info.rooms.sort(),
    })).sort((a, b) => b.roomCount - a.roomCount);

    return { ok: true, data: { date: target, schedule, totalAssigned: data?.length ?? 0 } };
  },
});

// ─── get_pms_status ───────────────────────────────────────────────────────
// Reads scraper_status — the heartbeat of the PMS sync.

registerTool<Record<string, never>>({
  name: 'get_pms_status',
  description:
    'Check the status of the PMS (Property Management System) connection. Returns when the last successful sync happened and whether anything is broken.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async (_, ctx): Promise<ToolResult> => {
    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('key, value, updated_at')
      .like('key', `${ctx.propertyId}%`);
    if (error) return { ok: false, error: 'Failed to read PMS status.' };

    const heartbeat = data?.find(r => (r.key as string).endsWith(':heartbeat'));
    const lastSync = data?.find(r => (r.key as string).endsWith(':last_sync'));
    const lastErr = data?.find(r => (r.key as string).endsWith(':last_error'));

    return {
      ok: true,
      data: {
        heartbeat: heartbeat?.updated_at ?? null,
        lastSuccessfulSync: lastSync?.value ?? null,
        lastError: lastErr?.value ?? null,
      },
    };
  },
});
