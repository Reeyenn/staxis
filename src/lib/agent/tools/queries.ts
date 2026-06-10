// ─── Read-only query tools ────────────────────────────────────────────────
// Everything the agent can ASK the database. Mutations live elsewhere.
//
// Plan v4 data source (2026-06): the legacy `rooms` table was dropped /
// emptied. Live room status now flows into the service-role-only `pms_*`
// tables written by the persistent CUA browser per hotel. These tools used
// to read the legacy rooms table (which now returns ZERO rows, so the agent
// saw nothing). They now read through the canonical server-only bridges:
//
//   • Per-room LIST  → mergePmsRoomsForDate(pid, date) — returns Room[] in
//     the legacy camel-cased shape (pms_rooms_inventory + status_log +
//     assignments + reservations + staff, merged + name-resolved).
//   • Day COUNTS     → fetchTodayPropertyCounts (today_property_counts_v1
//     RPC) — cheaper than the 5-query merge; used on the manager rollup so
//     the per-turn agent path doesn't pay for a full room fetch when it
//     only needs aggregates.
//
// "Current date": there is no `rooms.date` column anymore, so we can't pick
// the most-recent seeded date. Instead we compute the property-LOCAL today
// (getPropertyToday below) the same way /api/admin/doctor does
// (Intl.DateTimeFormat('en-CA', { timeZone: properties.timezone })). For a
// limited-service hotel in CST/CDT this avoids the ~5-hour UTC-vs-local
// drift every evening.
//
// Workflow-only fields (issueNote / dndNote / helpRequested / pause /
// exception / checklist / rush / inspection) are NOT in the merge shape yet
// — they'll come from a future overlay table. Where this file used to read
// them off `rooms`, they're now surfaced as null/0 with a `TODO(overlay)`
// marker. They were empty in practice anyway (CUA doesn't write them), so
// behaviour is preserved, not regressed.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { buildHotelSnapshot } from '../context';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { fetchTodayPropertyCounts } from '@/lib/db/today-room-work';
import type { Room } from '@/types';

// ─── getPropertyToday ───────────────────────────────────────────────────────
// Property-local "today" as YYYY-MM-DD. Mirrors the doctor's approach
// (route.ts ~L3958): format `new Date()` in the property's IANA timezone via
// Intl.DateTimeFormat('en-CA', …) so we get an unambiguous ISO date, falling
// back to UTC today when the property has no timezone set or the zone string
// is invalid. Replaces the old getCurrentRoomsDate(`rooms`.date max) which
// can no longer work — `rooms` is empty and has no usable date column.
// Exported so the PMS money/booking feed tools (tools/pms-feeds.ts) share the
// same property-local "today" derivation.
export async function getPropertyToday(propertyId: string): Promise<string> {
  let timezone: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', propertyId)
      .maybeSingle();
    timezone = (data?.timezone as string) ?? null;
  } catch {
    // non-fatal — fall through to UTC today
  }
  try {
    return timezone
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      : new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ─── get_hotel_state ──────────────────────────────────────────────────────
// Returns the same HotelSnapshot the system prompt today embeds inline. The
// goal (audit cost recommendation: snapshot → tool) is to move the snapshot
// out of every-turn prompt overhead and onto an explicit tool call so the
// model only pays the token cost when it actually needs the data.
//
// Today the system prompt still embeds the snapshot inline (in
// src/lib/agent/prompts.ts buildSystemPrompt). Until the user has run agent
// evals against the snapshot-via-tool pattern, the prompt stays the way it
// is. Once evals confirm no regression, edit the agent_prompts row (or
// PROMPT_BASE in prompts.ts) to:
//   1. Drop "Use the hotel snapshot in your context to answer ..." line
//   2. Replace with "Call get_hotel_state() to check current occupancy ..."
// and stop calling formatSnapshotForPrompt() in buildSystemPrompt.
//
// Audit recommendation #1 / first-principle #1 in
// .claude/reports/cost-hotpaths-audit.md.

registerTool<Record<string, never>>({
  name: 'get_hotel_state',
  description:
    'Get a live snapshot of the hotel: occupancy (dirty/clean/in-progress/DND), staff active today, and (for housekeepers) the user\'s assigned rooms. Read-only. Use when the user asks about current property state ("what\'s our occupancy", "how many DND rooms", "what\'s next for me").',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  handler: async (_, ctx): Promise<ToolResult> => {
    try {
      // Reuses the 30 s in-process cache in buildHotelSnapshot so back-to-back
      // tool calls within one request don't double-fetch.
      const snapshot = await buildHotelSnapshot(ctx.propertyId, ctx.user.role, ctx.staffId);
      return { ok: true, data: snapshot };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to load hotel state.' };
    }
  },
});

// ─── list_my_rooms ────────────────────────────────────────────────────────
// Housekeeper-only. Their assigned rooms with current status.

registerTool<Record<string, never>>({
  name: 'list_my_rooms',
  description:
    'List the rooms currently assigned to the user (housekeeper). Returns room number, status, and any flags (DND, issue, help requested) for each.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['housekeeping', 'maintenance'],
  handler: async (_, ctx): Promise<ToolResult> => {
    // Room.assignedTo is a `staff.id` (resolved by the merge layer from the
    // PMS housekeeper name) — must use ctx.staffId, NOT ctx.user.accountId
    // (different tables). Codex review fix #4, 2026-05-13.
    if (!ctx.staffId) {
      return { ok: false, error: 'Your account isn\'t linked to a staff record on this property. Ask the manager to link it before using the chat.' };
    }
    // Plan v4: read today's rooms from pms_* via the merge bridge, then
    // filter to this housekeeper's assignments. Date scoping is mandatory —
    // mergePmsRoomsForDate is per-(property, date), so the user only sees
    // today, not every day they've ever been assigned.
    const today = await getPropertyToday(ctx.propertyId);
    let rooms: Room[];
    try {
      rooms = await mergePmsRoomsForDate(ctx.propertyId, today);
    } catch {
      return { ok: false, error: 'Failed to fetch assigned rooms.' };
    }
    const mine = rooms.filter(r => r.assignedTo === ctx.staffId);

    return {
      ok: true,
      data: {
        count: mine.length,
        rooms: mine.map(r => ({
          number: r.number,
          status: r.status,
          type: r.type,
          dnd: !!r.isDnd,
          // TODO(overlay): issueNote / helpRequested come from a future
          // workflow overlay table; the pms_* merge shape doesn't carry
          // them yet (they were empty on `rooms` in practice too).
          issue: r.issueNote ?? null,
          helpRequested: !!r.helpRequested,
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
    const today = await getPropertyToday(ctx.propertyId);
    let rooms: Room[];
    try {
      rooms = await mergePmsRoomsForDate(ctx.propertyId, today);
    } catch {
      return { ok: false, error: 'Failed to find next room.' };
    }
    // First non-clean, non-DND room assigned to this housekeeper, by room
    // number — same ordering the old `rooms` query used (.order('number')).
    const next = rooms
      .filter(r =>
        r.assignedTo === ctx.staffId &&
        (r.status === 'dirty' || r.status === 'in_progress') &&
        !r.isDnd,
      )
      .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))[0];

    if (!next) {
      return { ok: true, data: { hasNext: false, message: 'No more rooms to clean — looks like you\'re done for the day.' } };
    }
    return {
      ok: true,
      data: {
        hasNext: true,
        number: next.number,
        status: next.status,
        type: next.type,
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
    // Plan v4: the old `rooms` PostgREST FK-embed
    // (assignee:staff!rooms_assigned_to_fkey) is impossible against the
    // pms_* merge — there's no `rooms` table to embed off, and the merge
    // already name-resolves the assignee. Read today's merged rooms and
    // find the requested number; use Room.assignedName (the PMS housekeeper
    // name) for the assignee, falling back to assignedTo (a staff id) only
    // if no name was on the assignment.
    const normalized = String(roomNumber ?? '').trim();
    if (!normalized) return { ok: false, error: `Room ${roomNumber} not found.` };

    const today = await getPropertyToday(ctx.propertyId);
    let rooms: Room[];
    try {
      rooms = await mergePmsRoomsForDate(ctx.propertyId, today);
    } catch {
      return { ok: false, error: `Room ${roomNumber} not found.` };
    }
    const room = rooms.find(r => r.number === normalized);
    if (!room) return { ok: false, error: `Room ${roomNumber} not found.` };

    return {
      ok: true,
      data: {
        number: room.number,
        status: room.status,
        type: room.type,
        // assignedName is already resolved by the merge layer; no second
        // staff lookup needed.
        assignedTo: room.assignedName ?? room.assignedTo ?? null,
        dnd: !!room.isDnd,
        // TODO(overlay): dndNote / issueNote / helpRequested live in a
        // future workflow overlay table; the pms_* merge shape doesn't
        // carry them yet (empty on `rooms` in practice too).
        dndNote: room.dndNote ?? null,
        issueNote: room.issueNote ?? null,
        helpRequested: !!room.helpRequested,
        startedAt: room.startedAt ? room.startedAt.toISOString() : null,
        completedAt: room.completedAt ? room.completedAt.toISOString() : null,
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
    // Plan v4: day-level counts come from the today_property_counts_v1 RPC
    // (fetchTodayPropertyCounts) instead of summing `rooms` rows. The RPC is
    // a single ~50ms call that derives live from pms_in_house_snapshot +
    // pms_reservations + pms_rooms_inventory — much cheaper than the 5-query
    // mergePmsRoomsForDate, and this is the manager "how are we doing"
    // rollup, so aggregates are all we need (no per-room fetch). It also
    // gives a more honest picture than the old `rooms` count: real PMS
    // checkouts / stayovers / in-house / occupancy, not just dirty/clean.
    //
    // cleaning_events is LEFT UNCHANGED (labor audit source) — same property
    // + today filter as before.
    const today = await getPropertyToday(ctx.propertyId);
    const [counts, { data: events }] = await Promise.all([
      fetchTodayPropertyCounts(ctx.propertyId, today),
      supabaseAdmin
        .from('cleaning_events')
        .select('staff_id, duration_minutes, status')
        .eq('property_id', ctx.propertyId)
        .eq('date', today)
        .neq('status', 'discarded'),
    ]);

    // Map the PMS count RPC to the rollup shape.
    //   dirty   ← vacant_dirty  (rooms needing a turn)
    //   clean   ← vacant_clean  (vacant + ready)
    //   total   ← total_rooms   (pms_rooms_inventory denominator)
    // TODO(overlay): inProgress / dnd / issues / helpRequests are
    // housekeeping-workflow signals not in the PMS count RPC — sourced from
    // a future overlay table. Reported as 0 for now (they were effectively
    // empty on the old `rooms` read once the CUA took over). `seedingGap`
    // is dropped: with a live PMS feed there's no daily-seed completeness
    // gap to report.
    const occupancyPercent = counts.total_rooms > 0
      ? Math.round((counts.in_house / counts.total_rooms) * 1000) / 10
      : 0;

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
        rooms: {
          dirty: counts.vacant_dirty,
          inProgress: 0, // TODO(overlay)
          clean: counts.vacant_clean,
          dnd: 0,        // TODO(overlay)
          total: counts.total_rooms,
        },
        occupancy: {
          checkouts: counts.checkouts,
          stayovers: counts.stayovers,
          inHouse: counts.in_house,
          outOfOrder: counts.ooo,
          occupancyPercent,
        },
        issues: 0,       // TODO(overlay)
        helpRequests: 0, // TODO(overlay)
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
    // True "deep cleans" (e.g. carpet shampooing, full reset) aren't modelled
    // as a separate field — we return what the data supports and surface a note.
    //
    // Plan v4: stayoverDay now comes from the merged Room (mergePmsRoomsForDate
    // derives it from pms_reservations). We mirror the same `stayoverDay === 2`
    // filter ScheduleTab uses against the merged Room (the "Stay · full"
    // bucket), so the queue is consistent with what the housekeeping board
    // shows. Replaces the old `rooms.stayover_day = 2` query.
    const today = await getPropertyToday(ctx.propertyId);
    let rooms: Room[];
    try {
      rooms = await mergePmsRoomsForDate(ctx.propertyId, today);
    } catch {
      return { ok: true, data: { queue: [], note: 'Deep clean queue could not be loaded.' } };
    }
    const queue = rooms.filter(r => r.type === 'stayover' && r.stayoverDay === 2);

    return {
      ok: true,
      data: {
        count: queue.length,
        note: 'Showing stayover-day-2 rooms (the longer mid-stay refresh). Full reset deep cleans are not yet tracked as a separate category.',
        queue: queue.map(r => ({
          number: r.number,
          status: r.status,
          type: r.type,
          stayoverDay: r.stayoverDay,
          lastCompleted: r.completedAt ? r.completedAt.toISOString() : null,
        })),
      },
    };
  },
});
