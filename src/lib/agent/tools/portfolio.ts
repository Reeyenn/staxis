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
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms: reach.roomsOf(propertyId),
        openItems: live.length,
        needingADecision: live.filter((r) => r.disposition === 'propose').length,
        critical: live.filter((r) => r.severity === 'critical').length,
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
          + 'for items where this hotel\'s own history supported one.',
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
      const stillOpen = value.filter((r) => String(r.status ?? 'submitted') !== 'resolved').length;
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms,
        opened,
        stillOpen,
        urgent: value.filter((r) => String(r.severity ?? '').toLowerCase() === 'urgent').length,
        openedPer100Rooms: rooms && rooms > 0 ? dollars((opened / rooms) * 100) : null,
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
        basis: `work orders created in the last ${days} days on each hotel's own maintenance board`,
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
    + 'Use this when the user asks "which hotel is worst/best at X".',
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

    const ranked = results
      .filter((r) => r.value !== null)
      .map(({ propertyId, value }) => {
        const rooms = reach.roomsOf(propertyId);
        const raw = value as number;
        return {
          hotelId: propertyId,
          hotel: reach.nameOf(propertyId),
          rooms,
          value: raw,
          // A per-room figure needs a room count. A hotel without one reports
          // null rather than borrowing the portfolio's average.
          perRoomValue: perRoom && rooms && rooms > 0 ? dollars(raw / rooms) : null,
        };
      })
      .sort((a, b) => {
        const av = perRoom ? (a.perRoomValue ?? -1) : a.value;
        const bv = perRoom ? (b.perRoomValue ?? -1) : b.value;
        if (bv !== av) return bv - av;
        return a.hotel < b.hotel ? -1 : a.hotel > b.hotel ? 1 : 0;
      });

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
        ...unreadNote(failedHotelCount),
        ...(perRoom && ranked.some((r) => r.perRoomValue === null)
          ? { perRoomGap: 'Some hotels have no room count recorded and could not be ranked per room.' }
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
