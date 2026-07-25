// ─── PMS money / booking feed query tools (feat/pms-universal-translate) ─────
// Read-only access to the universal PMS feeds (migration 0276):
//   • get_outstanding_balances → pms_guest_balances          ("who owes a balance?")
//   • get_payments_summary     → pms_payments_daily_current  ("how much did we collect today?")
//   • get_future_bookings      → pms_reservations + pms_booking_pace
//                                                            ("how booked are we next weekend?")
//   • get_recent_no_shows      → pms_no_shows                ("any no-shows last night?")
//   • get_recent_cancellations → pms_cancellations
//
// These pms_* tables are RLS deny-all-browser (migration 0276) — they MUST be
// read with the service-role client and scoped by ctx.propertyId (tenant
// isolation). Money is stored as integer cents; surfaced to the model as USD
// strings + raw cents. All read-only (mutates:false).
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

import { supabaseAdmin } from '@/lib/supabase-admin';
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

const FEED_ROLES = ['admin', 'owner', 'general_manager', 'front_desk'] as const;

// ─── get_outstanding_balances ────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_outstanding_balances',
  section: 'financials',
  description:
    'List guests who currently OWE money (outstanding folio balances), highest first. Use for "who owes a balance?", "outstanding balances", "who hasn\'t paid". Read-only.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: FEED_ROLES,
  mutates: false,
  handler: async (_, ctx): Promise<ToolResult> => {
    const { data, error } = await supabaseAdmin
      .from('pms_guest_balances')
      .select('pms_folio_id, pms_reservation_id, guest_name, room_number, balance_cents, deposit_cents, folio_status, captured_at')
      .eq('property_id', ctx.propertyId)
      .gt('balance_cents', 0)
      .order('balance_cents', { ascending: false })
      .limit(50);
    if (error) return { ok: false, error: 'Could not load outstanding balances.' };
    const rows = data ?? [];
    const totalCents = rows.reduce((acc, r) => acc + (Number(r.balance_cents) || 0), 0);
    return {
      ok: true,
      data: {
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
    'Get money COLLECTED for a day (cash + card + deposits), defaulting to today. Use for "how much did we collect today?", "today\'s payments", "cashier totals". Read-only.',
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
  handler: async ({ date }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.propertyId);
    const target = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
    const { data, error } = await supabaseAdmin
      .from('pms_payments_daily_current')
      .select('business_date, cash_collected_cents, card_collected_cents, deposits_collected_cents, total_collected_cents, captured_at')
      .eq('property_id', ctx.propertyId)
      .eq('business_date', target)
      .maybeSingle();
    if (error) return { ok: false, error: 'Could not load payments summary.' };
    if (!data) {
      // Fall back to the most recent day we have, so the model can still answer.
      const { data: latest } = await supabaseAdmin
        .from('pms_payments_daily_current')
        .select('business_date, cash_collected_cents, card_collected_cents, deposits_collected_cents, total_collected_cents')
        .eq('property_id', ctx.propertyId)
        .order('business_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latest) {
        return { ok: true, data: { date: target, note: 'No payments data captured yet for this property.' } };
      }
      return {
        ok: true,
        data: {
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
    'List upcoming on-the-books reservations by arrival date, plus how the on-the-books room count for those nights has built up over time (booking pace). Use for "how booked are we next weekend?", "upcoming arrivals", "is next week pacing ahead?". Defaults to the next 14 days. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'YYYY-MM-DD inclusive; defaults to today.' },
      endDate: { type: 'string', description: 'YYYY-MM-DD inclusive; defaults to 14 days out.' },
    },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  handler: async ({ startDate, endDate }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.propertyId);
    const start = typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : today;
    const end = typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : addDays(start, 14);

    // Individual future stays: pms_reservations, which has carried every one of
    // these columns since 0202 and is the only place a reservation lives now.
    const [resQ, paceQ] = await Promise.all([
      supabaseAdmin
        .from('pms_reservations')
        .select('pms_reservation_id, guest_name, room_number, room_type, arrival_date, departure_date, rate_per_night_cents, total_amount_cents, status, channel_name')
        .eq('property_id', ctx.propertyId)
        .gte('arrival_date', start)
        .lte('arrival_date', end)
        .order('arrival_date', { ascending: true })
        .limit(200),
      // The pace curve: on-the-books rooms for each of those nights, as seen on
      // each day we looked. Best-effort — a hotel with no pace report still gets
      // the reservation list.
      supabaseAdmin
        .from('pms_booking_pace')
        .select('stay_date, as_of_date, rooms_otb, rooms_available, revenue_otb_cents')
        .eq('property_id', ctx.propertyId)
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

// ─── get_recent_no_shows ─────────────────────────────────────────────────────

registerTool<{ nights?: number }>({
  name: 'get_recent_no_shows',
  description:
    'List recent no-show reservations (guests who never checked in). Defaults to the last night. Use for "any no-shows last night?", "recent no-shows". Read-only.',
  inputSchema: {
    type: 'object',
    properties: { nights: { type: 'number', description: 'How many nights back to include (default 1 = last night).' } },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  handler: async ({ nights }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.propertyId);
    const back = Number.isFinite(nights) && (nights as number) > 0 ? Math.floor(nights as number) : 1;
    const cutoff = addDays(today, -back);
    const { data, error } = await supabaseAdmin
      .from('pms_no_shows')
      .select('pms_reservation_id, guest_name, room_number, arrival_date, rate_per_night_cents, total_amount_cents, channel_name, no_show_date')
      .eq('property_id', ctx.propertyId)
      .gte('arrival_date', cutoff)
      .order('arrival_date', { ascending: false })
      .limit(100);
    if (error) return { ok: false, error: 'Could not load no-shows.' };
    const rows = data ?? [];
    return {
      ok: true,
      data: {
        since: cutoff,
        count: rows.length,
        noShows: rows.map((r) => ({
          guest: r.guest_name ?? null,
          room: r.room_number ?? null,
          dueArrival: r.arrival_date ?? null,
          noShowDate: r.no_show_date ?? null,
          value: usd(r.total_amount_cents),
          channel: r.channel_name ?? null,
        })),
        note: rows.length === 0 ? 'No no-shows recorded in this window.' : undefined,
      },
    };
  },
});

// ─── get_recent_cancellations ────────────────────────────────────────────────

registerTool<{ days?: number }>({
  name: 'get_recent_cancellations',
  description:
    'List recently cancelled reservations. Defaults to the last 7 days. Use for "recent cancellations", "what cancelled this week?". Read-only.',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'number', description: 'How many days back to include (default 7).' } },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  handler: async ({ days }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.propertyId);
    const back = Number.isFinite(days) && (days as number) > 0 ? Math.floor(days as number) : 7;
    const cutoff = addDays(today, -back);
    const { data, error } = await supabaseAdmin
      .from('pms_cancellations')
      .select('pms_reservation_id, guest_name, room_number, arrival_date, cancelled_date, cancellation_fee_cents, total_amount_cents, channel_name, reason')
      .eq('property_id', ctx.propertyId)
      .gte('cancelled_date', cutoff)
      .order('cancelled_date', { ascending: false })
      .limit(100);
    if (error) return { ok: false, error: 'Could not load cancellations.' };
    const rows = data ?? [];
    return {
      ok: true,
      data: {
        since: cutoff,
        count: rows.length,
        cancellations: rows.map((r) => ({
          guest: r.guest_name ?? null,
          room: r.room_number ?? null,
          dueArrival: r.arrival_date ?? null,
          cancelledOn: r.cancelled_date ?? null,
          cancellationFee: usd(r.cancellation_fee_cents),
          value: usd(r.total_amount_cents),
          reason: r.reason ?? null,
          channel: r.channel_name ?? null,
        })),
        note: rows.length === 0 ? 'No cancellations recorded in this window.' : undefined,
      },
    };
  },
});
