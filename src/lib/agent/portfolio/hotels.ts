import 'server-only';

// ─── The portfolio's hotels, read one hotel at a time ───────────────────────
//
// THE SHAPE OF EVERY CROSS-HOTEL READ IN THIS CODEBASE.
//
// A portfolio answer is a LOOP over `scopedDb(pid)`, never a single query with
// `.in('property_id', […])`. That is not a style preference:
//
//   • `scopedDb` pre-applies the hotel filter before the caller sees a builder,
//     so there is no unfiltered builder to forget it on. A cross-property `.in`
//     would need the raw service-role client, which the eslint rule and
//     `scripts/audit-service-role-imports.mjs` refuse inside `src/lib/agent/**`.
//   • The wall therefore stays STRUCTURAL at portfolio scope. The set of hotels
//     is decided ONCE, by the spine, and every read is bounded by one of them.
//     A bug in this file can return the wrong SUBSET of the caller's own
//     hotels; it cannot reach a hotel the spine did not hand it.
//   • The cost is N indexed single-row reads instead of one. A management
//     company owns 5-50 hotels (`src/lib/company/roles.ts`), which is why
//     MAX_PORTFOLIO_HOTELS below is where it is.
//
// Anything added to the portfolio surface later must keep this shape.
//
// ─── AND THE PRICE OF THAT SHAPE, PAID DELIBERATELY ─────────────────────────
//
// The loop was proved on a two-hotel demo. The customer it was built for runs
// SEVENTEEN TO TWENTY, and at that size the loop is the answer's latency, the
// turn's database load, and most of the tokens the model is billed for. Three
// things in this file exist because of that, and none of them touches the shape:
//
//   1. THE FAN-OUT IS BOUNDED (`PORTFOLIO_READ_CONCURRENCY`). It was already
//      parallel — `Promise.all` over every hotel at once — which at twenty
//      hotels times several tools in one turn is sixty-plus simultaneous reads
//      fired by ONE person's chat message. PostgREST answers from a connection
//      pool an order of magnitude smaller than that, and it is the SAME pool the
//      hotel-facing app is using. So the fan-out is capped: the VP's answer takes
//      three waves instead of one, and the front desk keeps its connections.
//   2. HOTEL NAMES AND SIZES ARE CACHED PER HOTEL, not per requested set, so
//      narrowing a follow-up to three of the twenty costs nothing.
//   3. AN IDENTICAL READ HAPPENS ONCE PER TURN (`readOncePerTurn`), so a model
//      that calls the same aggregate twice inside one answer pays for it once —
//      and both halves of its answer quote the same numbers.
//
// What is NOT here, on purpose: a batched `.in('property_id', ids)` accessor.
// It would collapse N reads to 1, and it would also make
// `portfolio-chat-leak.integration.test.ts` — which asserts that every statement
// against a hotel-scoped table carried an `eq` on the hotel column — stop being
// able to make that assertion. That suite is the wall's specification. Twenty
// indexed single-row reads are a cheaper thing to spend than it.

import { scopedDb } from '@/lib/agent/scoped-db';

/**
 * How many hotels one portfolio read will touch.
 *
 * Not a permission boundary — the caller still COVERS every hotel past it. It
 * is a per-turn cost ceiling, and every reader that hits it must say so out
 * loud rather than silently answering for a subset (an unlabelled partial
 * answer to "which hotel had the worst week" is the worst possible failure of
 * this whole surface).
 */
export const MAX_PORTFOLIO_HOTELS = 50;

export interface PortfolioHotel {
  id: string;
  name: string | null;
  /** `properties.total_rooms`, kept in lock-step with room_inventory by the
   *  0125 trigger (INV-24). Structural, so it is safe in the cached prompt. */
  totalRooms: number | null;
  timezone: string | null;
}

/** What a portfolio read covered, and what it had to leave out. */
export interface PortfolioReach<T> {
  rows: T[];
  /** Hotels the caller covers that this read did not touch, and why. */
  omittedHotelCount: number;
}

/**
 * Bound a covered set to what one turn will read, preserving the caller's own
 * sort so "the first 50" is deterministic rather than whatever the map yielded.
 */
export function boundedHotelIds(propertyIds: readonly string[]): {
  ids: string[];
  omittedHotelCount: number;
} {
  const unique = [...new Set(propertyIds)].sort();
  return {
    ids: unique.slice(0, MAX_PORTFOLIO_HOTELS),
    omittedHotelCount: Math.max(0, unique.length - MAX_PORTFOLIO_HOTELS),
  };
}

/**
 * How many hotels one portfolio read touches AT THE SAME TIME.
 *
 * Not a correctness bound — every hotel is still read, just not all at once.
 *
 * WHY IT IS NOT "ALL OF THEM". The reads go to PostgREST over HTTP, and
 * PostgREST serves them from a database connection pool in the low tens that
 * the hotel-facing app is ALSO drawing on. One VP typing one sentence can make
 * the model call four aggregate tools; unbounded, that is four times twenty
 * simultaneous requests from a single chat turn, and the first thing that
 * degrades is not the VP's answer, it is a housekeeper's room list.
 *
 * WHY EIGHT. Twenty hotels finish in three waves, so the added latency is two
 * extra round trips (tens of milliseconds) rather than a queue; and eight is
 * comfortably under any pool the product runs against, so the portfolio surface
 * can never be the reason something else waits.
 */
export const PORTFOLIO_READ_CONCURRENCY = 8;

/**
 * `Promise.all(items.map(f))`, but never more than `limit` of them in flight.
 *
 * Results stay in the INPUT's order however the lanes finish, because callers
 * zip them back against the list they passed in.
 *
 * A worker pool rather than a chunked `Promise.all` of slices: a chunk waits for
 * its slowest member before the next chunk starts, so one slow hotel idles the
 * other seven lanes. Here a lane picks up the next item the moment it is free.
 * `next += 1` needs no lock — this is one JS thread, and there is no await
 * between reading the index and moving it.
 *
 * Rejections propagate, exactly as `Promise.all` does. Callers that must survive
 * one bad item (every per-hotel read) catch inside `run`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      out[index] = await run(items[index], index);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return out;
}

/**
 * Run one per-hotel read across the covered set, each through its own
 * hotel-scoped accessor, at most `PORTFOLIO_READ_CONCURRENCY` at a time.
 *
 * Results come back in the caller's order regardless of which read finished
 * first — a ranking that reshuffled with network timing would be a different
 * answer to the same question every time it was asked.
 *
 * Failure-isolated: a hotel whose read throws contributes `null` rather than
 * failing the whole portfolio. One unreachable hotel must not blank a VP's
 * answer about the other nineteen — but the caller is told, so it can say
 * which hotels it could not read instead of implying they were quiet.
 */
export async function forEachHotel<T>(
  propertyIds: readonly string[],
  read: (db: ReturnType<typeof scopedDb>, propertyId: string) => Promise<T>,
): Promise<{ results: Array<{ propertyId: string; value: T | null }>; failedHotelCount: number }> {
  const ids = [...propertyIds];
  let failedHotelCount = 0;
  const results = await mapWithConcurrency(
    ids,
    PORTFOLIO_READ_CONCURRENCY,
    async (propertyId) => {
      try {
        return { propertyId, value: await read(scopedDb(propertyId), propertyId) };
      } catch {
        failedHotelCount += 1;
        return { propertyId, value: null as T | null };
      }
    },
  );
  return { results, failedHotelCount };
}

// ─── One read per turn ──────────────────────────────────────────────────────
//
// A portfolio turn can call the same aggregate more than once — the model ranks
// the hotels, then asks the same question again to write the sentence. Without
// this, that is a second full fan-out for numbers that cannot have changed
// inside one answer, and worse, the two halves of the reply can quote DIFFERENT
// numbers if a work order was filed between them.
//
// THE KEY IS AN OBJECT, AND THAT IS THE WHOLE SAFETY ARGUMENT.
//
// The obvious key is `ctx.requestId` — and it is unsafe: `getOrMintRequestId`
// echoes a caller-supplied `x-request-id` header back, so a client could pin two
// different turns (or two different PEOPLE) to the same string and make them
// share a cache of hotel data. So the key is instead `ctx.portfolio`: the object
// the portfolio route builds ONCE per turn, after the whole gate stack passed,
// and hands to every tool call in that turn by reference. Two turns are two
// objects, so they cannot share; nothing a client sends can name an object it
// does not already hold; and a WeakMap lets the whole memo be collected with the
// turn instead of lingering in a global cache with a TTL somebody has to reason
// about.
//
// A context with no `portfolio` (the eval harness, a direct unit test) gets a
// throwaway memo, so it behaves exactly as if this did not exist.

interface TurnMemo {
  /** ONE clock for the turn. Two tools must not disagree about where "the last
   *  30 days" starts, or a ranking and its explanation cover different windows. */
  now: Date;
  reads: Map<string, Promise<unknown>>;
}

const TURN_MEMOS = new WeakMap<object, TurnMemo>();

function memoFor(ctx: { portfolio?: object }): TurnMemo {
  const key = ctx.portfolio;
  if (!key) return { now: new Date(), reads: new Map() };
  let memo = TURN_MEMOS.get(key);
  if (!memo) {
    memo = { now: new Date(), reads: new Map() };
    TURN_MEMOS.set(key, memo);
  }
  return memo;
}

/** The single moment this whole turn is answering "as of". */
export function turnNow(ctx: { portfolio?: object }): Date {
  return memoFor(ctx).now;
}

/**
 * Run `load` once per turn per `key`, and hand every later caller in that turn
 * the same answer.
 *
 * The PROMISE is memoised, not the result, so two tools that ask concurrently
 * share one fan-out rather than racing into two.
 *
 * A failed load is NOT remembered: it is dropped from the memo so a later tool
 * in the same turn gets a real attempt rather than a cached exception.
 */
export async function readOncePerTurn<T>(
  ctx: { portfolio?: object },
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const memo = memoFor(ctx);
  const existing = memo.reads.get(key);
  if (existing) return existing as Promise<T>;
  const pending = load().catch((e: unknown) => {
    memo.reads.delete(key);
    throw e;
  });
  memo.reads.set(key, pending);
  return pending;
}

/**
 * The hotels themselves — name, size, timezone. One scoped read each.
 *
 * `properties` is scoped on `id` (SCOPE_COLUMN_OVERRIDES), so the accessor's
 * filter and the row's identity are the same predicate: a hotel row cannot come
 * back through an accessor built for a different hotel.
 */
// Names and sizes are STRUCTURAL: they move when a hotel is renamed or its room
// list changes, which is not something that happens inside one conversation.
// The cache exists because a portfolio turn calls several tools and every one
// of them labels its rows with hotel names — without it, one question costs
// (tools x hotels) single-row reads of the same unchanging text.
//
// KEYED PER HOTEL, NOT PER REQUESTED SET. The obvious cache — one entry per
// sorted id list — is a cache that misses the moment anything narrows, and
// narrowing is what a portfolio conversation DOES: rank twenty, then ask about
// three. Per hotel, those three are already in hand and the follow-up costs no
// reads at all.
const HOTEL_TTL_MS = 60_000;
/** Loosely bounded so a Staxis admin sweeping many companies cannot grow it
 *  without limit; entries are cheap and expire on their own. */
const HOTEL_CACHE_MAX = 500;
const hotelCache = new Map<string, { hotel: PortfolioHotel; expiresAt: number }>();

/** Test seam: forget every hotel row read so far. */
export function clearPortfolioHotelCache(): void {
  hotelCache.clear();
}

function rememberHotel(hotel: PortfolioHotel, now: number): void {
  if (hotelCache.size >= HOTEL_CACHE_MAX) {
    for (const [id, entry] of hotelCache) {
      if (entry.expiresAt <= now) hotelCache.delete(id);
    }
    // Still full of live entries — drop the oldest insertions rather than
    // refusing to cache, which would silently turn the fast path off forever.
    while (hotelCache.size >= HOTEL_CACHE_MAX) {
      const oldest = hotelCache.keys().next();
      if (oldest.done) break;
      hotelCache.delete(oldest.value);
    }
  }
  hotelCache.set(hotel.id, { hotel, expiresAt: now + HOTEL_TTL_MS });
}

export async function loadPortfolioHotels(
  propertyIds: readonly string[],
): Promise<PortfolioHotel[]> {
  const now = Date.now();
  const hotels: PortfolioHotel[] = [];
  const missing: string[] = [];
  for (const id of new Set(propertyIds)) {
    const hit = hotelCache.get(id);
    if (hit && hit.expiresAt > now) hotels.push(hit.hotel);
    else missing.push(id);
  }

  if (missing.length > 0) {
    const fresh = await loadPortfolioHotelsUncached(missing);
    for (const hotel of fresh) {
      rememberHotel(hotel, now);
      hotels.push(hotel);
    }
    // A hotel that did NOT come back is deliberately not cached as absent: the
    // read may simply have failed, and remembering a transient failure as "this
    // hotel does not exist" would drop it from a VP's answer for a full minute.
  }

  return sortHotelsForPrompt(hotels);
}

async function loadPortfolioHotelsUncached(
  propertyIds: readonly string[],
): Promise<PortfolioHotel[]> {
  const { results } = await forEachHotel(propertyIds, async (db, propertyId) => {
    const { data, error } = await db
      .from('properties')
      .select('id, name, total_rooms, timezone')
      .maybeSingle() as unknown as {
        data: { id: string; name: string | null; total_rooms: number | null; timezone: string | null } | null;
        error: { message: string } | null;
      };
    if (error) throw new Error(`properties read failed for ${propertyId}: ${error.message}`);
    return data;
  });

  const hotels: PortfolioHotel[] = [];
  for (const { propertyId, value } of results) {
    if (!value) continue;
    hotels.push({
      id: value.id ?? propertyId,
      name: value.name ?? null,
      totalRooms: value.total_rooms == null ? null : Number(value.total_rooms),
      timezone: value.timezone ?? null,
    });
  }

  return hotels;
}

/**
 * Sorted by NAME, with the id as the tie-break, so the identity block that
 * renders this list is byte-identical run to run whatever order the reads
 * resolved in — or whichever hotels happened to be cached. A list that
 * reshuffles is a cached prompt that never hits.
 */
function sortHotelsForPrompt(hotels: PortfolioHotel[]): PortfolioHotel[] {
  return hotels.sort((a, b) => {
    const an = a.name ?? '';
    const bn = b.name ?? '';
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
