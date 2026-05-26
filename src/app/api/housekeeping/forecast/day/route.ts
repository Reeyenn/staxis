/**
 * GET /api/housekeeping/forecast/day?propertyId=…&date=YYYY-MM-DD
 *
 * Per-day drill-down for the Forecast view. Returns the hour-by-hour
 * arrival/departure workload curve, the reservation list driving that
 * day, and the housekeepers scheduled to work it.
 *
 * Why a second endpoint vs cramming this into the main forecast route:
 *   - 14 days × ~50 reservations × ~10 fields = ~7000 columns in a
 *     payload only one of which is ever inspected at a time. Lazy-
 *     fetching keeps the parent forecast snappy.
 *   - The drilldown can be cached / rate-limited independently of the
 *     parent range view.
 *
 * Same auth posture as /api/housekeeping/forecast: requireSession +
 * userHasPropertyAccess + manager-tier role gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { canViewForecast } from '@/lib/forecast';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hours covered by the drill-down workload curve. 5am–10pm matches a
// typical limited-service hotel's housekeeping shift bookend plus the
// late-arrival tail; outside this window the buckets would always be
// zero and clutter the chart.
const HOUR_START = 5;
const HOUR_END = 22;

interface ReservationDetailRow {
  pms_reservation_id: string;
  guest_name: string | null;
  room_number: string | null;
  room_type: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  status: string | null;
  notes: string | null;
}

interface StaffDayRow {
  staff_id: string | null;
  start_time: string;
  end_time: string;
  status: string;
}

interface StaffNameRow {
  id: string;
  name: string;
  language: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const pidRaw = url.searchParams.get('propertyId');
    const dateRaw = url.searchParams.get('date');

    const pidCheck = validateUuid(pidRaw, 'propertyId');
    if (pidCheck.error) {
      return err(pidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const dateCheck = validateDateStr(dateRaw, { label: 'date' });
    if (dateCheck.error) {
      return err(dateCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const propertyId = pidCheck.value!;
    const date = dateCheck.value!;

    const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
    if (!hasAccess) {
      log.warn('forecast/day: forbidden — user lacks property access', {
        requestId, userId: auth.userId, propertyId,
      });
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const { data: accountRow, error: accountErr } = await supabaseAdmin
      .from('accounts')
      .select('role')
      .eq('data_user_id', auth.userId)
      .maybeSingle();
    if (accountErr) {
      log.error('forecast/day: accounts lookup failed', {
        requestId, msg: accountErr.message,
      });
      return err('account lookup failed', {
        requestId, status: 500, code: ApiErrorCode.UpstreamFailure,
      });
    }
    const role = (accountRow?.role as string | undefined) ?? '';
    if (!canViewForecast(role)) {
      return err('forbidden — role does not have forecast access', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Share the same rate-limit bucket as the parent forecast — a
    // drill-down still counts as forecast traffic from the same user
    // on the same property.
    const rateKey = hashToRateLimitKey(`${auth.userId}:${propertyId}`);
    const rate = await checkAndIncrementRateLimit('housekeeping-forecast', rateKey);
    if (!rate.allowed) {
      return rateLimitedResponse(rate.current, rate.cap, rate.retryAfterSec);
    }

    // ── Reads ────────────────────────────────────────────────────────
    const [resvRes, shiftsRes, staffRes] = await Promise.all([
      // Reservations that touch this date in any way: arrive, depart,
      // or are in-house (arrival < date < departure).
      supabaseAdmin
        .from('pms_reservations')
        .select(
          'pms_reservation_id, guest_name, room_number, room_type, ' +
          'arrival_date, arrival_time, departure_date, departure_time, ' +
          'status, notes',
        )
        .eq('property_id', propertyId)
        .or(
          `arrival_date.eq.${date},departure_date.eq.${date},` +
          `and(arrival_date.lte.${date},departure_date.gte.${date})`,
        )
        .returns<ReservationDetailRow[]>(),

      // Scheduled shifts (housekeeping) for this date.
      supabaseAdmin
        .from('scheduled_shifts')
        .select('staff_id, start_time, end_time, status')
        .eq('property_id', propertyId)
        .eq('department', 'housekeeping')
        .eq('shift_date', date)
        .neq('status', 'declined')
        .returns<StaffDayRow[]>(),

      // Staff names + languages for the housekeepers panel.
      supabaseAdmin
        .from('staff')
        .select('id, name, language')
        .eq('property_id', propertyId)
        .eq('department', 'housekeeping')
        .eq('is_active', true)
        .returns<StaffNameRow[]>(),
    ]);

    const reservations: ReservationDetailRow[] = resvRes.error
      ? (log.warn('forecast/day: reservations load failed', {
          requestId, msg: resvRes.error.message,
        }), [])
      : (resvRes.data ?? []);

    const shifts: StaffDayRow[] = shiftsRes.error
      ? (log.warn('forecast/day: scheduled_shifts load failed', {
          requestId, msg: shiftsRes.error.message,
        }), [])
      : (shiftsRes.data ?? []);

    const staff: StaffNameRow[] = staffRes.error
      ? (log.warn('forecast/day: staff load failed', {
          requestId, msg: staffRes.error.message,
        }), [])
      : (staffRes.data ?? []);

    // ── Hour buckets ─────────────────────────────────────────────────
    // arrivals/departures per hour-of-day. Each bucket carries a
    // synthetic-default counter so the UI can honestly disclose how
    // much of a spike is from rows without recorded times. Codex
    // audit Major #2 — without this counter, missing-time rows piled
    // into the 15:00 / 11:00 defaults and looked like real spikes.
    const arrivalsByHour = new Map<number, number>();
    const departuresByHour = new Map<number, number>();
    const unknownArrivalsByHour = new Map<number, number>();
    const unknownDeparturesByHour = new Map<number, number>();
    for (let h = HOUR_START; h <= HOUR_END; h += 1) {
      arrivalsByHour.set(h, 0);
      departuresByHour.set(h, 0);
      unknownArrivalsByHour.set(h, 0);
      unknownDeparturesByHour.set(h, 0);
    }
    let unknownArrivalsTotal = 0;
    let unknownDeparturesTotal = 0;
    for (const r of reservations) {
      if (r.status === 'cancelled' || r.status === 'no_show') continue;
      if (r.arrival_date === date) {
        const parsed = parseHourSafe(r.arrival_time);
        const h = parsed.hour ?? 15; // 3pm typical check-in default
        if (h >= HOUR_START && h <= HOUR_END) {
          arrivalsByHour.set(h, (arrivalsByHour.get(h) ?? 0) + 1);
          if (parsed.hour === null) {
            unknownArrivalsByHour.set(h, (unknownArrivalsByHour.get(h) ?? 0) + 1);
            unknownArrivalsTotal += 1;
          }
        }
      }
      if (r.departure_date === date) {
        const parsed = parseHourSafe(r.departure_time);
        const h = parsed.hour ?? 11; // 11am typical check-out cut-off
        if (h >= HOUR_START && h <= HOUR_END) {
          departuresByHour.set(h, (departuresByHour.get(h) ?? 0) + 1);
          if (parsed.hour === null) {
            unknownDeparturesByHour.set(h, (unknownDeparturesByHour.get(h) ?? 0) + 1);
            unknownDeparturesTotal += 1;
          }
        }
      }
    }
    const hourly: Array<{
      hour: number;
      arrivals: number;
      departures: number;
      unknown_arrivals: number;
      unknown_departures: number;
    }> = [];
    for (let h = HOUR_START; h <= HOUR_END; h += 1) {
      hourly.push({
        hour: h,
        arrivals: arrivalsByHour.get(h) ?? 0,
        departures: departuresByHour.get(h) ?? 0,
        unknown_arrivals: unknownArrivalsByHour.get(h) ?? 0,
        unknown_departures: unknownDeparturesByHour.get(h) ?? 0,
      });
    }

    // ── Reservations list ────────────────────────────────────────────
    // Surface only reservations that're meaningfully relevant to this
    // day: arriving, departing, or in-house mid-stay. Sort: arrivals
    // first (in time order), then departures, then in-house for context.
    const decorated = reservations
      .filter(r => r.status !== 'cancelled' && r.status !== 'no_show')
      .map(r => {
        let kind: 'arrival' | 'departure' | 'in_house';
        if (r.arrival_date === date) kind = 'arrival';
        else if (r.departure_date === date) kind = 'departure';
        else kind = 'in_house';
        return {
          kind,
          pms_reservation_id: r.pms_reservation_id,
          guest_name: r.guest_name,
          room_number: r.room_number,
          room_type: r.room_type,
          arrival_date: r.arrival_date,
          arrival_time: r.arrival_time,
          departure_date: r.departure_date,
          departure_time: r.departure_time,
          notes: r.notes,
        };
      })
      .sort((a, b) => {
        const ord = { arrival: 0, departure: 1, in_house: 2 } as const;
        if (ord[a.kind] !== ord[b.kind]) return ord[a.kind] - ord[b.kind];
        const t = (a.arrival_time ?? a.departure_time ?? '')
          .localeCompare(b.arrival_time ?? b.departure_time ?? '');
        return t;
      });

    // ── Housekeepers panel ──────────────────────────────────────────
    const staffById = new Map(staff.map(s => [s.id, s]));
    const seen = new Set<string>();
    const housekeepers: Array<{
      id: string;
      name: string;
      language: string | null;
      start_time: string;
      end_time: string;
    }> = [];
    for (const s of shifts) {
      if (!s.staff_id || seen.has(s.staff_id)) continue;
      seen.add(s.staff_id);
      const person = staffById.get(s.staff_id);
      if (!person) continue;
      housekeepers.push({
        id: person.id,
        name: person.name,
        language: person.language,
        start_time: s.start_time,
        end_time: s.end_time,
      });
    }

    return ok(
      {
        date,
        hourly,
        unknown_time_totals: {
          arrivals: unknownArrivalsTotal,
          departures: unknownDeparturesTotal,
        },
        reservations: decorated,
        housekeepers,
      },
      { requestId },
    );
  } catch (e) {
    log.error('forecast/day: unexpected error', {
      requestId, err: e instanceof Error ? e : new Error(String(e)),
    });
    return err('drilldown failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

/**
 * Pull the hour-of-day out of a "HH:MM:SS" or "HH:MM" string.
 * Returns `{ hour: null }` when parsing fails or the string is missing,
 * so callers can distinguish "real recorded time" from "we filled in
 * the typical default." Codex audit Major #2.
 */
function parseHourSafe(time: string | null): { hour: number | null } {
  if (!time) return { hour: null };
  const m = /^(\d{1,2}):/.exec(time);
  if (!m) return { hour: null };
  const h = parseInt(m[1], 10);
  if (!Number.isFinite(h) || h < 0 || h > 23) return { hour: null };
  return { hour: h };
}
