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

import { registerTool, type ToolResult } from '../tools';
import type { ScopedDb } from '../scoped-db';
import { buildHotelSnapshot } from '../context';
import { computeRoomTotal } from './_helpers';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { fetchTodayPropertyCounts } from '@/lib/db/today-room-work';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { countsTrusted, isDataPending } from '@/lib/pms/feed-status';
import { moneyVisibleToRole } from '../lenses';
import { roomNumberFromLocation } from '@/components/concourse/target-chip';
import { workOrderIsSettled } from '@/lib/db-mappers';
import type { Room } from '@/types';

/**
 * A ticket's repair cost in DOLLARS (the column is dollars, not cents), or null
 * when nobody entered one.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so a naive finite-check reads every
 * cost-less ticket as a free repair and prints "$0.00". That tells a manager a
 * job cost nothing when the truth is that nobody wrote the number down. Same
 * helper, same reasoning, as `repairCostOf` in staxis-findings.ts.
 */
function repairCostDollars(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ─── getPropertyToday ───────────────────────────────────────────────────────
// Property-local "today" as YYYY-MM-DD. Mirrors the doctor's approach
// (route.ts ~L3958): format `new Date()` in the property's IANA timezone via
// Intl.DateTimeFormat('en-CA', …) so we get an unambiguous ISO date, falling
// back to UTC today when the property has no timezone set or the zone string
// is invalid. Replaces the old getCurrentRoomsDate(`rooms`.date max) which
// can no longer work — `rooms` is empty and has no usable date column.
// Exported so the PMS money/booking feed tools (tools/pms-feeds.ts) share the
// same property-local "today" derivation.
export async function getPropertyToday(db: ScopedDb): Promise<string> {
  let timezone: string | null = null;
  try {
    const { data } = await db
      .from('properties')
      .select('timezone')
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
  // Deliberately NOT section-tagged: this is a cross-cutting read-only snapshot
  // whose headline value is occupancy/arrivals (from PMS ingestion, which is
  // never section-gated). Gating it under Housekeeping would break "what's our
  // occupancy?" in the copilot for a hotel that turned only Housekeeping off —
  // occupancy is still shown on the dashboard.
  description:
    'The one cheap orientation read: a whole-hotel snapshot as of the last PMS report — room counts (total, dirty, clean), today\'s checkouts and stayovers, who is on shift, and for a housekeeper their own assigned rooms. ' +
    'Use when: the user opens with a broad "how are we doing", "what\'s going on", "what\'s our occupancy", "what\'s next for me", or you need current hotel state before answering something else. Every role can call it. ' +
    'Takes no arguments. ' +
    'Returns: the snapshot plus asOf / dataAgeMinutes / dataFreshness — quote the as-of time, and treat the numbers as computed for you rather than adding them up yourself. ' +
    'Refuses: nothing, but it is NOT live — it is as of the last report, and several housekeeping-workflow counts (in-progress, DND, flagged issues) are always 0 here because they are not in the PMS feed; say "not tracked" rather than "zero". For a manager\'s full day rollup including cleaning labor use get_today_summary; for one room use query_room_status.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  pmsFreshness: 'stamped',
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

// ─── get_my_rooms ─────────────────────────────────────────────────────────
// The caller's OWN assigned rooms for today. Absorbs the former list_my_rooms
// and get_my_next_room (2026-07-27): both filtered today's merged rooms to
// `assignedTo === ctx.staffId` and differed only in whether they returned the
// whole list or the first one still needing a turn. Two tools for one query
// meant the model had to choose before it knew how many rooms there were.
//
// `nextOnly` keeps the ordering decision in CODE — "first dirty/in-progress,
// non-DND room by room number" is a rule the model must not re-derive from a
// list, because it gets it wrong exactly when a housekeeper is mid-shift.

registerTool<{ nextOnly?: boolean }>({
  name: 'get_my_rooms',
  section: 'housekeeping',
  pmsFreshness: 'stamped',
  description:
    'List the rooms assigned to the person asking, for today, with each room\'s status and flags. ' +
    'Use when: a housekeeper or maintenance tech asks about their OWN work — "what are my rooms", "cuáles son mis cuartos", "what\'s next", "which room should I do now", "am I done?". Not for asking about someone else\'s rooms or the whole hotel. ' +
    'Args: nextOnly — set true to get just the single next room to clean (first dirty or in-progress room that is not on Do-Not-Disturb, in room-number order); leave it off or false to get the whole assigned list. ' +
    'Returns: with nextOnly, { hasNext, number, status, type } — the pick is computed for you, do not re-order the list yourself. Otherwise { count, rooms[] } with number, status, type, dnd, issue and helpRequested per room. Both carry asOf — quote it. ' +
    'Refuses: when the caller\'s account is not linked to a staff record on this hotel (it cannot tell whose rooms to show) — tell them to ask a manager to link it. Returns hasNext:false rather than inventing a room when nothing is left.',
  inputSchema: {
    type: 'object',
    properties: {
      nextOnly: {
        type: 'boolean',
        description: 'True to return only the single next room to clean instead of the whole assigned list.',
      },
    },
  },
  allowedRoles: ['housekeeping', 'maintenance'],
  handler: async ({ nextOnly }, ctx): Promise<ToolResult> => {
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
    const today = await getPropertyToday(ctx.db);
    let rooms: Room[];
    try {
      rooms = await mergePmsRoomsForDate(ctx.propertyId, today);
    } catch {
      return { ok: false, error: 'Failed to fetch assigned rooms.' };
    }
    const mine = rooms.filter(r => r.assignedTo === ctx.staffId);

    if (nextOnly === true) {
      // First non-clean, non-DND room assigned to this housekeeper, by room
      // number — same ordering the old `rooms` query used (.order('number')).
      const next = mine
        .filter(r => (r.status === 'dirty' || r.status === 'in_progress') && !r.isDnd)
        .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))[0];

      if (!next) {
        return { ok: true, data: { hasNext: false, message: 'No more rooms to clean — looks like you\'re done for the day.' } };
      }
      return {
        ok: true,
        data: { hasNext: true, number: next.number, status: next.status, type: next.type },
      };
    }

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

// ─── query_room_status ────────────────────────────────────────────────────

registerTool<{ roomNumber: string }>({
  name: 'query_room_status',
  section: 'housekeeping',
  pmsFreshness: 'stamped',
  description:
    'Look up ONE room by number and report its current state. ' +
    'Use when: the user names a specific room — "is 214 clean yet", "who has 305", "está lista la 410", "did anyone flag 302". For the caller\'s own list use get_my_rooms; for the whole hotel use get_today_summary. ' +
    'Args: roomNumber — the room as the hotel writes it ("302", "PH-1", "A101"); digits, letters and hyphens are all fine. ' +
    'Returns: status, room type, the assigned housekeeper\'s name, DND state and note, any flagged issue, and the started/completed timestamps, plus asOf — quote the as-of time. ' +
    'Refuses: an unknown room number, with "Room X not found" — do not guess a nearby room or claim it is clean. DND note, issue note and help-requested are not yet fed by the PMS and read as empty even when the floor has flagged something.',
  inputSchema: {
    type: 'object',
    properties: { roomNumber: { type: 'string', description: 'Room number as digits.' } },
    required: ['roomNumber'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  // Also offered in a staff thread — the old private @Staxis catalog's
  // `get_room_status`, which answered the same question from the same merge.
  surfaces: ['chat', 'messages'],
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

    const today = await getPropertyToday(ctx.db);
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

// ─── get_today_summary ────────────────────────────────────────────────────
// The manager's day rollup. Absorbed get_occupancy (2026-07-27): that tool
// read the SAME today_property_counts_v1 RPC and returned a subset of what is
// already here, so "what's our occupancy" and "how are we doing today" were two
// tools answering from one query. The only thing get_occupancy had that this
// did not was the never-shrink room total, which moved over below.
//
// NOT section-tagged, deliberately. It was tagged `housekeeping` while
// get_occupancy was ungated, and the merge has to keep the WIDER gate:
// occupancy comes from PMS ingestion and is on the dashboard of a hotel that
// runs Staxis without the Housekeeping section. Tagging the merged tool would
// have silently deleted "how full are we?" for those hotels.

registerTool<Record<string, never>>({
  name: 'get_today_summary',
  pmsFreshness: 'stamped',
  description:
    'The manager\'s rollup of today as of the last PMS report: how full the hotel is, how the room board stands, and how much cleaning labor has been logged. ' +
    'Use when: a manager or front-desk asks "how are we doing today", "what\'s our occupancy", "how full are we", "how many rooms are left", "cómo vamos hoy", or wants today\'s checkouts and stayovers. For a floor-staff-safe snapshot use get_hotel_state; for one room use query_room_status. ' +
    'Takes no arguments — it always describes today in the hotel\'s own timezone. ' +
    'Returns: rooms { dirty, clean, total, vacant }, occupancy { checkouts, stayovers, inHouse, outOfOrder, occupancyPercent }, and cleaningEvents { count, avgDurationMinutes, totalLaborMinutes, uniqueStaff }. Every number is computed here — quote them, never re-derive a percentage or a remainder yourself. ' +
    'Refuses: nothing outright, but a null field is NOT a zero — it means that PMS feed is still syncing for this hotel, and you must say "still syncing" rather than reporting a number. in-progress, DND, flagged issues and help requests are always 0 because the PMS feed does not carry them; call them "not tracked", not "none".',
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
    const today = await getPropertyToday(ctx.db);
    const [counts, { data: events }, { data: propRow }] = await Promise.all([
      fetchTodayPropertyCounts(ctx.propertyId, today),
      ctx.db
        .from('cleaning_events')
        .select('staff_id, duration_minutes, status')
        .eq('date', today)
        .neq('status', 'discarded'),
      // Absorbed from get_occupancy: the room total must never SHRINK because
      // one source went stale, so it is the max of every size signal we hold —
      // properties.room_inventory.length, properties.total_rooms, and the RPC's
      // own total_rooms (folded in via computeRoomTotal below). Round-14/15.
      ctx.db.from('properties').select('room_inventory, total_rooms').maybeSingle(),
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
    // Never-shrink total (from get_occupancy): inventory length and the
    // configured total join the RPC's count as three independent size signals,
    // and occupancy is computed against THAT rather than against whichever one
    // the feed happened to report this minute.
    const inventoryLength = ((propRow?.room_inventory as string[] | null) ?? []).length;
    const configuredTotalRooms = Number(propRow?.total_rooms ?? 0);
    const rpcTotalRooms = Math.max(0, Number(counts.total_rooms ?? 0));
    const inHouse = Math.max(0, Number(counts.in_house ?? 0));
    const { total: totalRooms } = computeRoomTotal(
      inventoryLength,
      Math.max(configuredTotalRooms, rpcTotalRooms),
      inHouse,
    );
    const vacant = Math.max(0, totalRooms - inHouse);
    const occupancyPercent = totalRooms > 0
      ? Math.round((inHouse / totalRooms) * 1000) / 10
      : 0;

    // Review pass (fake-empty hunter #5) — the vacancy/in-house numbers are
    // snapshot-COALESCE-0s when the counts feed has no source, and
    // checkout/stayover counts undercount while the reservation feeds are
    // learning. Null them (with an explicit reason) instead of letting the
    // model relay confident zeros. Fail-safe: lookup error → no nulling.
    let countsOk = true;
    let reservationsOk = true;
    try {
      const fs = await getPropertyFeedStatus(ctx.propertyId);
      countsOk = countsTrusted(fs);
      reservationsOk = !(fs.mode === 'live' && (isDataPending(fs) ||
        fs.feeds.arrivals === 'learning' || fs.feeds.departures === 'learning'));
    } catch { /* non-fatal */ }

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
          dirty: countsOk ? counts.vacant_dirty : null,
          inProgress: 0, // TODO(overlay)
          clean: countsOk ? counts.vacant_clean : null,
          dnd: 0,        // TODO(overlay)
          total: totalRooms,
          // vacant is total − in-house, not the PMS's vacant_clean: a room can
          // be vacant and dirty and is still an empty room to sell.
          vacant: countsOk ? vacant : null,
        },
        occupancy: {
          checkouts: reservationsOk ? counts.checkouts : null,
          stayovers: reservationsOk ? counts.stayovers : null,
          inHouse: countsOk ? inHouse : null,
          outOfOrder: countsOk ? counts.ooo : null,
          occupancyPercent: countsOk ? occupancyPercent : null,
        },
        ...(!countsOk || !reservationsOk
          ? {
              pmsDataNote:
                'null fields are NOT zeros — their PMS source feed is still syncing/unavailable for this hotel; say "still syncing" instead of a number.',
            }
          : {}),
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
  section: 'housekeeping',
  pmsFreshness: 'stamped',
  description:
    'List the rooms due the longer mid-stay refresh today — stayover guests on the second day of their stay. ' +
    'Use when: a manager asks "what needs a deep clean", "which rooms get the full service today", "qué cuartos necesitan limpieza profunda", or is planning how long the board will take. ' +
    'Takes no arguments — it always describes today. ' +
    'Returns: { count, queue[] } with room number, status, stay type, which day of the stay it is, and when it was last completed. ' +
    'Refuses: nothing, but be honest about what this is — Staxis does not track true deep cleans (carpet shampoo, full reset) as their own category, so this is the industry day-2 stayover convention and nothing more. Say that rather than implying a real deep-clean schedule exists.',
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
    const today = await getPropertyToday(ctx.db);
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

// ─── get_work_order_history ───────────────────────────────────────────────
//
// "What's the history on 214's AC?" — the maintenance tech's first question at
// every door, and until now the chat could not answer it at all. The catalog
// could read every room in the hotel and not one work order: the only tool that
// touched the table was `staxis_equipment`, keyed on `equipment_id`, which most
// tickets do not carry. So the person holding the wrench had no way to find out
// whether somebody had already been here.
//
// Why a new tool rather than an extension. `staxis_equipment` answers "how is
// this ASSET doing" and needs a UUID the tech does not have standing in a
// doorway; `query_room_status` answers "what is this room's state right now"
// from the PMS feed and has no history at all. Neither can be widened into a
// room-and-item ticket search without becoming two tools sharing a name.
//
// ROOM MATCHING is the hard part and it is done in code, not in SQL.
// `work_orders.room_number` is free text somebody typed — "214", "Room 214",
// "Habitación 214", "Lobby", "Pool pump" — so an `ilike '%214%'` would also
// return room 1214 and "Ice machine 214". `roomNumberFromLocation` is the same
// deliberately strict normalizer the on-the-thing pattern chip uses, so a
// ticket the chip attaches to room 214 is a ticket this tool attaches to room
// 214. One rule, two surfaces, no drift.

registerTool<{ room?: string; item?: string; equipmentId?: string; windowDays?: number; limit?: number }>({
  name: 'get_work_order_history',
  section: 'maintenance',
  pmsFreshness: 'independent',
  description:
    'Every maintenance ticket ever logged for one room (or one piece of equipment, or the whole hotel) — what broke, when, who closed it and what they wrote down about the fix. ' +
    'Use when: someone asks what has gone wrong somewhere before — "what\'s the history on 214\'s AC", "has anyone been in 118", "how many times have we fixed this", "qué le han hecho al aire de la 214", "is this a repeat?". This is the record BEHIND today\'s problem; for what is broken right now use query_room_status or staxis_findings, and for one asset\'s whole life use staxis_equipment. ' +
    'Args: room — the room number as printed on the door ("214"), or a place like "Lobby". item — words to match inside the ticket text ("AC", "PTAC", "toilet"), for narrowing a busy room to one thing. equipmentId — an asset id from staxis_equipment, when you want that machine\'s tickets specifically. windowDays — look back only this many days; omit for the full history, which is usually what "has this happened before" means. limit — how many tickets to return, default 20, newest first. ' +
    'Returns: { count, matched, tickets[] } — each ticket with the room, what was reported, how urgent it was called, whether it is open or done, when it was logged and closed, how many days it stayed open, what the person who closed it wrote, and whether a contractor was called. `matched` is how many tickets fit the filter in total, so you can say "3 of 11" honestly. ' +
    'Refuses: nothing, but the record is only what somebody typed. An empty result means nobody logged a ticket, NOT that nothing ever broke there — say which one you can actually tell. Never state that a repair was made unless a ticket says so, and do not diagnose a fault from the history; report what the record shows and leave the diagnosis to the person standing in front of the thing.',
  inputSchema: {
    type: 'object',
    properties: {
      room: {
        type: 'string',
        description: 'Room number as printed on the door ("214"), or a place name like "Lobby". Omit for the whole hotel.',
      },
      item: {
        type: 'string',
        description: 'Words to match inside the ticket text — "AC", "PTAC", "toilet", "door lock". Narrows a busy room to one thing.',
      },
      equipmentId: {
        type: 'string',
        description: 'An equipment id from staxis_equipment, to get that asset\'s tickets specifically.',
      },
      windowDays: {
        type: 'number',
        description: 'Look back only this many days. Omit for the full history (usually what "has this happened before" means).',
      },
      limit: { type: 'number', description: 'Max tickets to return (default 20, max 100), newest first.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'maintenance'],
  handler: async ({ room, item, equipmentId, windowDays, limit }, ctx): Promise<ToolResult> => {
    const max = Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : 20), 100);
    const wantRoom = String(room ?? '').trim();
    const wantItem = String(item ?? '').trim().toLowerCase();
    const wantEquipment = String(equipmentId ?? '').trim();

    // ONE string literal on purpose: supabase-js infers the row type from the
    // literal, and splitting it across a `+` concatenation collapses that
    // inference to GenericStringError[]. Long line, deliberately.
    let q = ctx.db
      .from('work_orders')
      .select('id, room_number, description, notes, severity, status, created_at, resolved_at, repair_cost, equipment_id, completion_note, completed_by_name, submitted_by_name, submitter_role, needs_pro, pro_trade, pro_company');
    if (wantEquipment) q = q.eq('equipment_id', wantEquipment);
    if (Number.isFinite(windowDays) && Number(windowDays) > 0) {
      const since = new Date(Date.now() - Number(windowDays) * 86_400_000).toISOString();
      q = q.gte('created_at', since);
    }
    const { data, error } = await q;
    if (error) return { ok: false, error: 'Could not read this hotel\'s maintenance tickets.' };

    const rows = (data ?? []) as Record<string, unknown>[];
    const totalRead = rows.length;

    // The room filter, in code. `roomNumberFromLocation` returns the door number
    // for "214" / "Room 214" / "Habitación 214" and null for "Ice machine 3", so
    // a numeric request matches on the NUMBER and never on a substring. A
    // non-numeric request ("Lobby") falls back to a contains match, because
    // there is no canonical form for a place name.
    const wantRoomNumber = roomNumberFromLocation(wantRoom);
    const matchesRoom = (raw: unknown): boolean => {
      if (!wantRoom) return true;
      const loc = typeof raw === 'string' ? raw : '';
      if (wantRoomNumber) return roomNumberFromLocation(loc) === wantRoomNumber;
      return loc.toLowerCase().includes(wantRoom.toLowerCase());
    };
    // Item text is matched across every free-text field a person could have
    // written "AC" into — the reported fault, the running notes, and what the
    // closer wrote. There is no category column on work_orders to match instead.
    const matchesItem = (r: Record<string, unknown>): boolean => {
      if (!wantItem) return true;
      const hay = [r.description, r.notes, r.completion_note, r.pro_trade]
        .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
        .join(' ');
      return hay.includes(wantItem);
    };

    const filtered = rows
      .filter((r) => matchesRoom(r.room_number) && matchesItem(r))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

    // The maintenance lens sees no dollars anywhere — see moneyVisibleToRole.
    // Stripped from the SHAPE rather than discouraged in prose: a field the
    // model never receives is a field it cannot quote.
    const showMoney = moneyVisibleToRole(ctx.user.role, ctx.surface);

    const tickets = filtered.slice(0, max).map((r) => {
      const openedAt = typeof r.created_at === 'string' ? r.created_at : null;
      const closedAt = typeof r.resolved_at === 'string' ? r.resolved_at : null;
      // Two stored statuses take a ticket off the board: 'resolved' (fixed) and
      // 'closed' (looked at, not actually a problem). Asked as `=== 'resolved'`
      // this reported every non issue as still open, and the companion repeated
      // it as fact.
      const done = workOrderIsSettled(r.status ?? 'submitted');
      // Days-open is computed here, in code, for the same reason every other
      // number in this catalog is: a model subtracting two ISO timestamps in
      // prose is right until the month rolls over.
      const daysOpen = openedAt
        ? Math.max(0, Math.round(
            ((closedAt ? Date.parse(closedAt) : Date.now()) - Date.parse(openedAt)) / 86_400_000,
          ))
        : null;
      const cost = repairCostDollars(r.repair_cost);
      return {
        id: String(r.id),
        room: (r.room_number as string | null) ?? null,
        reported: (r.description as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        severity: (r.severity as string | null) ?? null,
        state: done ? 'done' : 'open',
        loggedAt: openedAt,
        loggedBy: (r.submitted_by_name as string | null) ?? null,
        closedAt,
        closedBy: (r.completed_by_name as string | null) ?? null,
        whatWasDone: (r.completion_note as string | null) ?? null,
        daysOpen,
        contractorCalled: r.needs_pro === true
          ? { trade: (r.pro_trade as string | null) ?? null, company: (r.pro_company as string | null) ?? null }
          : null,
        equipmentId: (r.equipment_id as string | null) ?? null,
        ...(showMoney
          ? { repairCost: cost === null ? null : cost.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) }
          : {}),
      };
    });

    const stillOpen = filtered.filter((r) => !workOrderIsSettled(r.status ?? 'submitted')).length;

    return {
      ok: true,
      data: {
        count: tickets.length,
        matched: filtered.length,
        stillOpen,
        filter: {
          room: wantRoom || null,
          roomMatchedAs: wantRoom ? (wantRoomNumber ?? `text contains "${wantRoom}"`) : null,
          item: wantItem || null,
          equipmentId: wantEquipment || null,
          windowDays: Number.isFinite(windowDays) && Number(windowDays) > 0 ? Number(windowDays) : null,
        },
        tickets,
        note: filtered.length === 0
          ? (totalRead === 0
            ? 'This hotel has no maintenance tickets on record at all. That means nobody has logged one — it does not mean nothing has broken. Say exactly that.'
            : 'No ticket matches that. The record only holds what somebody typed, so this means nobody logged one here, not that nothing ever went wrong. Do not describe the room or the machine as trouble-free.')
          : (showMoney ? undefined : 'Repair costs are not part of what you can see; if asked what something cost, say the money side is the manager\'s.'),
      },
    };
  },
});
