// ─── Portfolio tools — cross-hotel, READ-ONLY, company-scope only ───────────
//
// Seven tools that answer a company-level question ("which of my hotels had the
// worst week for maintenance", "compare supply spend across my hotels") without
// ever widening the hotel wall.
//
// THREE RULES, AND EVERY TOOL IN THIS FILE OBEYS ALL THREE.
//
// 1. THE WALL STAYS STRUCTURAL. A portfolio read is one bounded, company-
//    intersected RPC over the exact receipt set — never an N+1 client loop and
//    never a caller-authored company/property universe. Each RPC re-proves the
//    live organization relationship in SQL before returning one bucket per
//    requested hotel.
//
// 2. NOTHING IS TRUSTED FROM THE CONTEXT. `ctx.portfolio` says which company is
//    being asked about. It does NOT say what may be read: every tool re-resolves
//    the caller's coverage through `resolvePortfolioAccessUncached` first, and intersects
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
  resolvePortfolioAccessUncached,
} from '@/lib/company/portfolio';
import { assertAuthorizationScopeReceipt } from '@/lib/authorization/server';
import {
  portfolioHotelFindingPolicyDecision,
  portfolioSectionDecision,
  resolvePortfolioQueuePolicy,
  type PortfolioQueuePolicy,
} from '@/lib/company/portfolio-data-policy';
import {
  readPortfolioToolFindings,
  readPortfolioToolHotels,
  readPortfolioToolInventory,
  readPortfolioToolInventoryOrders,
  readPortfolioToolWorkOrderCounts,
  readPortfolioToolWorkOrders,
  type PortfolioToolRow,
  type PortfolioToolRows,
} from '@/lib/company/portfolio-tool-reads';
import { getConfirmedCompanyFacts } from '@/lib/company/rulebook';
import { COMPANY_CATEGORY_LABELS } from '@/lib/company/rulebook-policy';
import { stockStatus } from '@/lib/stock-status';
import {
  boundedHotelIds,
  MAX_PORTFOLIO_HOTELS,
  readOncePerTurn,
  turnNow,
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
 * `resolvePortfolioAccessUncached` found a COMPANY-scope hat. `executeTool` refuses any
 * tool in this file when that field is absent, and the leak suite drives a real
 * property-scope person at the real route to prove it.
 */
const PORTFOLIO_ROLES = ['admin', 'owner', 'general_manager', 'front_desk'] as const;

const PORTFOLIO_SURFACES = ['portfolio'] as const;

const MS_PER_DAY = 86_400_000;
/** 50 payload rows; the 51st row is an honest "more exists" sentinel. */
const MAX_ROWS = 50;
const BATCH_ROW_LIMIT = MAX_ROWS + 1;
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
  /** The caller named specific hotels, so they asked for detail on them. */
  namedHotels: boolean;
  /** One fresh, fail-closed projection policy for this exact read set. */
  policy: PortfolioQueuePolicy;
  /** Receipt reasserted after every asynchronous store/provider boundary. */
  receiptId: string;
  scopeHash: string;
  authorizationHash: string;
}

type ReachResult = { ok: true; reach: Reach } | { ok: false; error: string };

class PortfolioToolScopeChangedError extends Error {}

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
  const fresh = await resolvePortfolioAccessUncached(
    ctx.user.accountId,
    scope.organizationId,
  ).catch(() => ({ ok: false as const, reason: 'authorization_unavailable' as const }));
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
  let namedHotels = false;
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
    if (asked.length > 0) {
      requested = covered.filter((id) => new Set(asked).has(id));
      namedHotels = true;
    }
  }

  const { ids, omittedHotelCount } = boundedHotelIds(requested);
  let hotelRead;
  try {
    hotelRead = await readPortfolioToolHotels(fresh.access.organizationId, ids);
  } catch {
    return { ok: false, error: `Refused: ${PORTFOLIO_REFUSAL_TEXT.authorization_unavailable}` };
  }
  if (hotelRead.unavailablePropertyIds.length > 0) {
    return { ok: false, error: 'Refused: portfolio hotel scope changed while this tool was loading.' };
  }
  const hotels: PortfolioHotel[] = hotelRead.hotels;
  const nameById = new Map(hotels.map((h) => [h.id, h.name ?? 'Unnamed hotel']));
  const roomsById = new Map(hotels.map((h) => [h.id, h.totalRooms]));
  const policy = await resolvePortfolioQueuePolicy(
    ctx.user,
    fresh.access.organizationId,
    ids,
  );
  const receipt = fresh.access.authorizationReceipt;

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
      namedHotels,
      policy,
      receiptId: receipt.id,
      scopeHash: receipt.scopeHash,
      authorizationHash: receipt.authorizationHash,
    },
  };
}

async function assertReachStillCurrent(ctx: ToolHandlerContext, reach: Reach): Promise<void> {
  const assertion = await assertAuthorizationScopeReceipt({
    receiptId: reach.receiptId,
    accountId: ctx.user.accountId,
  });
  if (!assertion.ok
      || assertion.receipt.scopeHash !== reach.scopeHash
      || assertion.receipt.authorizationHash !== reach.authorizationHash) {
    throw new PortfolioToolScopeChangedError('portfolio scope changed while this tool was running');
  }
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

/** Whole days between a stored timestamp and the turn's clock. Null when the
 *  column is empty or unparseable — never a 0, which reads as "today". */
function daysSince(value: unknown, now: Date): number | null {
  if (typeof value !== 'string') return null;
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}

type PolicyFinding = Parameters<typeof portfolioHotelFindingPolicyDecision>[0];

/**
 * Minimal, non-rendering projection for the shared source/money classifier.
 * The batch reader has already validated the full persisted policy shape. This
 * adapter deliberately carries only fields the classifier consumes.
 */
function findingForPortfolioPolicy(
  row: PortfolioToolRow,
  propertyId: string,
): PolicyFinding | null {
  if (row.property_id !== propertyId
      || typeof row.detector_id !== 'string'
      || typeof row.summary !== 'string'
      || !row.evidence
      || typeof row.evidence !== 'object'
      || Array.isArray(row.evidence)) {
    return null;
  }
  const low = numberOf(row.price_low_cents);
  const high = numberOf(row.price_high_cents);
  const hasPriceMaterial = row.price_low_cents != null
    || row.price_high_cents != null
    || row.price_basis != null;
  return {
    propertyId,
    detectorId: row.detector_id,
    summary: row.summary,
    judgedSummaryEn: typeof row.judged_summary_en === 'string' ? row.judged_summary_en : null,
    judgedSummaryEs: typeof row.judged_summary_es === 'string' ? row.judged_summary_es : null,
    evidence: row.evidence,
    price: hasPriceMaterial
      ? {
          lowCents: low ?? 0,
          highCents: high != null && high > (low ?? 0) ? high : (low ?? 0) + 1,
          currency: typeof row.price_currency === 'string' ? row.price_currency : 'USD',
          basis: typeof row.price_basis === 'string' ? row.price_basis : '',
        }
      : null,
  } as PolicyFinding;
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

/** The `hotelIds` argument every aggregate tool accepts, described once. */
const HOTEL_IDS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Optional. Narrow the answer to specific hotels by id, from list_my_hotels. '
    + 'Omit to cover every hotel in the company. Any id outside the company is refused. '
    + 'Naming hotels here also gets you the FULL item-by-item detail for them, which a '
    + 'company-wide answer only carries for the few hotels in the worst shape.',
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

// ─── Reading N hotels, once per turn ────────────────────────────────────────

interface PerHotelRows {
  results: Array<{
    propertyId: string;
    value: Record<string, unknown>[] | null;
    atRowLimit: boolean;
  }>;
  failedHotelCount: number;
  /** Hotels whose read came back AT the row ceiling, so their totals are floors. */
  cappedHotelCount: number;
}

/**
 * One per-hotel row read, memoised for the turn.
 *
 * The key names the dataset, the exact hotels and the exact window, so two
 * different questions never share an answer — and the same question asked twice
 * inside one turn is read once, which is both cheaper AND the only way both
 * halves of a reply can quote the same number.
 *
 * The key deliberately does NOT include the tool's name: the memo is about what
 * was read, not who asked. Two tools issuing byte-identical reads should share.
 */
async function readRowsPerHotel(
  ctx: ToolHandlerContext,
  dataset: string,
  ids: string[],
  reach: Reach,
  read: () => Promise<PortfolioToolRows>,
): Promise<PerHotelRows> {
  try {
    return await readOncePerTurn(ctx, `${dataset}|${ids.join(',')}`, async () => {
      const loaded = await read();
      await assertReachStillCurrent(ctx, reach);
      const unavailable = new Set(loaded.unavailablePropertyIds);
      const results = ids.map((propertyId) => {
        const rows = loaded.rowsByPropertyId.get(propertyId);
        if (unavailable.has(propertyId) || !rows) {
          return { propertyId, value: null, atRowLimit: false };
        }
        return {
          propertyId,
          value: rows.slice(0, MAX_ROWS),
          atRowLimit: rows.length > MAX_ROWS,
        };
      });
      let cappedHotelCount = 0;
      for (const propertyId of ids) {
        if ((loaded.rowsByPropertyId.get(propertyId)?.length ?? 0) > MAX_ROWS) {
          cappedHotelCount += 1;
        }
      }
      return {
        results,
        failedHotelCount: results.filter(({ value }) => value === null).length,
        cappedHotelCount,
      };
    });
  } catch (error) {
    if (error instanceof PortfolioToolScopeChangedError) throw error;
    return {
      results: ids.map((propertyId) => ({
        propertyId,
        value: null,
        atRowLimit: false,
      })),
      failedHotelCount: ids.length,
      cappedHotelCount: 0,
    };
  }
}

function idsEnabledFor(
  reach: Reach,
  section: Parameters<typeof portfolioSectionDecision>[1],
): string[] {
  return reach.ids.filter(
    (propertyId) => portfolioSectionDecision(reach.policy, section, propertyId) === 'enabled',
  );
}

function idsWithFinancialRead(reach: Reach, ids: readonly string[]): string[] {
  return ids.filter((propertyId) => reach.policy.financials.get(propertyId) === 'allowed');
}

function policyFilteredFindingRows(
  loaded: PortfolioToolRows,
  reach: Reach,
): PortfolioToolRows {
  const rowsByPropertyId = new Map<string, PortfolioToolRow[]>();
  const unavailable = new Set(loaded.unavailablePropertyIds);
  for (const [propertyId, rows] of loaded.rowsByPropertyId) {
    const allowed: PortfolioToolRow[] = [];
    let policyUnavailable = false;
    for (const row of rows) {
      const finding = findingForPortfolioPolicy(row, propertyId);
      if (!finding) {
        policyUnavailable = true;
        break;
      }
      const decision = portfolioHotelFindingPolicyDecision(finding, reach.policy);
      if (decision === 'allowed') allowed.push(row);
      else if (decision === 'unavailable') {
        policyUnavailable = true;
        break;
      }
    }
    if (policyUnavailable) unavailable.add(propertyId);
    else rowsByPropertyId.set(propertyId, allowed);
  }
  return {
    rowsByPropertyId,
    unavailablePropertyIds: [...unavailable],
  };
}

/**
 * A ceiling that was actually reached, said out loud.
 *
 * MAX_ROWS exists so one strange hotel cannot dominate a turn. Until now it did
 * that SILENTLY: a hotel with 6,000 matching rows reported 5,000 as if that were
 * the whole truth, and a ranking put it below a hotel with 5,500. A bound nobody
 * is told about is not a bound, it is a wrong answer.
 */
function rowLimitNote(capped: number): Record<string, unknown> {
  return capped > 0
    ? {
        hotelsAtRowLimit: capped,
        rowLimitNote:
          `${capped} hotel${capped === 1 ? ' has' : 's have'} more than ${MAX_ROWS} matching `
          + 'records, so the figures for them are a FLOOR, not a total. Say "at least" for those '
          + 'hotels, and offer to look at one of them on its own.',
      }
    : {};
}

// ─── Bounding the answer ────────────────────────────────────────────────────
//
// EVERY HOTEL KEEPS ITS HEADLINE. ONLY THE DETAIL IS RATIONED.
//
// At twenty hotels, listing five individual problems per hotel is four fifths of
// the payload and answers a question nobody asked — "what needs my attention"
// wants the shape of the portfolio, then the detail behind the worst of it. But
// dropping HOTELS from a ranking would be the one unforgivable failure of this
// surface: "which hotel is worst" cannot be answered from a subset.
//
// So the split is: every covered hotel always carries its counts and its rates;
// the nested item lists go only to the few hotels in the worst shape, or to the
// hotels the caller named. And the payload SAYS SO, because an answer that
// quietly stopped listing things reads exactly like a company with nothing else
// wrong with it.

/** How many hotels get item-by-item detail in a company-wide answer. */
const DETAIL_HOTELS = 3;
/** …and when the caller named hotels, how many of those get it. */
const NAMED_DETAIL_HOTELS = 10;

function detailPlan(
  ranked: readonly string[],
  namedHotels: boolean,
): { detailFor: Set<string>; note: Record<string, unknown> } {
  const budget = namedHotels ? NAMED_DETAIL_HOTELS : DETAIL_HOTELS;
  const detailFor = new Set(ranked.slice(0, budget));
  const withheld = ranked.length - detailFor.size;
  return {
    detailFor,
    note: withheld > 0
      ? {
          detailNote:
            `Individual items are listed for the ${detailFor.size} hotel${detailFor.size === 1 ? '' : 's'} `
            + `in the worst shape. The other ${withheld} still show every total and rate above, but `
            + 'their item lists were left out to keep one answer readable. Say so if it matters, and '
            + 'call this tool again with hotelIds set to any hotel to see its items.',
        }
      : {},
  };
}

// ─── Ranked, not merely listed ──────────────────────────────────────────────
//
// The rationing above already worked out which hotels are in the worst shape,
// in order — and then handed back an answer in ARBITRARY order anyway, because
// the rows came out in whatever order the hotel ids went in. That is the "17
// dumps" failure wearing a smaller payload: a VP asking "which of my hotels
// needs me" got seventeen equal-looking rows and a model left to re-derive the
// ranking from them, which is exactly the arithmetic this file does in code
// everywhere else precisely so a model never has to.
//
// So the same order that decides who gets detail also decides who is printed
// first. It costs nothing — no extra bytes, no extra reads — and it means the
// first row of every answer is the hotel the question was about.

/**
 * Reorder an answer's rows to match a ranking computed from them.
 *
 * Hotels missing from `rankedIds` — the ones whose read failed, which have no
 * figures to rank on — go LAST, in the order they came in. Sorting them as if
 * their absent numbers were zeros would put a hotel Staxis could not read at
 * the bottom of a "worst first" list, which reads as "this one is fine".
 */
function inRankedOrder<T extends { hotelId: string }>(
  rows: readonly T[],
  rankedIds: readonly string[],
): T[] {
  const place = new Map(rankedIds.map((id, i) => [id, i]));
  // Stable, so unranked rows keep their relative order rather than shuffling.
  return [...rows].sort(
    (a, b) => (place.get(a.hotelId) ?? Number.MAX_SAFE_INTEGER)
      - (place.get(b.hotelId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Said once per answer, not once per hotel: the order carries meaning. */
const RANKED_NOTE =
  ' Listed WORST FIRST — the first row is the hotel to talk about; unread hotels last.';

/** Name-ascending, the tie-break every ranking here shares. */
function byHotelName(a: { hotel: string }, b: { hotel: string }): number {
  return a.hotel < b.hotel ? -1 : a.hotel > b.hotel ? 1 : 0;
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
    await assertReachStillCurrent(ctx, reach);
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
    const now = turnNow(ctx);
    const perHotel = Math.min(Math.max(Math.round(numberOf(args?.limitPerHotel) ?? 5), 1), 20);

    // `magnitude` used to be selected here and never read — one more numeric
    // column per row per hotel, for nobody.
    const findingHotelIds = idsEnabledFor(reach, 'staxis');
    const { results, failedHotelCount, cappedHotelCount } = await readRowsPerHotel(
      ctx,
      'findings',
      reach.ids,
      reach,
      async () => policyFilteredFindingRows(
        await readPortfolioToolFindings(
          reach.organizationId,
          findingHotelIds,
          ['open', 'updated', 'known_problem'],
          BATCH_ROW_LIMIT,
        ),
        reach,
      ),
    );

    const measured = results.map(({ propertyId, value, atRowLimit }) => {
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
        ...(atRowLimit ? { atRowLimit: true as const } : {}),
        _items: ranked.slice(0, perHotel).map((r) => ({
          summary: r.summary,
          severity: r.severity,
          disposition: r.disposition,
          detector: r.detector_id,
          dollarsLow: numberOf(r.price_low_cents) === null ? null : dollars((numberOf(r.price_low_cents) ?? 0) / 100),
          dollarsHigh: numberOf(r.price_high_cents) === null ? null : dollars((numberOf(r.price_high_cents) ?? 0) / 100),
          // Two full ISO timestamps per item, when the question is always "how
          // long has this been sitting there". One integer, computed here, is
          // both smaller and the thing the sentence actually needs.
          daysOpen: daysSince(r.first_seen_at, now),
          daysSinceLastSeen: daysSince(r.last_seen_at, now),
        })),
      };
    });

    // Worst first — criticals outrank volume, because ten paper-cuts is not a
    // worse morning than one flooded room.
    const worstFirst = [...measured]
      .filter((h): h is Extract<typeof h, { read: true }> => h.read)
      .sort((a, b) => (b.critical - a.critical) || (b.openItems - a.openItems) || byHotelName(a, b))
      .map((h) => h.hotelId);
    const { detailFor, note } = detailPlan(worstFirst, reach.namedHotels);

    const hotels = inRankedOrder(
      measured.map((h) => {
        if (!h.read) return h;
        const { _items, ...headline } = h;
        return detailFor.has(h.hotelId) ? { ...headline, items: _items } : headline;
      }),
      worstFirst,
    );

    return {
      ok: true,
      data: envelope(reach, {
        basis: 'Staxis\'s own open findings, read live. Dollar figures are RANGES and only exist '
          + 'for items where this hotel\'s own history supported one. Per-100-rooms figures are '
          + 'already worked out here — quote them, never divide.' + RANKED_NOTE,
        hotels,
        ...note,
        ...unreadNote(failedHotelCount),
        ...rowLimitNote(cappedHotelCount),
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
    const since = sinceIso(days, turnNow(ctx));

    // `room_number` used to be selected here and never read — a string per
    // ticket per hotel, carried across the wire for nobody.
    const maintenanceHotelIds = idsEnabledFor(reach, 'maintenance');
    let loaded: Awaited<ReturnType<typeof readPortfolioToolWorkOrders>> | null = null;
    try {
      loaded = await readOncePerTurn(
        ctx,
        `work_orders:${days}|${reach.ids.join(',')}`,
        async () => {
          const summaries = await readPortfolioToolWorkOrders(
            reach.organizationId,
            maintenanceHotelIds,
            idsWithFinancialRead(reach, maintenanceHotelIds),
            since,
          );
          await assertReachStillCurrent(ctx, reach);
          return summaries;
        },
      );
    } catch (error) {
      if (error instanceof PortfolioToolScopeChangedError) throw error;
    }
    const unavailable = new Set(loaded?.unavailablePropertyIds ?? reach.ids);
    const measured = reach.ids.map((propertyId) => {
      const summary = loaded?.summariesByPropertyId.get(propertyId);
      if (!summary || unavailable.has(propertyId)) {
        return { hotelId: propertyId, hotel: reach.nameOf(propertyId), read: false as const };
      }
      const rooms = reach.roomsOf(propertyId);
      return {
        hotelId: propertyId,
        hotel: reach.nameOf(propertyId),
        read: true as const,
        rooms,
        opened: summary.opened,
        stillOpen: summary.stillOpen,
        /** How the STILL-OPEN tickets grade, in one vocabulary. */
        stillOpenBySeverity: summary.stillOpenBySeverity,
        openedPer100Rooms: per100Rooms(summary.opened, rooms),
        stillOpenPer100Rooms: per100Rooms(summary.stillOpen, rooms),
        // Only from tickets where somebody typed a cost in. A hotel that never
        // fills that in reports null, not $0 — $0 would read as "free".
        recordedRepairSpendDollars: summary.recordedRepairSpend === null
          ? null
          : dollars(summary.recordedRepairSpend),
        repairCostSamples: summary.repairCostSamples,
      };
    });
    const failedHotelCount = measured.filter((hotel) => !hotel.read).length;

    // Worst first on the BACKLOG, not on the volume: a hotel that opened thirty
    // tickets and closed twenty-eight is being run well, and a hotel with nine
    // tickets still sitting open is the one to ask about. Urgent breaks the tie,
    // for the same reason criticals outrank volume in the findings answer.
    const hotels = inRankedOrder(
      measured,
      [...measured]
        .filter((h): h is Extract<typeof h, { read: true }> => h.read)
        .sort((a, b) => (b.stillOpen - a.stillOpen)
          || (b.stillOpenBySeverity.urgent - a.stillOpenBySeverity.urgent)
          || (b.opened - a.opened) || byHotelName(a, b))
        .map((h) => h.hotelId),
    );

    return {
      ok: true,
      data: envelope(reach, {
        windowDays: days,
        basis: `work orders created in the last ${days} days on each hotel's own maintenance board. `
          + 'Severity is normalised: this column holds two vocabularies (MAJOR/MINOR from the '
          + 'housekeeper app, low/medium/urgent from the maintenance board), and '
          + 'stillOpenBySeverity folds both into urgent / high / normal / low / ungraded. '
          + '"ungraded" means nobody graded it, not that it is minor. '
          + 'Per-100-rooms figures are already worked out here — quote them, never divide.'
          + ' Listed by BACKLOG — most still-open tickets first, not most opened;'
          + ' unread hotels last.',
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
    const since = sinceIso(days, turnNow(ctx));

    const inventoryHotelIds = idsEnabledFor(reach, 'inventory');
    const spendHotelIds = idsWithFinancialRead(reach, inventoryHotelIds);
    const { results, failedHotelCount, cappedHotelCount } = await readRowsPerHotel(
      ctx,
      `inventory_orders:${days}`,
      reach.ids,
      reach,
      () => readPortfolioToolInventoryOrders(
        reach.organizationId,
        spendHotelIds,
        since,
        BATCH_ROW_LIMIT,
      ),
    );

    const measured = results.map(({ propertyId, value, atRowLimit }) => {
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
        ...(atRowLimit ? { atRowLimit: true as const } : {}),
      };
    });

    // Biggest spender first, on TOTAL dollars, because that is the plain reading
    // of "who is spending the most". A hotel whose deliveries were all logged
    // without a price has no total to rank on and sorts below every hotel that
    // does — its rows are counted, but it cannot be called the cheapest.
    const hotels = inRankedOrder(
      measured,
      [...measured]
        .filter((h): h is Extract<typeof h, { read: true }> => h.read)
        .sort((a, b) => ((b.spendDollars ?? -1) - (a.spendDollars ?? -1)) || byHotelName(a, b))
        .map((h) => h.hotelId),
    );

    return {
      ok: true,
      data: envelope(reach, {
        windowDays: days,
        basis: `deliveries received in the last ${days} days, from each hotel's own inventory ledger. `
          + 'Deliveries logged without a cost are counted but not priced.'
          + ' Listed by TOTAL spend, highest first — not per room; unread hotels last.',
        hotels,
        ...unreadNote(failedHotelCount),
        ...rowLimitNote(cappedHotelCount),
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

    const inventoryHotelIds = idsEnabledFor(reach, 'inventory');
    const { results, failedHotelCount, cappedHotelCount } = await readRowsPerHotel(
      ctx,
      'inventory',
      reach.ids,
      reach,
      () => readPortfolioToolInventory(
        reach.organizationId,
        inventoryHotelIds,
        BATCH_ROW_LIMIT,
      ),
    );

    const measured = results.map(({ propertyId, value, atRowLimit }) => {
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
        ...(atRowLimit ? { atRowLimit: true as const } : {}),
        _worstItems: critical
          .sort((a, b) => (a.par > 0 ? a.onHand / a.par : 1) - (b.par > 0 ? b.onHand / b.par : 1))
          .slice(0, 5)
          .map((i) => ({ item: i.name, onHand: i.onHand, par: i.par, unit: i.unit })),
      };
    });

    // Worst first: most Critical items, then most Low — a hotel one delivery
    // away from running out of everything outranks one that is merely untidy.
    const worstFirst = [...measured]
      .filter((h): h is Extract<typeof h, { read: true }> => h.read)
      .sort((a, b) => (b.critical - a.critical) || (b.low - a.low) || byHotelName(a, b))
      .map((h) => h.hotelId);
    const { detailFor, note } = detailPlan(worstFirst, reach.namedHotels);

    const hotels = inRankedOrder(
      measured.map((h) => {
        if (!h.read) return h;
        const { _worstItems, ...headline } = h;
        return detailFor.has(h.hotelId) ? { ...headline, worstItems: _worstItems } : headline;
      }),
      worstFirst,
    );

    return {
      ok: true,
      data: envelope(reach, {
        basis: 'on-hand against par right now, using the app-wide 70/30 rule '
          + '(at or above 70% of par is Good, 30-70% is Low, below 30% is Critical).'
          + RANKED_NOTE,
        hotels,
        ...note,
        ...unreadNote(failedHotelCount),
        ...rowLimitNote(cappedHotelCount),
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
    const since = sinceIso(days, turnNow(ctx));
    const perRoom = args?.perRoom === true;

    type CompareRead = {
      results: Array<{
        propertyId: string;
        value: number | null;
        atRowLimit: boolean;
      }>;
      failedHotelCount: number;
      cappedHotelCount: number;
    };
    const compareRead: CompareRead = await readOncePerTurn(
      ctx,
      `compare:${metric}:${metric === 'rooms' ? '-' : days}|${reach.ids.join(',')}`,
      async () => {
        if (metric === 'rooms') {
          await assertReachStillCurrent(ctx, reach);
          const results = reach.ids.map((propertyId) => ({
            propertyId,
            value: reach.roomsOf(propertyId),
            atRowLimit: false,
          }));
          return {
            results,
            failedHotelCount: results.filter(({ value }) => value === null).length,
            cappedHotelCount: 0,
          };
        }

        if (metric === 'work_orders') {
          const readableIds = idsEnabledFor(reach, 'maintenance');
          let loaded: Awaited<ReturnType<typeof readPortfolioToolWorkOrderCounts>>;
          try {
            loaded = await readPortfolioToolWorkOrderCounts(
              reach.organizationId,
              readableIds,
              since,
            );
          } catch {
            return {
              results: reach.ids.map((propertyId) => ({
                propertyId,
                value: null,
                atRowLimit: false,
              })),
              failedHotelCount: reach.ids.length,
              cappedHotelCount: 0,
            };
          }
          await assertReachStillCurrent(ctx, reach);
          const unavailable = new Set(loaded.unavailablePropertyIds);
          const results = reach.ids.map((propertyId) => ({
            propertyId,
            value: unavailable.has(propertyId)
              ? null
              : loaded.countsByPropertyId.get(propertyId) ?? null,
            atRowLimit: false,
          }));
          return {
            results,
            failedHotelCount: results.filter(({ value }) => value === null).length,
            cappedHotelCount: 0,
          };
        }

        const readableIds = metric === 'supply_spend'
          ? idsWithFinancialRead(reach, idsEnabledFor(reach, 'inventory'))
          : idsEnabledFor(reach, 'staxis');
        const rows = await readRowsPerHotel(
          ctx,
          `compare-rows:${metric}:${days}`,
          reach.ids,
          reach,
          async () => {
            if (metric === 'supply_spend') {
              return readPortfolioToolInventoryOrders(
                reach.organizationId,
                readableIds,
                since,
                BATCH_ROW_LIMIT,
              );
            }
            return policyFilteredFindingRows(
              await readPortfolioToolFindings(
                reach.organizationId,
                readableIds,
                ['open', 'updated'],
                BATCH_ROW_LIMIT,
              ),
              reach,
            );
          },
        );
        return {
          results: rows.results.map(({ propertyId, value, atRowLimit }) => {
            if (value === null) return { propertyId, value: null, atRowLimit };
            if (metric === 'open_items') {
              return { propertyId, value: value.length, atRowLimit };
            }
            let total = 0;
            for (const row of value) {
              const amount = numberOf(row.total_cost)
                ?? ((numberOf(row.unit_cost) ?? 0) * (numberOf(row.quantity) ?? 0));
              total += amount;
            }
            return { propertyId, value: dollars(total), atRowLimit };
          }),
          failedHotelCount: rows.failedHotelCount,
          cappedHotelCount: rows.cappedHotelCount,
        };
      },
    );
    const { results, failedHotelCount, cappedHotelCount } = compareRead;

    const scored = results
      .filter((r) => r.value !== null)
      .map(({ propertyId, value, atRowLimit }) => {
        const rooms = reach.roomsOf(propertyId);
        const raw = value as number;
        const usableRooms = rooms && rooms > 0 ? rooms : null;
        return {
          hotelId: propertyId,
          hotel: reach.nameOf(propertyId),
          rooms,
          value: raw,
          ...(atRowLimit ? { atRowLimit: true as const } : {}),
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

    // `perRoomValue` is PUBLISHED ONLY WHEN IT WAS ASKED FOR. Ranking by total
    // left it `null` on every row — seventeen dead keys carried into the model's
    // context to say nothing, sitting next to a per100RoomsValue that is always
    // populated and is how a VP says the same thing out loud anyway.
    const ranked = scored.map(({ _exactPerRoom, perRoomValue, ...r }) => ({
      ...r,
      ...(perRoom ? { perRoomValue } : {}),
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
        ...rowLimitNote(cappedHotelCount),
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
    await assertReachStillCurrent(ctx, reach);
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
