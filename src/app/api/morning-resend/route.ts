/**
 * POST /api/morning-resend
 *
 * Runs before the shift starts (e.g. 6am). For each confirmed HK:
 *   1. Re-checks current room counts from the `rooms` table (scraper may have
 *      updated them overnight).
 *   2. Re-runs smart room assignment with the confirmed headcount.
 *   3. If the room list changed for any HK, sends an updated text and updates
 *      the HK's room assignments (mirrored to `rooms.assigned_to` and to the
 *      roomAssignments map in `schedule_assignments`).
 *
 * Call this from the scheduler (6am trigger) or manually via the scheduling
 * page.
 *
 * Body: { pid, shiftDate, baseUrl, uid?: string }   (uid ignored — legacy)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { isValidDateStr, errToString } from '@/lib/utils';
import { validateUuid, validateDateStr, redactPhone, safeBaseUrl, LIMITS } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';

// ─── Helpers ────────────────────────────────────────────────────────────────

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

interface RoomRow {
  id: string;
  number: string;
  type: 'checkout' | 'stayover' | 'vacant';
  assigned_to: string | null;
}

interface HKSlot {
  index: number;
  rooms: string[];
  totalMinutes: number;
}

const CLEANING_TIMES = { checkout: 30, stayover: 20 };

/**
 * Re-runs smart room assignment: groups by floor, distributes floor groups
 * to the HK with the least work. Checkouts before stayovers per floor.
 */
function smartAssignRooms(rooms: RoomRow[], numHousekeepers: number): HKSlot[] {
  if (numHousekeepers <= 0 || rooms.length === 0) return [];

  const byFloor: Record<string, RoomRow[]> = {};
  for (const room of rooms) {
    const floor = String(room.number).charAt(0);
    if (!byFloor[floor]) byFloor[floor] = [];
    byFloor[floor].push(room);
  }

  for (const floor of Object.keys(byFloor)) {
    byFloor[floor].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
      return parseInt(a.number) - parseInt(b.number);
    });
  }

  const slots: HKSlot[] = Array.from({ length: numHousekeepers }, (_, i) => ({
    index: i, rooms: [], totalMinutes: 0,
  }));

  for (const floorRooms of Object.values(byFloor)) {
    const lightest = slots.reduce((min, s) => s.totalMinutes < min.totalMinutes ? s : min, slots[0]);
    for (const room of floorRooms) {
      lightest.rooms.push(room.number);
      lightest.totalMinutes += CLEANING_TIMES[room.type as 'checkout' | 'stayover'] ?? 25;
    }
  }

  return slots;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── Auth: CRON_SECRET required ────────────────────────────────────────
    // This route fires bulk SMS to every confirmed housekeeper. Without
    // auth, anyone could POST a `pid` and trigger the full re-send loop,
    // burning Twilio credits and spamming staff. Protect with the same
    // CRON_SECRET we already use for /api/cron/* routes — set it in
    // Vercel + the GitHub Actions secret + any cron service that calls
    // this URL. Now timing-safe via the shared helper.
    const unauth = requireCronSecret(req);
    if (unauth) return unauth;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;
    const pidV = validateUuid(b.pid, 'pid');
    if (pidV.error) return NextResponse.json({ error: pidV.error }, { status: 400 });
    const shiftV = validateDateStr(b.shiftDate, {
      label: 'shiftDate', allowFutureDays: LIMITS.SHIFT_DATE_FUTURE_DAYS, allowPastDays: 7,
    });
    if (shiftV.error) return NextResponse.json({ error: shiftV.error }, { status: 400 });
    const pid = pidV.value!;
    const shiftDate = shiftV.value!;
    const baseUrl = safeBaseUrl(b.baseUrl);

    // Idempotency check BEFORE rate limit. A retry of the same logical
    // request (same Idempotency-Key) returns the cached response without
    // burning rate-limit budget. Without this, a cron retry from a
    // network blip would double-charge against the 5/hr cap and possibly
    // double-text staff if the cache was missing for any reason.
    const idem = await checkIdempotency(req, 'morning-resend');
    if (idem.kind === 'cached') return idem.response;

    // Cap at 5 morning-resends per property per hour. The cron schedule
    // calls this once per morning; manual re-runs should be rare.
    const limit = await checkAndIncrementRateLimit('morning-resend', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    if (!isValidDateStr(shiftDate)) {
      return NextResponse.json({ error: 'Invalid shiftDate format (expected YYYY-MM-DD)' }, { status: 400 });
    }

    // Fetch hotel name from properties table
    const { data: prop } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', pid)
      .maybeSingle();
    const hotelName = prop?.name || 'Your Hotel';

    // ── 1. Load confirmed HKs for this shift date ────────────────────────────
    const { data: confirmed, error: confErr } = await supabaseAdmin
      .from('shift_confirmations')
      .select('token, staff_id, staff_name, staff_phone, language')
      .eq('property_id', pid)
      .eq('shift_date', shiftDate)
      .eq('status', 'confirmed');

    if (confErr) throw confErr;

    if (!confirmed || confirmed.length === 0) {
      return NextResponse.json({ message: 'No confirmed HKs for this date', updated: 0 });
    }

    // ── 2. Re-fetch rooms from Supabase ──────────────────────────────────────
    // shiftDate is tomorrow from the HK's perspective, but the scraper writes
    // rooms for "today" (the day the data is current). We read shiftDate's
    // rows first; if empty, fall back to yesterday as a proxy.
    const { data: roomsForShift, error: roomsErr } = await supabaseAdmin
      .from('rooms')
      .select('id, number, type, assigned_to')
      .eq('property_id', pid)
      .eq('date', shiftDate);
    if (roomsErr) throw roomsErr;

    let roomRows = (roomsForShift ?? []) as RoomRow[];
    if (roomRows.length === 0) {
      const [y, m, d] = shiftDate.split('-').map(Number);
      const prev = new Date(y, m - 1, d - 1);
      const prevISO = prev.toLocaleDateString('en-CA');
      const { data: prevRooms } = await supabaseAdmin
        .from('rooms')
        .select('id, number, type, assigned_to')
        .eq('property_id', pid)
        .eq('date', prevISO);
      roomRows = (prevRooms ?? []) as RoomRow[];
    }

    const cleanableRooms = roomRows.filter(r => r.type === 'checkout' || r.type === 'stayover');

    // ── 3. Re-run smart assignment with confirmed headcount ──────────────────
    const numHKs = confirmed.length;
    const newAssignments = smartAssignRooms(cleanableRooms, numHKs);

    // Index the existing rooms-for-shift set by number so we can translate
    // "room number" → "row id" to push the new assigned_to down to the table.
    const { data: shiftDateRooms } = await supabaseAdmin
      .from('rooms')
      .select('id, number, assigned_to')
      .eq('property_id', pid)
      .eq('date', shiftDate);
    const roomIdByNumber = new Map<string, { id: string; assigned_to: string | null }>();
    for (const r of (shiftDateRooms ?? [])) {
      if (r.number) roomIdByNumber.set(r.number as string, { id: r.id as string, assigned_to: (r.assigned_to as string | null) ?? null });
    }

    // ── 4. For each confirmed HK, check if rooms changed, send update if so ─
    let updatedCount = 0;
    const nowIso = new Date().toISOString();

    const results = await Promise.allSettled(
      confirmed.map(async (hk, idx) => {
        const newRooms = newAssignments[idx]?.rooms ?? [];

        // Find the current "assigned to this staff on this date" set so we
        // can compute the delta. Reading from the rooms table (source of
        // truth) rather than the stale confirmation snapshot.
        const oldRooms = roomRows
          .filter(r => r.assigned_to === hk.staff_id)
          .map(r => r.number)
          .sort();

        const nrSorted = [...newRooms].sort();
        const changed =
          nrSorted.length !== oldRooms.length ||
          nrSorted.some((r, i) => r !== oldRooms[i]);

        if (!changed) return;

        // Push the new assignments down to the rooms table. For each room
        // assigned to this HK, set assigned_to = staff_id. For each room
        // that WAS theirs but isn't anymore, set assigned_to = null (the
        // room might get picked up by a different HK below — that's fine,
        // subsequent updates will override).
        const toAssign = new Set(newRooms);
        // PromiseLike (not Promise) — Supabase query-builder chains are
        // thenables; Promise.all accepts PromiseLike.
        const assignOps: PromiseLike<unknown>[] = [];

        for (const num of newRooms) {
          const row = roomIdByNumber.get(num);
          if (!row) continue; // number exists in the "cleanable" set but not in today's rooms — skip
          if (row.assigned_to === hk.staff_id) continue;
          assignOps.push(
            supabaseAdmin
              .from('rooms')
              .update({ assigned_to: hk.staff_id, assigned_name: hk.staff_name })
              .eq('id', row.id)
              .then(({ error }) => { if (error) throw error; }),
          );
        }
        for (const num of oldRooms) {
          if (toAssign.has(num)) continue;
          const row = roomIdByNumber.get(num);
          if (!row) continue;
          assignOps.push(
            supabaseAdmin
              .from('rooms')
              .update({ assigned_to: null, assigned_name: null })
              .eq('id', row.id)
              .then(({ error }) => { if (error) throw error; }),
          );
        }
        if (assignOps.length > 0) await Promise.all(assignOps);

        // Send update SMS (best effort — the write above is what matters).
        const phone164  = toE164(hk.staff_phone as string);
        const firstName = (hk.staff_name as string).split(' ')[0];
        const lang      = (hk.language as 'en' | 'es') ?? 'en';
        const hkUrl     = `${baseUrl}/housekeeper/${hk.staff_id}?pid=${encodeURIComponent(pid)}`;

        if (phone164) {
          let msg: string;
          if (lang === 'es') {
            msg  = `📋 Actualización de turno, ${firstName}. Lista revisada:`;
            if (newRooms.length > 0) msg += `\nHabitaciones: ${newRooms.join(', ')}`;
            msg += `\nTu enlace: ${hkUrl}\n– ${hotelName}`;
          } else {
            msg  = `📋 Shift update, ${firstName}. Revised list:`;
            if (newRooms.length > 0) msg += `\nRooms: ${newRooms.join(', ')}`;
            msg += `\nYour link: ${hkUrl}\n– ${hotelName}`;
          }

          try {
            await sendSms(phone164, msg);
          } catch (err) {
            console.error(`Morning resend SMS failed for ${hk.staff_name}:`, errToString(err));
          }
        }
        updatedCount++;
      })
    );

    // Log any per-HK failures but don't fail the whole request.
    for (const r of results) {
      if (r.status === 'rejected') console.error('[morning-resend] HK rejection:', r.reason);
    }

    // Mirror the new assignments into schedule_assignments so the UI stays in
    // sync without a refresh.
    try {
      const roomAssignments: Record<string, string> = {};
      const staffNames: Record<string, string> = {};
      const crew: string[] = [];
      for (let i = 0; i < confirmed.length; i++) {
        const hk = confirmed[i];
        crew.push(hk.staff_id as string);
        staffNames[hk.staff_id as string] = hk.staff_name as string;
        const rooms = newAssignments[i]?.rooms ?? [];
        for (const num of rooms) {
          roomAssignments[`${shiftDate}_${num}`] = hk.staff_id as string;
        }
      }
      await supabaseAdmin
        .from('schedule_assignments')
        .upsert({
          property_id: pid,
          date: shiftDate,
          room_assignments: roomAssignments,
          crew,
          staff_names: staffNames,
          updated_at: nowIso,
        }, { onConflict: 'property_id,date' });
    } catch (e) {
      console.error('[morning-resend] schedule_assignments mirror failed:', errToString(e));
    }

    const responseBody = {
      message: `Morning resend complete. ${updatedCount} of ${numHKs} HKs received updated room lists.`,
      updated: updatedCount,
      total: numHKs,
    };

    if (idem.kind === 'first') {
      await recordIdempotency(idem.key, 'morning-resend', responseBody, 200, pid);
    }
    return NextResponse.json(responseBody);

  } catch (err) {
    // Generic 500 — `errToString(err)` may include PG schema names or
    // Supabase-internal error text. Caller is CRON_SECRET-gated, so
    // this is defense in depth, but we keep the full detail server-side.
    const msg = errToString(err);
    console.error('morning-resend error:', msg);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
