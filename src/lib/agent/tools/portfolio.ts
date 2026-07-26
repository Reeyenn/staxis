// ─── Portfolio tools — cross-hotel, READ-ONLY, company-scope only ───────────
//
// Seven tools that answer a company-level question ("which of my hotels had the
// worst week for maintenance", "compare supply spend across my hotels") without
// ever widening the hotel wall.
//
// THREE RULES, AND EVERY TOOL IN THIS FILE OBEYS ALL THREE.
//
// 1. THE WALL STAYS STRUCTURAL. A portfolio read is a LOOP over `scopedDb(pid)`
//    for pid in a set the SPINE produced — never a cross-property query. There
//    is no raw service-role client in this file and the build refuses one
//    (`scripts/audit-service-role-imports.mjs`). A bug here can return the
//    wrong subset of the caller's own hotels; it cannot reach anybody else's.
//
// 2. NOTHING IS TRUSTED FROM THE CONTEXT. `ctx.portfolio` says which company is
//    being asked about. It does NOT say what may be read: every tool re-resolves
//    the caller's coverage through `resolvePortfolioAccess` first, and intersects
//    that fresh answer with the context's. Both must agree. The company's
//    `cross_hotel_ai_chat` setting is re-checked on that same call, so a company
//    that switches it off closes the door mid-conversation, not at the next login.
//
// 3. READ ONLY. Not one tool here declares `mutates: true`, and none may. A
//    company-wide one-tap ("raise the reorder point at all twenty hotels") is a
//    deliberately later decision — the blast radius of a wrong action multiplies
//    by the size of the portfolio, and the approval card was designed around one
//    hotel's manager approving one hotel's change. Actions stay per-hotel.
//
// WHY THESE SEVEN AND NOT SEVENTY. Multi-hotel-ing the existing ~70 tools would
// mean 70 more places for the wall to be wrong, and most of them answer
// questions ("what is room 302's status") that are meaningless across twenty
// hotels. These seven are the aggregates a portfolio question actually reduces
// to, plus the two lookups every answer needs (which hotels, and what the
// company's own rules say).

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  normalizeWorkOrderSeverity,
  type WorkOrderSeverityBucket,
} from '@/lib/db-mappers';
import {
  PORTFOLIO_REFUSAL_TEXT,
  resolvePortfolioAccess,
} from '@/lib/company/portfolio';
import { getConfirmedCompanyFacts } from '@/lib/company/rulebook';
import { COMPANY_CATEGORY_LABELS } from '@/lib/company/rulebook-policy';
import { stockStatus } from '@/lib/stock-status';
import {
  boundedHotelIds,
  forEachHotel,
  loadPortfolioHotels,
  MAX_PORTFOLIO_HOTELS,
  type PortfolioHotel,
} from '../portfolio/hotels';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may reach this surface at all.
 *
 * These are the LEGACY degradations of the three company-scope jobs
 * (`legacyRoleForHat`): owner → owner, vp → general_manager, finance →
 * front_desk. Listing `front_desk` here looks alarming and is not: a
 * property-scope front-desk person never reaches a portfolio context, because
 * `ctx.portfolio` is only ever set by the portfolio route and only ever after
 * `resolvePortfolioAccess` found a COMPANY-scope hat. `executeTool` refuses any
 * tool in this file when that field is absent, and the leak suite drives a real
 * property-scope person at the real route to prove it.
 */
const PORTFOLIO_ROLES = ['admin', 'owner', 'general_manager', 'front_desk'] as const;

const PORTFOLIO_SURFACES = ['portfolio'] as const;

const MS_PER_DAY = 86_400_000;
/** Ceiling on rows pulled per hotel, so one strange hotel cannot dominate. */
const MAX_ROWS = 5_000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

// ─── The shared gate ────────────────────────────────────────────────────────

interface Reach {
  organizationId: string;
  organizationName: string | null;
  /** The hotels this call will actually read. */
  ids: string[];
  hotels: PortfolioHotel[];
  nameOf: (propertyId: string) => string;
  roomsOf: (propertyId: string) => number | null;
  /** Covered hotels this call is not reading (the per-turn ceiling). */
  omittedHotelCount: number;
}

type ReachResult = { ok: true; reach: Reach } | { ok: false; error: string };

/**
 * Resolve which hotels this call may read.
 *
 * The whole gate, in one place, so a new portfolio tool cannot forget a step:
 * re-verify the company job and the company's setting, intersect the fresh
 * coverage with the context's, refuse any hotel the caller named outside it,
 * and bound the result to what one turn will read.
 */
async function reachFor(
  ctx: ToolHandlerContext,
  hotelIds?: unknown,
): Promise<ReachResult> {
  const scope = ctx.portfolio;
  if (!scope) {
    // Unreachable through executeTool, which refuses first. Kept because a
    // handler that reads `ctx.portfolio!` is one refactor away from being wrong
    // silently, and this is the cheapest possible way to make it wrong loudly.
    return {
      ok: false,
      error: 'Refused: this tool only runs in a company-wide conversation.',
    };
  }

  // DEFENSE IN DEPTH, and the reason it is worth a round trip: the context was
  // built when the conversation's turn started. This asks the spine again —
  // does this person still hold a company job here, and is cross-hotel chat
  // still switched on for this company?
  const fresh = await resolvePortfolioAccess(ctx.user.accountId, scope.organizationId);
  if (!fresh.ok) {
    return { ok: false, error: `Refused: ${PORTFOLIO_REFUSAL_TEXT[fresh.reason]}` };
  }

  // BOTH answers must contain a hotel. The spine's fresh answer cannot widen
  // what the route allowed, and the route's list cannot widen the spine.
  const routeAllowed = new Set(scope.propertyIds);
  const covered = fresh.access.propertyIds.filter((id) => routeAllowed.has(id));
  if (covered.length === 0) {
    return { ok: false, error: `Refused: ${PORTFOLIO_REFUSAL_TEXT.no_hotels}` };
  }

  let requested = covered;
  if (hotelIds !== undefined && hotelIds !== null) {
    if (!Array.isArray(hotelIds)) {
      return { ok: false, error: 'Refused: hotelIds must be a list of hotel ids.' };
    }
    const asked = hotelIds.filter((id): id is string => typeof id === 'string');
    const coveredSet = new Set(covered);
    const outside = asked.filter((id) => !UUID_RX.test(id) || !coveredSet.has(id));
    if (outside.length > 0) {
      // Deliberately does NOT confirm or deny that the id names a real hotel
      // anywhere. "Not one of yours" is the whole answer a caller is owed.
      return {
        ok: false,
        error:
          `Refused: ${outside.length} of the ${asked.length} hotel${asked.length === 1 ? '' : 's'} you named `
          + 'is not one of this company\'s hotels. Tell the user you can only answer about their own '
          + 'hotels, and call list_my_hotels if you need the list.',
      };
    }
    if (asked.length > 0) requested = covered.filter((id) => new Set(asked).has(id));
  }

  const { ids, omittedHotelCount } = boundedHotelIds(requested);
  const hotels = await loadPortfolioHotels(ids);
  const nameById = new Map(hotels.map((h) => [h.id, h.name ?? 'Unnamed hotel']));
  const roomsById = new Map(hotels.map((h) => [h.id, h.totalRooms]));

  return {
    ok: true,
    reach: {
      organizationId: fresh.access.organizationId,
      organizationName: fresh.access.organizationName,
      ids,
      hotels,
      nameOf: (id) => nameById.get(id) ?? 'Unnamed hotel',
      roomsOf: (id) => roomsById.get(id) ?? null,
      omittedHotelCount,
    },
  };
}

/** Every portfolio payload carries the same honesty envelope. */
function envelope(reach: Reach, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    company: reach.organizationName,
    hotelsRead: reach.ids.length,
    ...(reach.omittedHotelCount > 0
      ? {
          hotelsNotRead: reach.omittedHotelCount,
          coverageNote:
            `This company operates more hotels than one answer reads (${MAX_PORTFOLIO_HOTELS} at a time). `
            + 'Say that the ranking covers only the hotels listed.',
        }
      : {}),
    ...extra,
  };
}

function windowDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.round(n), MAX_WINDOW_DAYS);
}

function sinceIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}

/** Dollars, rounded to the cent. Never a fabricated precision. */
function dollars(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A ratio or a rate, to two places. Same rounding as `dollars`, different
 *  meaning — a per-100-rooms figure is not money and should not read as if it
 *  were the next time somebody greps for where a number came from. */
function rate(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Every derived number, computed HERE ─────────────────────────────────────
//
// AI MAY NEVER AUTHOR A NUMBER, AND A DIVISION IS AUTHORING A NUMBER.
//
// On 2026-07-26 a live portfolio answer took two correct tool numbers — 11 open
// items at a 50-room hotel — and reported "32.0 per 100 rooms" (it is 22.0),
// then concluded one hotel was "6x" another when the true multiple was about 8.
// Neither figure came from a tool. Both came from the model doing arithmetic in
// prose, which is the one operation it is worst at and the one nothing checks.
//
// The fix is not a better instruction, it is removing the need: every rate, per
// room figure, ratio and total a portfolio question reduces to is computed in
// this file and shipped in the payload, so the model QUOTES instead of dividing.
// The prompt's "never do arithmetic yourself" rule (portfolio/prompt.ts) is the
// second half of the same fix — it only holds up because these fields exist.
//
// ADDING A NEW AGGREGATE TOOL? Ship its derived forms with it. A tool that
// returns only raw counts is a tool that invites the model to divide.

// Both are exported so they can be proved hermetically. They are the two
// divisions the model got wrong live, and a division nothing tests is a
// division back in the model's hands.

/** Rate per 100 rooms. Null when there is no room count — a hotel whose size is
 *  unknown gets no rate rather than the portfolio's average. */
export function per100Rooms(value: number | null, rooms: number | null): number | null {
  if (value === null || rooms === null || rooms <= 0) return null;
  return rate((value / rooms) * 100);
}

/** How many times `value` is `reference`. Null when the reference is zero — "x
 *  times zero" is not a comparison, and Infinity in a payload becomes `null` in
 *  JSON anyway, so it is better to be deliberate about it. */
export function timesAsMuch(value: number | null, reference: number | null): number | null {
  if (value === null || reference === null || reference <= 0) return null;
  return rate(value / reference);
}

interface QueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

function rowsOf<T>(result: QueryResult<T>, what: string): T[] {
  if (result.error) throw new Error(`${what} read failed: ${result.error.message}`);
  return result.data ?? [];
}

/** The `hotelIds` argument every aggregate tool accepts, described once. */
const HOTEL_IDS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Optional. Narrow the answer to specific hotels by id, from list_my_hotels. '
    + 'Omit to cover every hotel in the company. Any id outside the company is refused.',
} as const;

/** Read failures, reported per hotel rather than swallowed into a 0. */
function unreadNote(failed: number): Record<string, unknown> {
  return failed > 0
    ? {
        hotelsUnread: failed,
        unreadNote:
          `${failed} hotel${failed === 1 ? '' : 's'} could not be read. Name them as unread — `
          + 'do NOT report them as having nothing.',
      }
    : {};
}

// ─── 1. list_my_hotels ──────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'list_my_hotels',
  description:
    'List every hotel in this management company that the user oversees, with its id, name and room count. '
    + 'Call this first when the user names a hotel, or when you need ids for another portfolio tool.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (_args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;
    return {
      ok: true,
      data: envelope(reach, {
        hotels: reach.hotels.map((h) => ({
          hotelId: h.id,
          name: h.name,
          rooms: h.totalRooms,
          timezone: h.timezone,
        })),
      }),
    };
  },
});

// ─── 2. portfolio_open_items ────────────────────────────────────────────────

interface OpenItemsArgs { hotelIds?: string[]; limitPerHotel?: number }

registerTool<OpenItemsArgs>({
  name: 'portfolio_open_items',
  description:
    'Per hotel: how many problems Staxis currently has open, how many are waiting on a decision, '
    + 'and the biggest ones with their dollar range. Use this for "which hotel is in the most trouble" '
    + 'and "what needs my attention across the company".',
  inputSchema: {
    type: 'object',
    properties: {
      hotelIds: HOTEL_IDS_SCHEMA,
      limitPerHotel: {
        type: 'number',
        description: 'How many individual items to list per hotel (default 5, max 20).',
      },
    },
  },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx, args?.hotelIds);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;
    const perHotel = Math.min(Math.max(Math.round(numberOf(args?.limitPerHotel) ?? 5), 1), 20);

    const { results, failedHotelCount } = await forEachHotel(reach.ids, async (db, propertyId) => {
      const result = (await db
        .from('findings')
        .select('detector_id, summary, severity, disposition, status, magnitude, price_low_cents, price_high_cents, first_seen_at, last_seen_at')
        .in('status', ['open', 'updated', 'known_problem'])
        .order('last_seen_at', { ascending: false })
        .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
      return rowsOf(result, `findings@${propertyId}`);
    });

    const hotels = results.map(({ propertyId, value }) => {
      if (value === null) {
        return { hotelId: propertyId, hotel: reach.nameOf(propertyId), read: false as const };
      }
      const live = value.filter((r) => r.status === 'open' || r.status === 'updated');
      const priced = live.filter((r) => numberOf(r.price_low_cents) !== null);
      const lowTotal = priced.reduce((sum, r) => sum + (numberOf(r.price_low_cents) ?? 0), 0);
      const highTotal = priced.reduce((sum, r) => sum + (numberOf(r.price_high_cents) ?? 0), 0);
      const ranked = [...live].sort((a, b) => (
        (numberOf(b.price_high_cents) ?? 0) - (numberOf(a.price_high_cents) ?? 0)
      ));
      const rooms = reach.roomsOf(propertyId);
      const critical = live.filter((r) => r.severity === 'critical').length;
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms,
        openItems: live.length,
        needingADecision: live.filter((r) => r.disposition === 'propose').length,
        critical,
        // Computed here, never in prose. A 50-room hotel with 11 open items is
        // 22.0 per 100 rooms; the model's own division of those same two numbers
        // printed 32.0 on a live answer.
        openItemsPer100Rooms: per100Rooms(live.length, rooms),
        criticalPer100Rooms: per100Rooms(critical, rooms),
        alreadyKnownProblems: value.filter((r) => r.status === 'known_problem').length,
        // Only from items that CARRY a range — a hotel whose problems have no
        // price contributes nothing here rather than a zero that reads as "cheap".
        pricedItems: priced.length,
        estimatedDollarsLow: priced.length > 0 ? dollars(lowTotal / 100) : null,
        estimatedDollarsHigh: priced.length > 0 ? dollars(highTotal / 100) : null,
        items: ranked.slice(0, perHotel).map((r) => ({
          summary: r.summary,
          severity: r.severity,
          disposition: r.disposition,
          detector: r.detector_id,
          dollarsLow: numberOf(r.price_low_cents) === null ? null : dollars((numberOf(r.price_low_cents) ?? 0) / 100),
          dollarsHigh: numberOf(r.price_high_cents) === null ? null : dollars((numberOf(r.price_high_cents) ?? 0) / 100),
          firstSeen: r.first_seen_at,
          lastSeen: r.last_seen_at,
        })),
      };
    });

    return {
      ok: true,
      data: envelope(reach, {
        basis: 'Staxis\'s own open findings, read live. Dollar figures are RANGES and only exist '
          + 'for items where this hotel\'s own history supported one. Per-100-rooms figures are '
          + 'already worked out here — quote them, never divide.',
        hotels,
        ...unreadNote(failedHotelCount),
      }),
    };
  },
});

// ─── 3. portfolio_work_orders ───────────────────────────────────────────────

interface WorkOrderArgs { hotelIds?: string[]; days?: number }

registerTool<WorkOrderArgs>({
  name: 'portfolio_work_orders',
  description:
    'Per hotel: maintenance work orders opened over a window, how many are still open, and what the '
    + 'hotel has actually recorded paying to fix things. Use this for "which hotel had the worst week '
    + 'for maintenance" and "where is maintenance piling up".',
  inputSchema: {
    type: 'object',
    properties: {
      hotelIds: HOTEL_IDS_SCHEMA,
      days: {
        type: 'number',
        description: 'How many days back to count (default 30, max 365). Use 7 for "this week".',
      },
    },
  },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx, args?.hotelIds);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;
    const days = windowDays(args?.days);
    const since = sinceIso(days, new Date());

    const { results, failedHotelCount } = await forEachHotel(reach.ids, async (db, propertyId) => {
      const result = (await db
        .from('work_orders')
        .select('status, severity, repair_cost, created_at, room_number')
        .gte('created_at', since)
        .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
      return rowsOf(result, `work_orders@${propertyId}`);
    });

    const hotels = results.map(({ propertyId, value }) => {
      if (value === null) {
        return { hotelId: propertyId, hotel: reach.nameOf(propertyId), read: false as const };
      }
      const costs = value
        .map((r) => numberOf(r.repair_cost))
        .filter((c): c is number => c !== null && c > 0);
      const rooms = reach.roomsOf(propertyId);
      const opened = value.length;
      // 'submitted' | 'assigned' | 'in_progress' all read as open on the board;
      // only 'resolved' is done, and an absent status is an open ticket
      // (db-mappers.ts STATUS_FROM_DB's own fallback).
      const openRows = value.filter((r) => String(r.status ?? 'submitted') !== 'resolved');
      const stillOpen = openRows.length;
      // ONE vocabulary, whichever the writer used. `work_orders.severity` holds
      // both `MAJOR`/`MINOR` and `low`/`medium`/`urgent` (see
      // normalizeWorkOrderSeverity); reading only for the literal string
      // 'urgent' is why a live answer said "0 urgent" with five MAJOR tickets
      // sitting open.
      const buckets = openRows.map((r) => normalizeWorkOrderSeverity(r.severity));
      const countOf = (b: WorkOrderSeverityBucket) => buckets.filter((x) => x === b).length;
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms,
        opened,
        stillOpen,
        /** How the STILL-OPEN tickets grade, in one vocabulary. */
        stillOpenBySeverity: {
          urgent: countOf('urgent'),
          high: countOf('high'),
          normal: countOf('normal'),
          low: countOf('low'),
          ungraded: countOf('unspecified'),
        },
        openedPer100Rooms: per100Rooms(opened, rooms),
        stillOpenPer100Rooms: per100Rooms(stillOpen, rooms),
        // Only from tickets where somebody typed a cost in. A hotel that never
        // fills that in reports null, not $0 — $0 would read as "free".
        recordedRepairSpendDollars: costs.length > 0 ? dollars(costs.reduce((a, b) => a + b, 0)) : null,
        repairCostSamples: costs.length,
      };
    });

    return {
      ok: true,
      data: envelope(reach, {
        windowDays: days,
        basis: `work orders created in the last ${days} days on each hotel's own maintenance board. `
          + 'Severity is normalised: this column holds two vocabularies (MAJOR/MINOR from the '
          + 'housekeeper app, low/medium/urgent from the maintenance board), and '
          + 'stillOpenBySeverity folds both into urgent / high / normal / low / ungraded. '
          + '"ungraded" means nobody graded it, not that it is minor. '
          + 'Per-100-rooms figures are already worked out here — quote them, never divide.',
        hotels,
        ...unreadNote(failedHotelCount),
      }),
    };
  },
});

// ─── 4. portfolio_supply_spend ──────────────────────────────────────────────

interface SpendArgs { hotelIds?: string[]; days?: number }

registerTool<SpendArgs>({
  name: 'portfolio_supply_spend',
  description:
    'Per hotel: what was spent restocking supplies over a window, from each hotel\'s own delivery log, '
    + 'with a per-room figure so hotels of different sizes can be compared. Use this for '
    + '"compare supply spend across my hotels".',
  inputSchema: {
    type: 'object',
    properties: {
      hotelIds: HOTEL_IDS_SCHEMA,
      days: {
        type: 'number',
        description: 'How many days back to total (default 30, max 365).',
      },
    },
  },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx, args?.hotelIds);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;
    const days = windowDays(args?.days);
    const since = sinceIso(days, new Date());

    const { results, failedHotelCount } = await forEachHotel(reach.ids, async (db, propertyId) => {
      const result = (await db
        .from('inventory_orders')
        .select('total_cost, unit_cost, quantity, received_at')
        .gte('received_at', since)
        .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
      return rowsOf(result, `inventory_orders@${propertyId}`);
    });

    const hotels = results.map(({ propertyId, value }) => {
      if (value === null) {
        return { hotelId: propertyId, hotel: reach.nameOf(propertyId), read: false as const };
      }
      let total = 0;
      let priced = 0;
      for (const row of value) {
        let amount = numberOf(row.total_cost);
        if (amount === null) {
          const unit = numberOf(row.unit_cost);
          const qty = numberOf(row.quantity);
          amount = unit !== null && qty !== null ? unit * qty : null;
        }
        if (amount === null) continue;
        total += amount;
        priced += 1;
      }
      const rooms = reach.roomsOf(propertyId);
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms,
        deliveries: value.length,
        deliveriesWithACost: priced,
        spendDollars: priced > 0 ? dollars(total) : null,
        spendPerRoomDollars: priced > 0 && rooms && rooms > 0 ? dollars(total / rooms) : null,
        spendPer100RoomsDollars: priced > 0 ? per100Rooms(dollars(total), rooms) : null,
      };
    });

    return {
      ok: true,
      data: envelope(reach, {
        windowDays: days,
        basis: `deliveries received in the last ${days} days, from each hotel's own inventory ledger. `
          + 'Deliveries logged without a cost are counted but not priced.',
        hotels,
        ...unreadNote(failedHotelCount),
      }),
    };
  },
});

// ─── 5. portfolio_inventory_health ──────────────────────────────────────────

interface InventoryArgs { hotelIds?: string[] }

registerTool<InventoryArgs>({
  name: 'portfolio_inventory_health',
  description:
    'Per hotel: how many stocked items are Good, Low or Critical against their par level right now, '
    + 'and which items are worst. Use this for "who is about to run out of something".',
  inputSchema: {
    type: 'object',
    properties: { hotelIds: HOTEL_IDS_SCHEMA },
  },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx, args?.hotelIds);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;

    const { results, failedHotelCount } = await forEachHotel(reach.ids, async (db, propertyId) => {
      const result = (await db
        .from('inventory')
        .select('name, current_stock, par_level, unit, archived_at')
        .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
      return rowsOf(result, `inventory@${propertyId}`);
    });

    const hotels = results.map(({ propertyId, value }) => {
      if (value === null) {
        return { hotelId: propertyId, hotel: reach.nameOf(propertyId), read: false as const };
      }
      const live = value.filter((r) => r.archived_at == null);
      const classified = live.map((r) => ({
        name: typeof r.name === 'string' ? r.name : 'unnamed item',
        onHand: numberOf(r.current_stock) ?? 0,
        par: numberOf(r.par_level) ?? 0,
        unit: typeof r.unit === 'string' ? r.unit : null,
        status: stockStatus(numberOf(r.current_stock) ?? 0, numberOf(r.par_level) ?? 0),
      }));
      const critical = classified.filter((i) => i.status === 'critical');
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms: reach.roomsOf(propertyId),
        itemsTracked: classified.length,
        good: classified.filter((i) => i.status === 'good').length,
        low: classified.filter((i) => i.status === 'low').length,
        critical: critical.length,
        worstItems: critical
          .sort((a, b) => (a.par > 0 ? a.onHand / a.par : 1) - (b.par > 0 ? b.onHand / b.par : 1))
          .slice(0, 5)
          .map((i) => ({ item: i.name, onHand: i.onHand, par: i.par, unit: i.unit })),
      };
    });

    return {
      ok: true,
      data: envelope(reach, {
        basis: 'on-hand against par right now, using the app-wide 70/30 rule '
          + '(at or above 70% of par is Good, 30-70% is Low, below 30% is Critical)',
        hotels,
        ...unreadNote(failedHotelCount),
      }),
    };
  },
});

// ─── 6. portfolio_compare ───────────────────────────────────────────────────

type CompareMetric = 'supply_spend' | 'work_orders' | 'open_items' | 'rooms';

interface CompareArgs { metric?: CompareMetric; days?: number; perRoom?: boolean }

registerTool<CompareArgs>({
  name: 'portfolio_compare',
  description:
    'Rank every hotel in the company on one measure, worst first: supply_spend, work_orders, '
    + 'open_items or rooms. Set perRoom to compare hotels of different sizes fairly. '
    + 'Use this when the user asks "which hotel is worst/best at X" — and ALSO whenever you need '
    + 'a per-room figure, a per-100-rooms rate, a share of the portfolio, a total, an average, or '
    + '"how many times worse than" one hotel is than another. It returns all of those already '
    + 'worked out, so you never have to calculate one yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        enum: ['supply_spend', 'work_orders', 'open_items', 'rooms'],
        description: 'What to rank on. Defaults to open_items.',
      },
      days: { type: 'number', description: 'Window for spend and work orders (default 30, max 365).' },
      perRoom: {
        type: 'boolean',
        description: 'Divide by the hotel\'s room count so a big hotel does not always come top.',
      },
    },
  },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;
    const metric: CompareMetric = args?.metric ?? 'open_items';
    const days = windowDays(args?.days);
    const since = sinceIso(days, new Date());
    const perRoom = args?.perRoom === true;

    const { results, failedHotelCount } = await forEachHotel(reach.ids, async (db, propertyId) => {
      switch (metric) {
        case 'rooms':
          return reach.roomsOf(propertyId) ?? 0;
        case 'supply_spend': {
          const result = (await db
            .from('inventory_orders')
            .select('total_cost, unit_cost, quantity')
            .gte('received_at', since)
            .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
          let total = 0;
          for (const row of rowsOf(result, `inventory_orders@${propertyId}`)) {
            const amount = numberOf(row.total_cost)
              ?? ((numberOf(row.unit_cost) ?? 0) * (numberOf(row.quantity) ?? 0));
            total += amount;
          }
          return dollars(total);
        }
        case 'work_orders': {
          const result = (await db
            .from('work_orders')
            .select('id')
            .gte('created_at', since)
            .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
          return rowsOf(result, `work_orders@${propertyId}`).length;
        }
        case 'open_items':
        default: {
          const result = (await db
            .from('findings')
            .select('id')
            .in('status', ['open', 'updated'])
            .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;
          return rowsOf(result, `findings@${propertyId}`).length;
        }
      }
    });

    const scored = results
      .filter((r) => r.value !== null)
      .map(({ propertyId, value }) => {
        const rooms = reach.roomsOf(propertyId);
        const raw = value as number;
        const usableRooms = rooms && rooms > 0 ? rooms : null;
        return {
          hotelId: propertyId,
          hotel: reach.nameOf(propertyId),
          rooms,
          value: raw,
          // A per-room figure needs a room count. A hotel without one reports
          // null rather than borrowing the portfolio's average.
          perRoomValue: perRoom && usableRooms ? rate(raw / usableRooms) : null,
          // Always present, whichever way the caller asked to rank: "per 100
          // rooms" is how a VP says it out loud, and a model that has to turn
          // 0.22 into 22 has been handed a division to get wrong.
          per100RoomsValue: per100Rooms(raw, rooms),
          // NOT published. Every ratio below divides THIS, never the rounded
          // field beside it. Rounding first is how "3 open items at 74 rooms"
          // (0.0405 per room) becomes 0.04, and the multiple against a hotel at
          // 0.4 comes out as a clean 10x when the truth is 9.87x — a number
          // authored by rounding rather than by measurement.
          _exactPerRoom: usableRooms ? raw / usableRooms : null,
        };
      })
      .sort((a, b) => {
        const av = perRoom ? (a._exactPerRoom ?? -1) : a.value;
        const bv = perRoom ? (b._exactPerRoom ?? -1) : b.value;
        if (bv !== av) return bv - av;
        return a.hotel < b.hotel ? -1 : a.hotel > b.hotel ? 1 : 0;
      });

    // The comparison itself, done in code. "Which hotel is worst" is always
    // followed by "by how much", and that answer is a division the model must
    // not perform: a live answer said "6x" where the truth was about 8x.
    const exactly = (r: (typeof scored)[number]): number | null =>
      perRoom ? r._exactPerRoom : r.value;
    /** What the ranking column SHOWS, which is the rounded form. */
    const shown = (r: (typeof scored)[number]): number | null =>
      perRoom ? r.perRoomValue : r.value;
    const comparable = scored.filter((r) => exactly(r) !== null);
    const top = comparable[0] ?? null;
    const bottom = comparable[comparable.length - 1] ?? null;
    const total = scored.reduce((sum, r) => sum + r.value, 0);

    const ranked = scored.map(({ _exactPerRoom, ...r }) => ({
      ...r,
      /** How many times this hotel is the lowest-ranked hotel, on the SAME
       *  measure the ranking used. Null when the lowest is zero. */
      timesTheLowest: timesAsMuch(
        perRoom ? _exactPerRoom : r.value,
        bottom ? exactly(bottom) : null,
      ),
      shareOfPortfolioPct: total > 0 ? rate((r.value / total) * 100) : null,
    }));

    return {
      ok: true,
      data: envelope(reach, {
        metric,
        perRoom,
        ...(metric === 'rooms' ? {} : { windowDays: days }),
        unit: metric === 'supply_spend' ? 'US dollars' : 'count',
        basis: metric === 'rooms'
          ? 'each hotel\'s configured room count'
          : `${metric.replace(/_/g, ' ')} over the last ${days} days`,
        ranking: ranked,
        // Every figure a "who is worst, and by how much" answer needs, so none
        // of them has to be worked out in a sentence.
        comparison: {
          rankedOn: perRoom ? 'per room' : 'total',
          hotelsCompared: comparable.length,
          highest: top ? { hotel: top.hotel, value: shown(top) } : null,
          lowest: bottom ? { hotel: bottom.hotel, value: shown(bottom) } : null,
          // Divided from the exact values, then rounded once — so this can
          // legitimately not equal `highest.value / lowest.value` as printed.
          // That is the correct direction to be wrong in: the ratio is right and
          // the displayed operands are rounded, rather than a tidy ratio derived
          // from tidied numbers.
          highestIsTimesTheLowest: timesAsMuch(
            top ? exactly(top) : null,
            bottom ? exactly(bottom) : null,
          ),
          portfolioTotal: metric === 'supply_spend' ? dollars(total) : total,
          portfolioAverage: scored.length > 0
            ? rate(total / scored.length)
            : null,
        },
        ...unreadNote(failedHotelCount),
        ...(perRoom && ranked.some((r) => r.perRoomValue === null)
          ? { perRoomGap: 'Some hotels have no room count recorded and could not be ranked per room.' }
          : {}),
        ...(ranked.some((r) => r.per100RoomsValue === null)
          ? { per100RoomsGap: 'Some hotels have no room count recorded, so they have no rate.' }
          : {}),
      }),
    };
  },
});

// ─── 7. company_rulebook ────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'company_rulebook',
  description:
    'The management company\'s own confirmed rules — standards, money, vendors, people, guests. '
    + 'Call this when the user asks what the company policy is, or before saying a hotel is off-standard.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: PORTFOLIO_ROLES,
  surfaces: PORTFOLIO_SURFACES,
  pmsFreshness: 'independent',
  handler: async (_args, ctx): Promise<ToolResult> => {
    const resolved = await reachFor(ctx);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { reach } = resolved;

    // CONFIRMED only, exactly as the prompt tier reads it: a line pulled out of
    // a pasted email must not act as company policy before a human approved it.
    // Same function, same filter — there is no second definition of "the rules".
    const facts = await getConfirmedCompanyFacts(reach.organizationId);
    return {
      ok: true,
      data: envelope(reach, {
        basis: 'confirmed company rulebook entries only; anything still awaiting review is excluded',
        rules: facts.map((fact) => ({
          category: COMPANY_CATEGORY_LABELS[fact.category]?.title.en ?? fact.category,
          topic: fact.topic,
          rule: fact.content,
          recordedBy: fact.createdByName,
        })),
      }),
    };
  },
});
