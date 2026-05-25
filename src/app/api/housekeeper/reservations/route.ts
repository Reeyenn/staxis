/**
 * GET /api/housekeeper/reservations?pid=...&staffId=...&date=YYYY-MM-DD
 *
 * Returns reservation context indexed by room_number for the date in
 * question. Used by the housekeeper page to render guest name + ETA +
 * special requests on each room card.
 *
 * We only return reservations for rooms ACTUALLY ASSIGNED to this
 * staff member on the date — so even if a leaked link is replayed,
 * the response is scoped to one housekeeper's queue. PII (full guest
 * name, special requests) is surfaced to the housekeeper because
 * they need it to do their job, same trust model as the existing
 * SMS-link surface.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const date = searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('invalid date (YYYY-MM-DD)', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  // Reuse the rooms-read bucket — this is effectively the same surface.
  const rl = await checkAndIncrementRateLimit(
    'housekeeper-rooms',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const { data: staff } = await supabaseAdmin
      .from('staff')
      .select('id, property_id')
      .eq('id', staffId)
      .maybeSingle();
    if (!staff || staff.property_id !== pid) {
      return err('Not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound, headers,
      });
    }

    // Step 1: pull the room numbers assigned to this housekeeper today.
    type AssignedRoom = { number: string | null };
    const { data: rooms, error: roomsErr } = await supabaseAdmin
      .from('rooms')
      .select('number')
      .eq('property_id', pid)
      .eq('assigned_to', staffId)
      .eq('date', date);
    if (roomsErr) throw roomsErr;
    const roomNumbers = ((rooms ?? []) as AssignedRoom[])
      .map((r) => r.number)
      .filter((n): n is string => !!n);
    if (roomNumbers.length === 0) {
      return ok({ reservations: {} }, { requestId, headers });
    }

    // Step 2: pull active (booked/checked_in) reservations covering today.
    type ResRow = {
      room_number: string | null;
      guest_name: string | null;
      arrival_date: string | null;
      arrival_time: string | null;
      departure_date: string | null;
      num_nights: number | null;
      special_requests: string | null;
      package_name: string | null;
      notes: string | null;
    };
    const { data: resvs, error: resvErr } = await supabaseAdmin
      .from('pms_reservations')
      .select(
        'room_number, guest_name, arrival_date, arrival_time, departure_date, num_nights, special_requests, package_name, notes',
      )
      .eq('property_id', pid)
      .in('room_number', roomNumbers)
      .lte('arrival_date', date)
      .gte('departure_date', date);
    if (resvErr) throw resvErr;

    // Index by room_number. If the PMS has multiple overlapping reservations
    // for one room (rare — a double-book), pick the earliest arrival to keep
    // the response stable across polls.
    const byRoom: Record<
      string,
      {
        roomNumber: string;
        guestName?: string;
        arrivalDate?: string;
        arrivalTime?: string;
        numNights?: number;
        isVip?: boolean;
        specialRequests?: string;
      }
    > = {};
    for (const r of (resvs ?? []) as ResRow[]) {
      if (!r.room_number) continue;
      const existing = byRoom[r.room_number];
      if (existing && existing.arrivalDate && r.arrival_date && existing.arrivalDate <= r.arrival_date) {
        continue;
      }
      const sr = r.special_requests ?? '';
      const pkg = r.package_name ?? '';
      const isVip = /vip|platinum|diamond|elite/i.test(sr + ' ' + pkg);
      byRoom[r.room_number] = {
        roomNumber: r.room_number,
        guestName: r.guest_name ?? undefined,
        arrivalDate: r.arrival_date ?? undefined,
        arrivalTime: r.arrival_time ?? undefined,
        numNights: r.num_nights ?? undefined,
        isVip,
        specialRequests: sr || undefined,
      };
    }

    return ok({ reservations: byRoom }, { requestId, headers });
  } catch (caughtErr) {
    log.error('housekeeper/reservations: failed', {
      requestId,
      err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}
