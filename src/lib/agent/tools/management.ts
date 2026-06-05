// ─── Manager-tier tools ───────────────────────────────────────────────────
// Assignment, staff performance, scheduling, SMS coordination.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber, findStaffByName } from './_helpers';
import { applyTimeOffDecision } from '@/lib/schedule/decide-time-off';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';

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
  mutates: true,
  handler: async ({ roomNumber, staffName }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.propertyId, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };
    const staff = await findStaffByName(ctx.propertyId, staffName);
    if (!staff) return { ok: false, error: `No active staff member matching "${staffName}".` };

    // Codex post-merge review 2026-05-13 (F2): dryRun gate.
    if (ctx.dryRun) {
      return {
        ok: true,
        data: { dryRun: true, roomNumber: room.number, assignedTo: staff.name, staffId: staff.id },
      };
    }

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

// ─── send_help_sms — REMOVED 2026-05-16 ──────────────────────────────────
// Security review Surface 3 found this tool was a "dead-letter producer":
// it inserted agent_nudges rows with payload type='sms_outbox', but
// nothing in the codebase reads that payload type and dispatches via
// Twilio. So a successful prompt injection couldn't send a real SMS
// today (P3 — no impact).
//
// HOWEVER the tool's description promised the model "will be sent via
// the existing SMS pipeline" — a future contributor who wires the
// dispatcher without ALSO adding per-conversation / per-property /
// per-day SMS count caps would silently turn this P3 into a P1
// cost-burn vector. (request_help is the safe alternative: dedup'd
// by (recipient, requester, room, msg-hash) and uses the operational
// nudge inbox that managers actually read.)
//
// Deleting the tool registration removes the trap. If outbound agent-
// initiated SMS is genuinely needed in the future, gate it on the
// Pattern F unified cost-cap primitive BEFORE re-introducing the tool.

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

    // Live room state now flows through the pms_* tables (the legacy `rooms`
    // table is empty post-Plan-v4). mergePmsRoomsForDate returns Room[] in the
    // legacy shape with assignedTo (resolved staffId) + assignedName already
    // name-resolved from pms_housekeeping_assignments, so we group by those
    // directly instead of re-querying `staff`.
    let mergedRooms;
    try {
      mergedRooms = await mergePmsRoomsForDate(ctx.propertyId, target);
    } catch {
      return { ok: false, error: 'Failed to load schedule.' };
    }

    // Group assigned rooms by housekeeper for the target date.
    const byStaff = new Map<string, { name: string; roomCount: number; rooms: string[] }>();
    let totalAssigned = 0;
    for (const r of mergedRooms) {
      if (!r.assignedTo) continue; // only rooms with a resolved housekeeper
      totalAssigned += 1;
      const key = r.assignedTo;
      const prev = byStaff.get(key) ?? { name: r.assignedName ?? 'Unknown', roomCount: 0, rooms: [] };
      prev.roomCount += 1;
      prev.rooms.push(r.number);
      byStaff.set(key, prev);
    }

    const schedule = Array.from(byStaff.entries()).map(([id, info]) => ({
      staffId: id,
      name: info.name,
      roomCount: info.roomCount,
      rooms: info.rooms.sort(),
    })).sort((a, b) => b.roomCount - a.roomCount);

    return { ok: true, data: { date: target, schedule, totalAssigned } };
  },
});

// ─── get_pms_status ───────────────────────────────────────────────────────
// Reads property_sessions (the per-hotel CUA worker state) — the Plan v4
// replacement for the dropped scraper_status table.

registerTool<Record<string, never>>({
  name: 'get_pms_status',
  description:
    'Check the status of the PMS (Property Management System) connection. Returns when the last successful sync happened and whether anything is broken.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async (_, ctx): Promise<ToolResult> => {
    const { data, error } = await supabaseAdmin
      .from('property_sessions')
      .select('status, paused_reason, last_poll_at, updated_at')
      .eq('property_id', ctx.propertyId)
      .maybeSingle();
    if (error) return { ok: false, error: 'Failed to read PMS status.' };
    if (!data) {
      return { ok: true, data: { heartbeat: null, lastSuccessfulSync: null, lastError: 'no active session' } };
    }
    return {
      ok: true,
      data: {
        heartbeat: data.updated_at,
        lastSuccessfulSync: data.last_poll_at,
        lastError: data.status !== 'running' ? (data.paused_reason ?? data.status) : null,
      },
    };
  },
});

// ─── get_time_off_requests ────────────────────────────────────────────────
// Lets a manager ask "any time-off requests?" and get a straight answer
// instead of hunting the schedule grid. Read-only; chat + general voice.

const TOR_STATUS_FILTERS = ['pending', 'approved', 'denied', 'all'] as const;

registerTool<{ status?: 'pending' | 'approved' | 'denied' | 'all' }>({
  name: 'get_time_off_requests',
  description:
    'List staff time-off (PTO) requests for this property. Use when a manager asks things like "any time-off requests?", "who wants time off?", or "show pending PTO". Returns each request\'s staff name, date, reason, and status. Defaults to pending requests only.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'approved', 'denied', 'all'],
        description: 'Which requests to return. Defaults to "pending".',
      },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  surfaces: ['chat', 'voice'],
  voiceModes: ['general'],
  handler: async ({ status }, ctx): Promise<ToolResult> => {
    const filter = TOR_STATUS_FILTERS.includes(status as typeof TOR_STATUS_FILTERS[number])
      ? (status as typeof TOR_STATUS_FILTERS[number])
      : 'pending';

    let query = supabaseAdmin
      .from('time_off_requests')
      .select('id, staff_id, request_date, reason, status, submitted_at')
      .eq('property_id', ctx.propertyId);
    if (filter !== 'all') query = query.eq('status', filter);

    const { data, error } = await query.order('request_date', { ascending: true }).limit(100);
    if (error) return { ok: false, error: 'Failed to load time-off requests.' };

    const rows = data ?? [];
    // Resolve staff names in one batched lookup.
    const ids = Array.from(new Set(rows.map(r => r.staff_id as string).filter(Boolean)));
    const { data: staffRows } = ids.length
      ? await supabaseAdmin.from('staff').select('id, name').in('id', ids)
      : { data: [] };
    const nameById = new Map<string, string>();
    for (const s of staffRows ?? []) nameById.set(s.id as string, (s.name as string) ?? 'Unknown');

    const requests = rows.map(r => ({
      staffName: nameById.get(r.staff_id as string) ?? 'Unknown',
      date: r.request_date as string,
      reason: (r.reason as string | null) ?? null,
      status: r.status as string,
      submittedAt: r.submitted_at as string,
    }));

    return { ok: true, data: { filter, count: requests.length, requests } };
  },
});

// ─── decide_time_off ──────────────────────────────────────────────────────
// Approve or deny a PENDING time-off request by staff name (+ optional date).
// Mutating + manager-only + chat-only (no voice approvals — a misheard "approve"
// shouldn't delete a shift). Shares the approve-cascade with the HTTP route via
// applyTimeOffDecision so the two surfaces can't drift.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

registerTool<{ staffName: string; decision: 'approve' | 'deny'; date?: string; denyReason?: string }>({
  name: 'decide_time_off',
  description:
    'Approve or deny a PENDING staff time-off request. Identify the request by the staff member\'s name; pass the date (YYYY-MM-DD) too when they have more than one pending request. Approving also clears that day\'s scheduled shift. Use only when the manager clearly says to approve or deny someone\'s time off.',
  inputSchema: {
    type: 'object',
    properties: {
      staffName: { type: 'string', description: 'Staff member whose request to decide (first name is enough if unique).' },
      decision: { type: 'string', enum: ['approve', 'deny'], description: 'approve or deny.' },
      date: { type: 'string', description: 'Optional ISO date YYYY-MM-DD to disambiguate when the staff member has multiple pending requests.' },
      denyReason: { type: 'string', description: 'Optional short reason shown to the staff member when denying.' },
    },
    required: ['staffName', 'decision'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  mutates: true,
  handler: async ({ staffName, decision, date, denyReason }, ctx): Promise<ToolResult> => {
    if (decision !== 'approve' && decision !== 'deny') {
      return { ok: false, error: 'decision must be "approve" or "deny".' };
    }
    if (date && !DATE_RE.test(date)) {
      return { ok: false, error: 'date must be in YYYY-MM-DD format.' };
    }

    // Strict name resolution — a MUTATING decision must never act on the wrong
    // person, so we refuse an ambiguous match instead of picking the first one
    // (unlike findStaffByName, which is fine for non-destructive lookups).
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name')
      .eq('property_id', ctx.propertyId)
      .eq('is_active', true);
    if (staffErr) return { ok: false, error: 'Failed to look up staff.' };
    const nameQuery = staffName.trim().toLowerCase();
    const allStaff = (staffRows ?? []).map(s => ({ id: s.id as string, name: (s.name as string) ?? '' }));
    const exact = allStaff.filter(s => s.name.toLowerCase() === nameQuery);
    const matches = exact.length > 0 ? exact : allStaff.filter(s => s.name.toLowerCase().includes(nameQuery));
    if (matches.length === 0) {
      return { ok: false, error: `No active staff member matching "${staffName}".` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple staff match "${staffName}": ${matches.map(s => s.name).join(', ')}. Use the full name.`,
      };
    }
    const staff = matches[0];

    let q = supabaseAdmin
      .from('time_off_requests')
      .select('id, request_date, reason')
      .eq('property_id', ctx.propertyId)
      .eq('staff_id', staff.id)
      .eq('status', 'pending');
    if (date) q = q.eq('request_date', date);
    const { data: pendingRows, error: pendErr } = await q.order('request_date', { ascending: true });
    if (pendErr) return { ok: false, error: 'Failed to look up the request.' };

    const rows = pendingRows ?? [];
    if (rows.length === 0) {
      return {
        ok: false,
        error: date
          ? `${staff.name} has no pending time-off request for ${date}.`
          : `${staff.name} has no pending time-off requests.`,
      };
    }
    if (rows.length > 1) {
      const dates = Array.from(new Set(rows.map(r => r.request_date as string)));
      if (!date && dates.length > 1) {
        return {
          ok: false,
          error: `${staff.name} has ${rows.length} pending requests (${dates.join(', ')}). Say which date to ${decision}.`,
        };
      }
      // A date was supplied but several still match, or several pending share
      // one date — can't safely auto-pick a mutating target. Defer to the UI.
      return {
        ok: false,
        error: `${staff.name} has ${rows.length} pending requests${date ? ` for ${date}` : ''}. Approve or deny them in the Schedule tab to be sure.`,
      };
    }

    const target = rows[0];

    // dryRun (eval runner): exercise the lookup path but skip the write.
    if (ctx.dryRun) {
      return {
        ok: true,
        data: { dryRun: true, staffName: staff.name, date: target.request_date, decision },
      };
    }

    const result = await applyTimeOffDecision({
      hotelId: ctx.propertyId,
      requestId: target.id as string,
      decision,
      denyReason,
      decidedBy: ctx.user.accountId,
    });
    if (!result.ok) {
      const msg = result.reason === 'already_decided'
        ? 'That request was already decided.'
        : result.reason === 'not_found'
          ? 'That request no longer exists.'
          : 'Failed to update the request.';
      return { ok: false, error: msg };
    }

    return {
      ok: true,
      data: {
        staffName: staff.name,
        date: result.requestDate,
        decision: decision === 'approve' ? 'approved' : 'denied',
        removedShift: result.removedShift,
      },
    };
  },
});
