// ─── Manager-tier tools ───────────────────────────────────────────────────
// Assignment, staff performance, scheduling, SMS coordination.

import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber, findStaffByName } from './_helpers';
import { newestSignalAt, parseFeedHealthRows } from '@/lib/pms/feed-health';
import { applyTimeOffDecision } from '@/lib/schedule/decide-time-off';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { applyRoomUpdate } from '@/lib/pms-rooms-writes';

// ─── assign_room ──────────────────────────────────────────────────────────

registerTool<{ roomNumber: string; staffName: string }>({
  name: 'assign_room',
  section: 'housekeeping',
  description:
    'Give one room to one housekeeper. ' +
    'Use when: a manager says "assign 302 to Maria", "give 410 to Carlos", "pon la 215 a Ana". To see the current split first use get_room_assignments. ' +
    'Args: roomNumber — the room as the hotel writes it. staffName — the housekeeper; a first name is enough when it is unique, matched case-insensitively. ' +
    'Returns: the room number and the resolved staff member the room was handed to. This is a proposal — the manager approves it on a card before anything changes. ' +
    'Refuses: an unknown room, and any staff name that does not match an active staff member on this hotel. It moves ONE room at a time and cannot rebalance a whole board — do not promise to redistribute a shift.',
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
  approval: 'card',
  handler: async ({ roomNumber, staffName }, ctx): Promise<ToolResult> => {
    const room = await findRoomByNumber(ctx.db, roomNumber);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };
    const staff = await findStaffByName(ctx.db, staffName);
    if (!staff) return { ok: false, error: `No active staff member matching "${staffName}".` };

    // Codex post-merge review 2026-05-13 (F2): dryRun gate.
    if (ctx.dryRun) {
      return {
        ok: true,
        data: { dryRun: true, roomNumber: room.number, assignedTo: staff.name, staffId: staff.id },
      };
    }

    // Repoints rooms.assigned_to → pms_housekeeping_assignments.housekeeper_name
    // (applyRoomUpdate resolves the staff UUID to the canonical name and fails
    // closed if the staff isn't on this property).
    try {
      await applyRoomUpdate(ctx.propertyId, room.id, { assignedTo: staff.id });
    } catch {
      return { ok: false, error: 'Failed to assign room.' };
    }

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
  section: 'staff',
  // Reads cleaning_events (Staxis's own labor audit trail), not a pms_ table.
  pmsFreshness: 'independent',
  description:
    'Per-housekeeper cleaning numbers over a period: rooms done, average minutes per room, and how many cleans were flagged. ' +
    'Use when: a manager asks "how is Maria doing", "who cleaned the most this week", "average time per room", "quién limpió más". For the hotel-wide labor total use get_today_summary. ' +
    'Args: period — "today" (default), "week" (last 7 days) or "month" (last 30). ' +
    'Returns: { period, rows[] } sorted by rooms cleaned, each with name, roomsCleaned, avgDurationMinutes and flaggedEvents. The averages are computed here — quote them, never divide totals yourself. ' +
    'Refuses: nothing, but these are counts of logged cleaning events, not a judgement of anyone. Do not rank staff as better or worse, recommend discipline, or infer effort from duration — a long clean is often a hard room. Discarded events are already excluded; someone missing from the list logged nothing, which is not the same as doing nothing.',
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

    const { data, error } = await ctx.db
      .from('cleaning_events')
      .select('staff_id, staff_name, duration_minutes, status, flag_reason')
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

// ─── get_room_assignments ─────────────────────────────────────────────────
// RENAMED from generate_schedule (2026-07-27), not merged — it does something
// real, but its old name described something it cannot do. It has never
// generated a schedule; it reads pms_housekeeping_assignments through the merge
// and groups today's rooms by housekeeper. A tool called "generate_schedule"
// invites the model to promise a manager a schedule it will then not build,
// which is the fake-success failure mode INV-41 exists to stop. Real schedule
// generation goes through /api/send-shift-confirmations and the ML routing.
//
// The workload split it reports is also a different question from get_schedule
// (who is on the clock, out of scheduled_shifts) — under the old name the two
// looked like rival answers to "what's the schedule?".

registerTool<{ date?: string }>({
  name: 'get_room_assignments',
  section: 'staff',
  // Room assignments come from pms_housekeeping_assignments via the merge.
  pmsFreshness: 'stamped',
  description:
    'Show how a day\'s rooms are split between housekeepers — who is carrying which rooms, and how many each. ' +
    'Use when: a manager asks "who has which rooms", "how many rooms does Maria have", "is anyone overloaded today", "cómo están repartidos los cuartos". For who is on the clock use get_schedule; to change an assignment use assign_room. ' +
    'Args: date — ISO YYYY-MM-DD; defaults to today. ' +
    'Returns: { date, totalAssigned, schedule[] } where each entry is a housekeeper with their room count and their room numbers, sorted heaviest load first. The counts are computed here — quote them rather than counting room lists. Carries asOf; quote it. ' +
    'Refuses: it cannot BUILD or change a schedule — it only reports the assignments the PMS already holds. If the manager asks you to create, balance or rebalance a schedule, say plainly that you can show the split but the assignments have to be made in the PMS or the Schedule tab. Rooms with no housekeeper resolved are left out of the split entirely, so the room counts may not add up to the hotel\'s board.',
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
// WAS BROKEN, NOT MERELY MIS-POINTED (fixed 2026-07-24, D4).
//
// The previous handler selected `last_poll_at` from property_sessions. That
// column has never existed — 0201 defines last_alive_at and
// last_successful_read_at only (verified against live Postgres). PostgREST
// answered 42703 on EVERY call, the handler took its error branch, and every
// manager who asked the copilot "is the PMS connected?" got
// "Failed to read PMS status." The tool has been dead since it shipped.
//
// It now answers the question the report era actually has: not "is a robot
// logged in" but "are this hotel's reports arriving, and how old is what we
// have". Source: pms_feed_health_v1 (migration 0339) — the single definition
// of feed freshness. A hotel with no report expectations configured returns a
// clear "not set up yet", never an error.

const FEED_STATE_SENTENCE: Record<string, (label: string, mins: number | null) => string> = {
  live: (label) => `${label}: arriving on time`,
  stale: (label, mins) =>
    `${label}: last report is ${mins === null ? 'overdue' : `${Math.round(mins)} min past due`}`,
  learning: (label) => `${label}: nothing usable yet (report format still being learned)`,
  unavailable: (label) => `${label}: this hotel does not send this report`,
};

registerTool<Record<string, never>>({
  name: 'get_pms_status',
  // The freshness fields ARE the answer to this tool's question.
  pmsFreshness: 'stamped',
  description:
    'Whether this hotel\'s PMS reports are arriving, and how old its numbers are. ' +
    'Use when: the user asks "is the PMS connected", "how old are these numbers", "are the reports coming through", "why does this look out of date", or doubts a figure you just gave them — this is how you check before defending it. For whether STAXIS itself checked the hotel overnight use staxis_checked_last_night; the two are different questions. ' +
    'Takes no arguments. ' +
    'Returns: { configured, feeds[], summary, asOf } — one entry per report feed with its state (arriving on time / late / still being learned / not sent by this hotel), when it last arrived, how many minutes late it is, and any rows stuck in quarantine. ' +
    'Refuses: nothing. A hotel with `configured: false` is not broken — it simply runs Staxis without a PMS connection and its numbers come from the app itself, so say that rather than reporting a fault.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async (_, ctx): Promise<ToolResult> => {
    const { data, error } = await ctx.db
      .from('pms_feed_health_v1')
      .select(
        'property_id, feed_key, label, required, target_table, legacy_target, report_type, enabled, ' +
          'cadence_kind, expected_every_minutes, expected_at_local, timezone, grace_minutes, alert_channel, ' +
          'last_report_at, last_delivery_at, last_signal_at, minutes_late, ' +
          'open_quarantine_count, open_unmapped_count, state',
      );
    if (error) return { ok: false, error: 'Failed to read PMS report health.' };

    const rows = parseFeedHealthRows(data);
    if (rows.length === 0) {
      return {
        ok: true,
        data: {
          configured: false,
          feeds: [],
          summary:
            'This hotel has no PMS report schedule set up in Staxis, so its numbers come from the app itself rather than the PMS.',
        },
      };
    }

    const feeds = rows.map((r) => ({
      feedKey: r.feedKey,
      label: r.label,
      state: r.state,
      required: r.required,
      lastReportAt: r.lastSignalAt,
      minutesLate: r.minutesLate === null ? null : Math.round(r.minutesLate),
      openQuarantineCount: r.openQuarantineCount,
      openUnmappedCount: r.openUnmappedCount,
    }));

    const problems = rows.filter((r) => r.enabled && (r.state === 'stale' || r.state === 'learning'));
    const summary =
      problems.length === 0
        ? `All ${rows.filter((r) => r.enabled).length} expected report(s) are arriving on time.`
        : problems
            .map((r) => (FEED_STATE_SENTENCE[r.state] ?? ((l: string) => l))(r.label, r.minutesLate))
            .join('. ') + '.';

    return {
      ok: true,
      data: {
        configured: true,
        feeds,
        // The property-level "as of" the copilot quotes. stampFreshness may
        // refine it, but a handler-supplied asOf wins, and this one is exact.
        asOf: newestSignalAt(rows),
        summary,
      },
    };
  },
});

// ─── get_time_off_requests ────────────────────────────────────────────────
// Lets a manager ask "any time-off requests?" and get a straight answer
// instead of hunting the schedule grid. Read-only chat tool.

const TOR_STATUS_FILTERS = ['pending', 'approved', 'denied', 'all'] as const;

registerTool<{ status?: 'pending' | 'approved' | 'denied' | 'all' }>({
  name: 'get_time_off_requests',
  pmsFreshness: 'independent', // Staxis's own time-off table — genuinely live
  section: 'staff',
  description:
    'List staff time-off (PTO) requests at this hotel. ' +
    'Use when: a manager asks "any time-off requests", "who wants time off", "show pending PTO", "quién pidió días". To approve or deny one, read it here first and then use decide_time_off. ' +
    'Args: status — "pending" (default), "approved", "denied", or "all". ' +
    'Returns: { filter, count, requests[] } with each request\'s staff name, date, reason and status, oldest date first. ' +
    'Refuses: nothing, and it changes nothing — reading a request never approves it. Do not tell anyone their time off is granted on the strength of this list.',
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
  surfaces: ['chat'],
  handler: async ({ status }, ctx): Promise<ToolResult> => {
    const filter = TOR_STATUS_FILTERS.includes(status as typeof TOR_STATUS_FILTERS[number])
      ? (status as typeof TOR_STATUS_FILTERS[number])
      : 'pending';

    let query = ctx.db
      .from('time_off_requests')
      .select('id, staff_id, request_date, reason, status, submitted_at');
    if (filter !== 'all') query = query.eq('status', filter);

    const { data, error } = await query.order('request_date', { ascending: true }).limit(100);
    if (error) return { ok: false, error: 'Failed to load time-off requests.' };

    const rows = data ?? [];
    // Resolve staff names in one batched lookup.
    const ids = Array.from(new Set(rows.map(r => r.staff_id as string).filter(Boolean)));
    const { data: staffRows } = ids.length
      ? await ctx.db.from('staff').select('id, name').in('id', ids)
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
// Mutating + manager-only + chat-only. Shares the approve-cascade with the HTTP
// route via
// applyTimeOffDecision so the two surfaces can't drift.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

registerTool<{ staffName: string; decision: 'approve' | 'deny'; date?: string; denyReason?: string }>({
  name: 'decide_time_off',
  section: 'staff',
  description:
    'Approve or deny ONE pending staff time-off request. ' +
    'Use when: a manager clearly decides — "approve Maria\'s Friday", "deny Carlos for Saturday", "dale el permiso a Ana". Never on a hint, a maybe, or a question about someone\'s request; read it with get_time_off_requests instead. ' +
    'Args: staffName — whose request, a first name if unique. decision — "approve" or "deny". date — YYYY-MM-DD, required in practice whenever the person has more than one request pending. denyReason — a short reason shown to the staff member when denying. ' +
    'Returns: the staff name, the date decided, the decision, and whether that day\'s scheduled shift was removed. Approving DOES clear the shift — say so, because the manager may not expect it. This is a proposal until they approve the card. ' +
    'Refuses: a staff name matching more than one active person, a name with no pending request, and any case where several pending requests still match after the date — it will not guess which day to act on, and tells the manager to use the Schedule tab. It also cannot reverse a decision already made.',
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
  approval: 'card',
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
    const { data: staffRows, error: staffErr } = await ctx.db
      .from('staff')
      .select('id, name')
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

    let q = ctx.db
      .from('time_off_requests')
      .select('id, request_date, reason')
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
          : result.reason === 'past_date'
            ? 'Past time-off requests cannot be approved.'
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
