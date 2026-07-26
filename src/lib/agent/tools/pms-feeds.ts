// ─── PMS money / booking feed query tools (feat/pms-universal-translate) ─────
// Read-only access to the universal PMS feeds (migration 0276):
//   • get_outstanding_balances → pms_guest_balances          ("who owes a balance?")
//   • get_payments_summary     → pms_payments_daily_current  ("how much did we collect today?")
//   • get_future_bookings      → pms_reservations + pms_booking_pace
//                                                            ("how booked are we next weekend?")
//   • get_recent_no_shows      → pms_reservations (status='no_show')
//                                                            ("any no-shows last night?")
//   • get_recent_cancellations → pms_reservations (status='cancelled')
//
// These pms_* tables are RLS deny-all-browser (migration 0276) — they MUST be
// read with the service-role client and scoped to one hotel. That scoping is
// no longer hand-written: every read goes through `ctx.db` (scoped-db.ts),
// which applies the property filter before the builder is handed back.
// Money is stored as integer cents; surfaced to the model as USD strings +
// raw cents. All read-only (mutates:false).
//
// AS-OF GRAIN (migration 0343). Two things changed under this file:
//   1. pms_payments_daily is restatable — a corrected report lands as a new
//      as_of generation for the same business_date instead of overwriting it.
//      Reading the base table would now return several rows for one day and
//      .maybeSingle() would fail on the second one, so both reads here go
//      through pms_payments_daily_current (newest generation per day).
//   2. pms_future_bookings is GONE. It duplicated pms_reservations down to
//      arrival_date / departure_date / status / rate / channel, and its key
//      (property_id, pms_reservation_id) meant a stay date seen on thirty
//      different days collapsed into one row — a booking pace curve that could
//      never be drawn. Individual future stays now come from pms_reservations;
//      the aggregate on-the-books curve comes from pms_booking_pace.
//   3. pms_no_shows and pms_cancellations are GONE too (migration 0354). They
//      were keyed on the same (property_id, pms_reservation_id) as
//      pms_reservations with nothing reconciling them, so one booking could
//      exist in three tables saying three different things. A cancellation is
//      now a state of the reservation — status plus cancelled_date — and a
//      terminal-state trigger stops a stale report un-cancelling it.

import { registerTool, type ToolResult } from '../tools';
import { getPropertyToday } from './queries';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** cents (integer) → "$1,234.56" for the model; null for missing/garbage. */
function usd(cents: unknown): string | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  return (Math.round(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** YYYY-MM-DD ± delta days (UTC math on the date-only string). */
function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/**
 * A2 — the newest arrival stamp across the rows this tool just read, or null.
 *
 * These tables stamp `captured_at NOT NULL DEFAULT now()` on every row
 * (migration 0276; a future-dated value is refused by 0351), so this is a
 * TRUER data age than the property-level signal. executeTool honors an `asOf`
 * the handler already set and computes the age/tier from it.
 *
 * pms_reservations uses `last_synced_at` for the same purpose — it predates
 * the captured_at convention and now serves the no-show and cancellation
 * readers too (migration 0354 folded those tables into it), so both names are
 * accepted rather than silently reporting "age unknown".
 */
function latestCapturedAt(rows: Array<Record<string, unknown>>): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const r of rows) {
    const c = r.captured_at ?? r.last_synced_at;
    if (typeof c !== 'string') continue;
    // Parse rather than compare strings: two rows can legitimately carry
    // different UTC-offset renderings of the same instant.
    const ms = Date.parse(c);
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newestMs = ms;
    newest = c;
  }
  return newest;
}

const FEED_ROLES = ['admin', 'owner', 'general_manager', 'front_desk'] as const;

// ─── get_outstanding_balances ────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_outstanding_balances',
  section: 'financials',
  description:
    'List in-house guests who still owe money on their folio, biggest balance first. ' +
    'Use when: the user asks "who owes a balance", "who hasn\'t paid", "outstanding balances", "quién debe". For money already collected use get_payments_summary instead. ' +
    'Takes no arguments — it always returns the current open balances, up to the 50 largest. ' +
    'Returns: { count, totalOutstanding, guests[] } with each guest\'s name, room, balance, deposit and folio status. totalOutstanding is summed here — quote it rather than adding the rows. Carries asOf; quote the as-of time because a guest may have paid since. ' +
    'Refuses: nothing, but an empty list is ambiguous — it means no balance was captured, which on a hotel whose PMS sends no balances report looks identical to "everyone has paid". Do not tell the user the hotel is settled up unless the feed is actually running.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: FEED_ROLES,
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async (_, ctx): Promise<ToolResult> => {
    const { data, error } = await ctx.db
      .from('pms_guest_balances')
      .select('pms_folio_id, pms_reservation_id, guest_name, room_number, balance_cents, deposit_cents, folio_status, captured_at')
      .gt('balance_cents', 0)
      .order('balance_cents', { ascending: false })
      .limit(50);
    if (error) return { ok: false, error: 'Could not load outstanding balances.' };
    const rows = data ?? [];
    const totalCents = rows.reduce((acc, r) => acc + (Number(r.balance_cents) || 0), 0);
    return {
      ok: true,
      data: {
        asOf: latestCapturedAt(rows),
        count: rows.length,
        totalOutstanding: usd(totalCents),
        guests: rows.map((r) => ({
          guest: r.guest_name ?? null,
          room: r.room_number ?? null,
          balance: usd(r.balance_cents),
          deposit: usd(r.deposit_cents),
          folioStatus: r.folio_status ?? null,
        })),
        note: rows.length === 0
          ? 'No outstanding balances found. (The PMS reader may not capture a balances report on this property yet.)'
          : undefined,
      },
    };
  },
});

// ─── get_payments_summary ────────────────────────────────────────────────────

registerTool<{ date?: string }>({
  name: 'get_payments_summary',
  section: 'financials',
  description:
    'Money COLLECTED on a given day, split into cash, card and deposits. ' +
    'Use when: the user asks "how much did we take today", "today\'s payments", "cashier totals", "cuánto cobramos". For money still owed use get_outstanding_balances; for the month\'s profit and expenses use get_finance_summary. ' +
    'Args: date — YYYY-MM-DD; defaults to today in the hotel\'s own timezone. ' +
    'Returns: { date, cash, card, deposits, total } as formatted dollar strings, plus asOf. If the requested day has no row it falls back to the most recent day on file and says so in `requestedDate` + `note` — read that before answering, or you will report the wrong day\'s money as today\'s. ' +
    'Refuses: callers without financial access at this hotel. Today\'s total is always PARTIAL — it is as of the last report, not the close of business — so never present it as a final figure for the day.',
  inputSchema: {
    type: 'object',
    properties: { date: { type: 'string', description: 'YYYY-MM-DD; defaults to today (property-local).' } },
  },
  allowedRoles: FEED_ROLES,
  // Daily cashier collection totals are revenue figures the manager-floor
  // view_financials capability keeps from line staff. The static FEED_ROLES
  // includes front_desk for operational guest lookups, but this aggregate is
  // financial — gate it. front_desk fails the manager floor; managers honor
  // the per-hotel Access-tab toggle. (Security audit 2026-06-26.)
  requiresCapability: 'view_financials',
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async ({ date }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.db);
    const target = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
    const { data, error } = await ctx.db
      .from('pms_payments_daily_current')
      .select('business_date, cash_collected_cents, card_collected_cents, deposits_collected_cents, total_collected_cents, captured_at')
      .eq('business_date', target)
      .maybeSingle();
    if (error) return { ok: false, error: 'Could not load payments summary.' };
    if (!data) {
      // Fall back to the most recent day we have, so the model can still answer.
      const { data: latest } = await ctx.db
        .from('pms_payments_daily_current')
        // captured_at was missing from THIS select while the primary path
        // above had it — the fallback answer arrived with no data age at all.
        .select('business_date, cash_collected_cents, card_collected_cents, deposits_collected_cents, total_collected_cents, captured_at')
        .order('business_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latest) {
        return { ok: true, data: { date: target, note: 'No payments data captured yet for this property.' } };
      }
      return {
        ok: true,
        data: {
          asOf: latestCapturedAt([latest as Record<string, unknown>]),
          date: latest.business_date,
          requestedDate: target,
          note: `No data for ${target}; showing the most recent day on file.`,
          cash: usd(latest.cash_collected_cents),
          card: usd(latest.card_collected_cents),
          deposits: usd(latest.deposits_collected_cents),
          total: usd(latest.total_collected_cents),
        },
      };
    }
    return {
      ok: true,
      data: {
        asOf: latestCapturedAt([data as Record<string, unknown>]),
        date: data.business_date,
        cash: usd(data.cash_collected_cents),
        card: usd(data.card_collected_cents),
        deposits: usd(data.deposits_collected_cents),
        total: usd(data.total_collected_cents),
      },
    };
  },
});

// ─── get_future_bookings ─────────────────────────────────────────────────────

/** Cancelled / no-show rows are not "on the books" — counting them would
 *  overstate how full next weekend is. NULL status is kept: several PMS
 *  families leave it blank on an ordinary confirmed booking. */
const ON_THE_BOOKS_STATUSES = ['booked', 'checked_in'] as const;

registerTool<{ startDate?: string; endDate?: string }>({
  name: 'get_future_bookings',
  description:
    'Upcoming reservations still ON the books, by arrival date, plus how the room count for those nights has built up day by day (booking pace). ' +
    'Use when: the user asks "how booked are we next weekend", "who\'s arriving Friday", "is next week pacing ahead of last", "cuántas reservas tenemos". For bookings that fell off use get_lost_reservations. ' +
    'Args: startDate / endDate — YYYY-MM-DD inclusive; default is today through 14 days out. ' +
    'Returns: { totalBookings, arrivalsByDate, bookings[], onTheBooksByStayDate, paceCurveByStayDate }. Cancelled and no-show rows are already excluded, and the per-date counts are computed here — quote them rather than counting the list. Carries asOf; quote it. ' +
    'Refuses: nothing, but two honest gaps to state rather than paper over — an empty list may mean the hotel\'s PMS sends no future-reservations report, and when paceCurveByStayDate is absent you can say how many rooms are booked but NOT whether that is ahead of or behind normal. Do not infer a trend from a single snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'YYYY-MM-DD inclusive; defaults to today.' },
      endDate: { type: 'string', description: 'YYYY-MM-DD inclusive; defaults to 14 days out.' },
    },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async ({ startDate, endDate }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.db);
    const start = typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : today;
    const end = typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : addDays(start, 14);

    // Individual future stays: pms_reservations, which has carried every one of
    // these columns since 0202 and is the only place a reservation lives now.
    // Both reads go through ctx.db (scoped-db.ts), which applies the property
    // filter itself — hand-written .eq('property_id', …) is what the wall
    // replaced, and re-adding it here would quietly reintroduce the pattern.
    const [resQ, paceQ] = await Promise.all([
      ctx.db
        .from('pms_reservations')
        .select('pms_reservation_id, guest_name, room_number, room_type, arrival_date, departure_date, rate_per_night_cents, total_amount_cents, status, channel_name')
        .gte('arrival_date', start)
        .lte('arrival_date', end)
        .order('arrival_date', { ascending: true })
        .limit(200),
      // The pace curve: on-the-books rooms for each of those nights, as seen on
      // each day we looked. Best-effort — a hotel with no pace report still gets
      // the reservation list.
      ctx.db
        .from('pms_booking_pace')
        .select('stay_date, as_of_date, rooms_otb, rooms_available, revenue_otb_cents')
        .gte('stay_date', start)
        .lte('stay_date', end)
        .order('stay_date', { ascending: true })
        .order('as_of_date', { ascending: true })
        .limit(500),
    ]);

    if (resQ.error) return { ok: false, error: 'Could not load future bookings.' };
    const rows = (resQ.data ?? []).filter(
      (r) => r.status == null || (ON_THE_BOOKS_STATUSES as readonly string[]).includes(String(r.status)),
    );

    // Arrivals per date so the model can answer "how full is next weekend".
    const byArrivalDate: Record<string, number> = {};
    for (const r of rows) {
      const k = String(r.arrival_date);
      byArrivalDate[k] = (byArrivalDate[k] ?? 0) + 1;
    }

    // One curve per stay night: [{asOf, rooms}, …] oldest first. This is the
    // whole reason pms_booking_pace exists — the old shape could only ever
    // answer "how many rooms right now", never "is it building faster than
    // last week".
    const paceByStayDate: Record<string, Array<{ asOf: string; rooms: number | null }>> = {};
    let latestOtbByStayDate: Record<string, { rooms: number | null; roomsAvailable: number | null; revenue: string | null }> = {};
    if (!paceQ.error) {
      latestOtbByStayDate = {};
      for (const p of paceQ.data ?? []) {
        const stay = String(p.stay_date);
        const rooms = typeof p.rooms_otb === 'number' ? p.rooms_otb : null;
        (paceByStayDate[stay] ??= []).push({ asOf: String(p.as_of_date), rooms });
        // Rows arrive as_of ascending, so the last write per stay date is newest.
        latestOtbByStayDate[stay] = {
          rooms,
          roomsAvailable: typeof p.rooms_available === 'number' ? p.rooms_available : null,
          revenue: usd(p.revenue_otb_cents),
        };
      }
    }
    const hasPace = Object.keys(paceByStayDate).length > 0;

    return {
      ok: true,
      data: {
        asOf: latestCapturedAt(rows),
        range: { start, end },
        totalBookings: rows.length,
        arrivalsByDate: byArrivalDate,
        bookings: rows.map((r) => ({
          guest: r.guest_name ?? null,
          room: r.room_number ?? null,
          roomType: r.room_type ?? null,
          arrival: r.arrival_date ?? null,
          departure: r.departure_date ?? null,
          rate: usd(r.rate_per_night_cents),
          total: usd(r.total_amount_cents),
          status: r.status ?? null,
          channel: r.channel_name ?? null,
        })),
        onTheBooksByStayDate: hasPace ? latestOtbByStayDate : undefined,
        paceCurveByStayDate: hasPace ? paceByStayDate : undefined,
        note: rows.length === 0
          ? 'No upcoming bookings in this range. (The PMS reader may not capture a future-reservations report on this property yet.)'
          : !hasPace
            ? 'Booking pace history is not available for this property yet, so I can only show the current reservation list — not how it built up.'
            : undefined,
      },
    };
  },
});

// ─── get_lost_reservations ───────────────────────────────────────────────────
// Bookings that fell OFF the books: cancelled, or never showed up.
//
// Absorbed get_recent_no_shows and get_recent_cancellations (2026-07-27). Since
// migration 0354 folded pms_no_shows and pms_cancellations into
// pms_reservations, both tools were the identical query — same table, same
// lookback shape, differing only in which terminal `status` they filtered on.
// Keeping them apart made the model choose between two spellings of one
// question, and made "what did we lose this week?" un-answerable without two
// calls it then had to add up itself.

const LOST_KINDS = ['cancelled', 'no_show', 'both'] as const;
type LostKind = (typeof LOST_KINDS)[number];

registerTool<{ kind?: LostKind; days?: number }>({
  name: 'get_lost_reservations',
  description:
    'List bookings the hotel LOST in a recent window — cancelled reservations, guests who never checked in, or both. ' +
    'Use when: the user asks "any no-shows last night", "what cancelled this week", "how much did we lose to cancellations", "hubo cancelaciones". For bookings still ON the books use get_future_bookings instead. ' +
    'Args: kind — "cancelled", "no_show", or "both" (default, when the user just asks what they lost). days — how far back to look, counted from today in the hotel\'s timezone; defaults to 7 for cancellations and 1 for no-shows when you ask for a single kind, and 7 for both. ' +
    'Returns: { count, totalValue, cancelledCount, noShowCount, reservations[] } — each row carries the guest, room, the date it was due to arrive, when it dropped, its value, any cancellation fee and reason, and the booking channel. totalValue is summed here; quote it rather than adding the rows up. Carries asOf — quote it. ' +
    'Refuses: nothing, but an empty list means "none recorded in this window", which is NOT the same as "none happened" — a hotel whose PMS does not send a reservations report will always look clean here. Say which of the two you actually know.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...LOST_KINDS],
        description: 'Which losses to include: cancelled bookings, no-shows, or both (default).',
      },
      days: { type: 'number', description: 'How many days back to look. Defaults to 7 (or 1 when asking only for no-shows).' },
    },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async ({ kind, days }, ctx): Promise<ToolResult> => {
    const which: LostKind = (LOST_KINDS as readonly string[]).includes(kind as string)
      ? (kind as LostKind)
      : 'both';
    // "Last night" was the old no-show default and is what a manager means by a
    // bare "any no-shows?"; a week is the natural window for cancellations.
    const fallback = which === 'no_show' ? 1 : 7;
    const back = Number.isFinite(days) && (days as number) > 0 ? Math.floor(days as number) : fallback;

    const today = await getPropertyToday(ctx.db);
    const cutoff = addDays(today, -back);

    const statuses = which === 'both' ? ['cancelled', 'no_show'] : [which];

    // One read. The date each state is measured from differs (cancelled_date vs
    // arrival_date), so the window is applied per row below rather than in SQL —
    // a `.gte` on either column alone would silently drop the other kind.
    // The select list is a single literal, not a concatenation: PostgREST's
    // generated types parse the string at compile time, and a runtime-built
    // one degrades every column to `GenericStringError`.
    const { data, error } = await ctx.db
      .from('pms_reservations')
      .select('pms_reservation_id, guest_name, room_number, arrival_date, status, cancelled_date, cancellation_fee_cents, cancellation_reason, no_show_date, rate_per_night_cents, total_amount_cents, channel_name, last_synced_at')
      .in('status', statuses)
      .gte('arrival_date', addDays(cutoff, -370))
      .order('arrival_date', { ascending: false })
      .limit(500);
    if (error) return { ok: false, error: 'Could not load lost reservations.' };

    const inWindow = (data ?? []).filter((r) => {
      const dropped = r.status === 'cancelled'
        ? (r.cancelled_date as string | null)
        : (r.no_show_date as string | null) ?? (r.arrival_date as string | null);
      return typeof dropped === 'string' && dropped >= cutoff;
    });

    const totalCents = inWindow.reduce((acc, r) => acc + (Number(r.total_amount_cents) || 0), 0);

    return {
      ok: true,
      data: {
        asOf: latestCapturedAt(inWindow),
        kind: which,
        since: cutoff,
        count: inWindow.length,
        cancelledCount: inWindow.filter((r) => r.status === 'cancelled').length,
        noShowCount: inWindow.filter((r) => r.status === 'no_show').length,
        totalValue: usd(totalCents),
        reservations: inWindow.map((r) => ({
          kind: r.status === 'cancelled' ? 'cancelled' : 'no_show',
          guest: r.guest_name ?? null,
          room: r.room_number ?? null,
          dueArrival: r.arrival_date ?? null,
          droppedOn: r.status === 'cancelled' ? (r.cancelled_date ?? null) : (r.no_show_date ?? null),
          value: usd(r.total_amount_cents),
          cancellationFee: r.status === 'cancelled' ? usd(r.cancellation_fee_cents) : null,
          reason: r.status === 'cancelled' ? (r.cancellation_reason ?? null) : null,
          channel: r.channel_name ?? null,
        })),
        note: inWindow.length === 0
          ? 'Nothing recorded in this window. That may mean none happened, or that this hotel\'s PMS does not send a reservations report yet — say which you know.'
          : undefined,
      },
    };
  },
});
