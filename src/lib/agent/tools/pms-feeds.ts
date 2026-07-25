// ─── PMS money / booking feed query tools (feat/pms-universal-translate) ─────
// Read-only access to the 4 new universal PMS feeds (migration 0276):
//   • get_outstanding_balances → pms_guest_balances  ("who owes a balance?")
//   • get_payments_summary     → pms_payments_daily   ("how much did we collect today?")
//   • get_future_bookings      → pms_future_bookings  ("how booked are we next weekend?")
//   • get_recent_no_shows      → pms_no_shows         ("any no-shows last night?")
//   • get_recent_cancellations → pms_cancellations
//
// These pms_* tables are RLS deny-all-browser (migration 0276) — they MUST be
// read with the service-role client and scoped to one hotel. That scoping is
// no longer hand-written: every read goes through `ctx.db` (scoped-db.ts),
// which applies the property filter before the builder is handed back.
// Money is stored as integer cents; surfaced to the model as USD strings +
// raw cents. All read-only (mutates:false).

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
 * A2 — the newest `captured_at` across the rows this tool just read, or null.
 *
 * Every one of these five tables stamps `captured_at NOT NULL DEFAULT now()`
 * on every row (migration 0276; a future-dated value is refused by 0337), so
 * this is a TRUER data age than the property-level signal. executeTool honors
 * an `asOf` the handler already set and computes the age/tier from it.
 */
function latestCapturedAt(rows: Array<Record<string, unknown>>): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const r of rows) {
    const c = r.captured_at;
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
    'List guests with an outstanding folio balance as of the hotel\'s last PMS report (NOT live), highest first. Use for "who owes a balance?", "outstanding balances", "who hasn\'t paid". The result carries asOf — quote it. Read-only.',
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
    'Get money COLLECTED for a day (cash + card + deposits), defaulting to today, as of the hotel\'s last PMS report — so today\'s total is partial and may lag by up to an hour. Use for "how much did we collect today?", "today\'s payments", "cashier totals". Read-only.',
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
      .from('pms_payments_daily')
      .select('business_date, cash_collected_cents, card_collected_cents, deposits_collected_cents, total_collected_cents, captured_at')
      .eq('business_date', target)
      .maybeSingle();
    if (error) return { ok: false, error: 'Could not load payments summary.' };
    if (!data) {
      // Fall back to the most recent day we have, so the model can still answer.
      const { data: latest } = await ctx.db
        .from('pms_payments_daily')
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

registerTool<{ startDate?: string; endDate?: string }>({
  name: 'get_future_bookings',
  description:
    'List upcoming on-the-books reservations by arrival date (booking pace) as of the hotel\'s last PMS report, not live. Use for "how booked are we next weekend?", "upcoming arrivals", "reservations next week". Defaults to the next 14 days. Read-only.',
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
    const { data, error } = await ctx.db
      .from('pms_future_bookings')
      .select('pms_reservation_id, guest_name, room_number, room_type, arrival_date, departure_date, rate_per_night_cents, total_amount_cents, status, channel_name, captured_at')
      .gte('arrival_date', start)
      .lte('arrival_date', end)
      .order('arrival_date', { ascending: true })
      .limit(200);
    if (error) return { ok: false, error: 'Could not load future bookings.' };
    const rows = data ?? [];
    // Arrivals per date so the model can answer "how full is next weekend".
    const byArrivalDate: Record<string, number> = {};
    for (const r of rows) {
      const k = String(r.arrival_date);
      byArrivalDate[k] = (byArrivalDate[k] ?? 0) + 1;
    }
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
        note: rows.length === 0
          ? 'No upcoming bookings in this range. (The PMS reader may not capture a future-reservations report on this property yet.)'
          : undefined,
      },
    };
  },
});

// ─── get_recent_no_shows ─────────────────────────────────────────────────────

registerTool<{ nights?: number }>({
  name: 'get_recent_no_shows',
  description:
    'List recent no-show reservations (guests who never checked in) as of the hotel\'s last PMS report, not live. Defaults to the last night. Use for "any no-shows last night?", "recent no-shows". Read-only.',
  inputSchema: {
    type: 'object',
    properties: { nights: { type: 'number', description: 'How many nights back to include (default 1 = last night).' } },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async ({ nights }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.db);
    const back = Number.isFinite(nights) && (nights as number) > 0 ? Math.floor(nights as number) : 1;
    const cutoff = addDays(today, -back);
    const { data, error } = await ctx.db
      .from('pms_no_shows')
      .select('pms_reservation_id, guest_name, room_number, arrival_date, rate_per_night_cents, total_amount_cents, channel_name, no_show_date, captured_at')
      .gte('arrival_date', cutoff)
      .order('arrival_date', { ascending: false })
      .limit(100);
    if (error) return { ok: false, error: 'Could not load no-shows.' };
    const rows = data ?? [];
    return {
      ok: true,
      data: {
        asOf: latestCapturedAt(rows),
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
    'List recently cancelled reservations as of the hotel\'s last PMS report, not live. Defaults to the last 7 days. Use for "recent cancellations", "what cancelled this week?". Read-only.',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'number', description: 'How many days back to include (default 7).' } },
  },
  allowedRoles: FEED_ROLES,
  mutates: false,
  pmsFreshness: 'stamped',
  handler: async ({ days }, ctx): Promise<ToolResult> => {
    const today = await getPropertyToday(ctx.db);
    const back = Number.isFinite(days) && (days as number) > 0 ? Math.floor(days as number) : 7;
    const cutoff = addDays(today, -back);
    const { data, error } = await ctx.db
      .from('pms_cancellations')
      .select('pms_reservation_id, guest_name, room_number, arrival_date, cancelled_date, cancellation_fee_cents, total_amount_cents, channel_name, reason, captured_at')
      .gte('cancelled_date', cutoff)
      .order('cancelled_date', { ascending: false })
      .limit(100);
    if (error) return { ok: false, error: 'Could not load cancellations.' };
    const rows = data ?? [];
    return {
      ok: true,
      data: {
        asOf: latestCapturedAt(rows),
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
