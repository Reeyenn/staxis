/**
 * POST /api/send-shift-confirmations
 *
 * Called by the Housekeeping → Schedule tab's "Send" button.
 * For each selected housekeeper, sends ONE SMS with their personal link and
 * assigned rooms for tomorrow's shift, and stores a `shift_confirmations` row
 * so /api/sms-reply can route any replies back to the right shift.
 *
 * Maria confirms availability in-person at 3pm, so there is no YES/NO prompt
 * in the SMS itself. The link text is the only thing sent on the first pass.
 * Re-clicking Send later refreshes the same row and re-sends the link with
 * the latest room list (no "update" branch — it's one action, repeatable).
 *
 * YES/NO is still accepted by /api/sms-reply if a HK happens to reply — YES
 * just marks the row 'confirmed' as a nice acknowledgment; NO marks it
 * 'declined' and pings managers so Maria knows someone flaked.
 *
 * Body:
 *   {
 *     pid, shiftDate, baseUrl,                  // required
 *     staff: [
 *       {
 *         staffId, name, phone, language,       // required
 *         assignedRooms?: string[],             // room numbers for this HK
 *         assignedAreas?: string[],             // public areas for this HK
 *       },
 *       ...
 *     ],
 *     allowEmpty?: boolean,                     // bypass the "no work" failsafe
 *     uid?: string,                             // legacy — ignored
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { isValidDateStr, errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  validateUuid, validateString, validateArray, validateDateStr, validateEnum,
  sanitizeForSms, redactPhone, safeBaseUrl, LIMITS,
} from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

interface StaffEntry {
  staffId: string;
  name: string;
  phone: string;
  language: 'en' | 'es';
  assignedRooms?: string[];
  assignedAreas?: string[];
}

interface RequestBody {
  pid: string;
  shiftDate: string;
  baseUrl: string;
  staff: StaffEntry[];
  allowEmpty?: boolean;
  /** Legacy — ignored. */
  uid?: string;
}

type PlanRoom = { number: string; stayType?: string | null };

/**
 * Pull room type from the CSV plan_snapshot so we can seed rooms rows with
 * the correct checkout/stayover flag. Default to 'checkout' when unknown so
 * workload estimates err on the heavier side.
 */
function deriveRoomType(
  number: string,
  planRooms: PlanRoom[] | null,
): 'checkout' | 'stayover' {
  if (!planRooms) return 'checkout';
  const match = planRooms.find(r => r.number === number);
  if (!match) return 'checkout';
  return match.stayType === 'Stay' ? 'stayover' : 'checkout';
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

function formatShiftDate(dateStr: string, lang: 'en' | 'es'): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const dayName = d.toLocaleDateString(locale, { weekday: 'long' });
  const dateFormatted = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${dayName}, ${dateFormatted}`;
}

/** Deterministic token for shift_confirmations. Re-clicking Send upserts the
 *  same row rather than creating duplicates. */
function buildToken(shiftDate: string, staffId: string): string {
  return `${shiftDate}_${staffId}`;
}

export async function POST(req: NextRequest) {
  // Auth: this route fires bulk SMS to every housekeeper on the crew
  // and is the highest-Twilio-cost endpoint we have.
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;

    // Strict validation. Each user-controlled field is checked for type,
    // length, and shape before it touches a query or an SMS body.
    const pidV = validateUuid(b.pid, 'pid');
    if (pidV.error) return NextResponse.json({ error: pidV.error }, { status: 400 });
    const shiftV = validateDateStr(b.shiftDate, {
      label: 'shiftDate', allowFutureDays: LIMITS.SHIFT_DATE_FUTURE_DAYS, allowPastDays: 7,
    });
    if (shiftV.error) return NextResponse.json({ error: shiftV.error }, { status: 400 });
    const staffArrV = validateArray<unknown>(b.staff, { max: LIMITS.STAFF_ARRAY_MAX, min: 1, label: 'staff' });
    if (staffArrV.error) return NextResponse.json({ error: staffArrV.error }, { status: 400 });

    const pid = pidV.value!;
    const shiftDate = shiftV.value!;
    const staff: StaffEntry[] = [];
    for (let i = 0; i < staffArrV.value!.length; i++) {
      const e = staffArrV.value![i] as Record<string, unknown>;
      if (!e || typeof e !== 'object') {
        return NextResponse.json({ error: `staff[${i}] must be an object` }, { status: 400 });
      }
      const idV = validateUuid(e.staffId, `staff[${i}].staffId`);
      if (idV.error) return NextResponse.json({ error: idV.error }, { status: 400 });
      const nameV = validateString(e.name, { max: LIMITS.STAFF_NAME_MAX, label: `staff[${i}].name` });
      if (nameV.error) return NextResponse.json({ error: nameV.error }, { status: 400 });
      const phoneV = typeof e.phone === 'string' ? e.phone : '';
      const langV = validateEnum(e.language ?? 'en', ['en', 'es'] as const, `staff[${i}].language`);
      if (langV.error) return NextResponse.json({ error: langV.error }, { status: 400 });
      const roomsV = validateArray<unknown>(e.assignedRooms ?? [], { max: LIMITS.ASSIGNED_ROOMS_MAX, label: `staff[${i}].assignedRooms` });
      if (roomsV.error) return NextResponse.json({ error: roomsV.error }, { status: 400 });
      const areasV = validateArray<unknown>(e.assignedAreas ?? [], { max: LIMITS.ASSIGNED_AREAS_MAX, label: `staff[${i}].assignedAreas` });
      if (areasV.error) return NextResponse.json({ error: areasV.error }, { status: 400 });
      // Each room/area string must be short.
      for (let j = 0; j < (roomsV.value as unknown[]).length; j++) {
        const r = (roomsV.value as unknown[])[j];
        if (typeof r !== 'string' || r.length > LIMITS.ROOM_NUMBER_MAX) {
          return NextResponse.json({ error: `staff[${i}].assignedRooms[${j}] invalid` }, { status: 400 });
        }
      }
      staff.push({
        staffId: idV.value!,
        name: sanitizeForSms(nameV.value!),
        phone: phoneV,
        language: langV.value as 'en' | 'es',
        assignedRooms: roomsV.value as string[],
        assignedAreas: areasV.value as string[],
      });
    }
    const baseUrl = safeBaseUrl(b.baseUrl);

    if (!(await userHasPropertyAccess(session.userId, pid))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    if (!isValidDateStr(shiftDate)) {  // belt-and-suspenders, never hits
      return NextResponse.json({ error: 'Invalid shiftDate' }, { status: 400 });
    }
    // Hourly Twilio-bill cap. Maria might re-Send 2-3x; 10/hr is plenty.
    const limit = await checkAndIncrementRateLimit('send-shift-confirmations', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    // ── Failsafe: refuse to Send with zero real assignments across the crew.
    // A buggy client that sends an empty staff list would otherwise fire
    // "no assignments" SMS to everyone and wipe rooms. Require `allowEmpty:
    // true` to explicitly opt in.
    const hasAnyWork = staff.some(s =>
      (s.assignedRooms ?? []).length > 0 || (s.assignedAreas ?? []).length > 0,
    );
    const allowEmpty = body.allowEmpty === true;
    if (!hasAnyWork && !allowEmpty) {
      return NextResponse.json({
        error: 'Refusing to Send with no room or area assignments. Assign at least one HK before sending, or pass allowEmpty=true to override.',
      }, { status: 400 });
    }

    // Fetch property + plan_snapshot in parallel — both are needed downstream.
    const [propRes, planRes] = await Promise.all([
      supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle(),
      supabaseAdmin
        .from('plan_snapshots')
        .select('rooms')
        .eq('property_id', pid)
        .eq('date', shiftDate)
        .maybeSingle(),
    ]);

    // Sanitize hotelName for SMS too — it's user-controlled (admins type
    // it on the Property Settings page) and could contain newlines.
    const hotelName = sanitizeForSms(propRes.data?.name || 'Your Hotel');
    const planRooms = (planRes.data?.rooms as PlanRoom[] | null) ?? null;

    // ── Seed rooms rows with assignments so the HK link page finds them.
    //
    // The HK link page queries `rooms where assigned_to = hkId and date = today`.
    // For future dates (tomorrow) the 15-min scraper hasn't written these rows
    // yet, so we seed them here from the CSV. When the scraper runs at 6am on
    // the shift date, it merges new live data in without touching assigned_to,
    // so Maria's assignments survive the refresh.
    //
    // Also CLEARS assignments on any rooms that used to be assigned but aren't
    // in this Send (so unassigning works when Maria re-sends after tweaks).
    {
      const assignmentMap = new Map<string, { staffId: string; staffName: string }>();
      for (const entry of staff) {
        for (const num of (entry.assignedRooms ?? [])) {
          assignmentMap.set(num, { staffId: entry.staffId, staffName: entry.name });
        }
      }

      const { data: existingRooms, error: roomsErr } = await supabaseAdmin
        .from('rooms')
        .select('id, number, assigned_to')
        .eq('property_id', pid)
        .eq('date', shiftDate);
      if (roomsErr) throw roomsErr;

      const existingByNumber = new Map<string, { id: string; number: string; assigned_to: string | null }>();
      for (const r of existingRooms ?? []) {
        if (r.number) existingByNumber.set(r.number as string, r as { id: string; number: string; assigned_to: string | null });
      }

      // Build an upsert batch: every room Maria is assigning, keyed on
      // (property_id, date, number) — the table's unique constraint.
      const upsertRows = Array.from(assignmentMap.entries()).map(([num, who]) => {
        const existing = existingByNumber.get(num);
        if (existing) {
          // Preserve the existing row's id + type + priority + status etc; we
          // only change the assignment fields via a direct update below.
          return null;
        }
        // Fresh seed — no row exists yet for this number on this date.
        return {
          property_id: pid,
          number: num,
          date: shiftDate,
          type: deriveRoomType(num, planRooms),
          status: 'dirty',
          priority: 'standard',
          assigned_to: who.staffId,
          assigned_name: who.staffName,
        };
      }).filter(Boolean) as Array<{
        property_id: string; number: string; date: string;
        type: 'checkout' | 'stayover'; status: 'dirty'; priority: 'standard';
        assigned_to: string; assigned_name: string;
      }>;

      if (upsertRows.length > 0) {
        const { error: insertErr } = await supabaseAdmin
          .from('rooms')
          .upsert(upsertRows, { onConflict: 'property_id,date,number' });
        if (insertErr) throw insertErr;
      }

      // Update existing rooms that have a new assignment (in parallel — Supabase
      // doesn't support bulk update-by-filter-with-different-values in one call).
      // PromiseLike (not Promise) — Supabase query-builder chains are
      // thenables; Promise.all accepts PromiseLike.
      const updates: PromiseLike<unknown>[] = [];
      for (const [num, who] of assignmentMap) {
        const existing = existingByNumber.get(num);
        if (!existing) continue;
        // Skip if no change (saves a write).
        if (existing.assigned_to === who.staffId) continue;
        updates.push(
          supabaseAdmin
            .from('rooms')
            .update({ assigned_to: who.staffId, assigned_name: who.staffName })
            .eq('id', existing.id)
            .then(({ error }) => { if (error) throw error; }),
        );
      }

      // Clear assignments on rooms that used to be assigned but aren't in this Send.
      for (const [num, room] of existingByNumber) {
        if (assignmentMap.has(num)) continue;
        if (!room.assigned_to) continue;
        updates.push(
          supabaseAdmin
            .from('rooms')
            .update({ assigned_to: null, assigned_name: null })
            .eq('id', room.id)
            .then(({ error }) => { if (error) throw error; }),
        );
      }

      if (updates.length > 0) {
        await Promise.all(updates);
      }
    }

    // ── Mirror the assignments into schedule_assignments/{shift_date}.
    // The client already saves this before calling us, but doing it here too
    // is cheap and guarantees the row exists even if the client save raced.
    {
      const roomAssignments: Record<string, string> = {};
      const staffNames: Record<string, string> = {};
      const crew: string[] = [];
      for (const entry of staff) {
        crew.push(entry.staffId);
        staffNames[entry.staffId] = entry.name;
        for (const num of (entry.assignedRooms ?? [])) {
          // Key by the room number only (stable across dates). The old layout
          // keyed by Firestore doc id `${date}_${num}`; we keep that format for
          // back-compat with clients that haven't been updated.
          roomAssignments[`${shiftDate}_${num}`] = entry.staffId;
        }
      }
      const { error: schedErr } = await supabaseAdmin
        .from('schedule_assignments')
        .upsert({
          property_id: pid,
          date: shiftDate,
          room_assignments: roomAssignments,
          crew,
          staff_names: staffNames,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'property_id,date' });
      if (schedErr) throw schedErr;
    }

    // Per-staff outcome. We always include every crew member in the response
    // (even phoneless ones) so the UI can render a status badge next to each
    // name. Room assignments are ALREADY saved above regardless of phone, so
    // phoneless staff keep their rooms.
    type StaffOutcome = {
      staffId: string;
      status: 'sent' | 'skipped' | 'failed';
      reason?: 'no_phone' | 'invalid_phone' | 'sms_error' | string;
      isUpdate?: boolean;
    };

    const perStaff: StaffOutcome[] = await Promise.all(
      staff.map(async ({ staffId, name, phone, language, assignedRooms, assignedAreas }): Promise<StaffOutcome> => {
        try {
          if (!phone || !phone.trim()) {
            return { staffId, status: 'skipped', reason: 'no_phone' };
          }
          const phone164 = toE164(phone);
          if (!phone164) {
            return { staffId, status: 'skipped', reason: 'invalid_phone' };
          }

          // Pre-build these so the linter can see the vars are used even though
          // the SMS link only cares about staffId + pid.
          void assignedRooms;
          void assignedAreas;

          // Include pid in the HK link so the mobile page can fire
          // /api/help-request and /api/report-issue. Without it, the
          // Need Help button silently fails.
          const hkUrl = `${baseUrl}/housekeeper/${staffId}?pid=${encodeURIComponent(pid)}`;

          // One shift_confirmation per (shift_date, staff_id). Deterministic
          // token so re-clicking Send doesn't create duplicates — it
          // refreshes the row.
          const token = buildToken(shiftDate, staffId);

          // Check for an existing confirmation row. If the HK already replied
          // YES ("confirmed"), we preserve that status. Otherwise the row
          // enters/remains in 'sent' state (the normal resting state — Maria
          // confirms availability in person at 3pm). We send the SAME link
          // SMS either way.
          const { data: existing, error: existErr } = await supabaseAdmin
            .from('shift_confirmations')
            .select('token, status')
            .eq('token', token)
            .maybeSingle();
          if (existErr) throw existErr;

          const isUpdate = !!existing;
          const preserveConfirmed = existing?.status === 'confirmed';
          const status = preserveConfirmed ? 'confirmed' : 'sent';
          const nowIso = new Date().toISOString();

          // Upsert the shift_confirmation row. On insert: all fields. On
          // update: all the same fields — last write wins — with sent_at
          // refreshed so the UI can show "resent 2 min ago".
          const { error: upsertErr } = await supabaseAdmin
            .from('shift_confirmations')
            .upsert({
              token,
              property_id: pid,
              staff_id: staffId,
              staff_name: name,
              staff_phone: phone164,
              shift_date: shiftDate,
              status,
              language,
              sent_at: nowIso,
              // Only clear responded_at on a fresh send (not when preserving a
              // 'confirmed' reply).
              ...(preserveConfirmed ? {} : { responded_at: null }),
              sms_sent: false,
              sms_error: null,
            }, { onConflict: 'token' });
          if (upsertErr) throw upsertErr;

          // Keep the staff row's phone_lookup column in sync so /api/sms-reply
          // can resolve an inbound number back to the staff member. Best-effort
          // — don't fail the send if this write fails.
          supabaseAdmin
            .from('staff')
            .update({ phone_lookup: phone164 })
            .eq('id', staffId)
            .then(({ error }) => {
              if (error) console.warn('[send-shift-confirmations] phone_lookup update failed:', error.message);
            });

          // `name` already passed through sanitizeForSms in the input
          // validation above, so no newlines or control chars survived.
          const firstName = name.split(' ')[0] || name;
          const dateLabel = formatShiftDate(shiftDate, language);

          // Minimal SMS: name + date + link + language toggle line + hotel
          // footer. Room assignments live on the HK's personal page (opened
          // via the link), NOT in the text. One template for every send.
          const message = language === 'es'
            ? `Hola ${firstName}! Tu lista para ${dateLabel}:\n${hkUrl}\n\nFor English, reply ENGLISH\n\n– ${hotelName}`
            : `Hi ${firstName}! Your list for ${dateLabel}:\n${hkUrl}\n\nPara español, responde ESPAÑOL\n\n– ${hotelName}`;

          try {
            await sendSms(phone164, message);
            await supabaseAdmin
              .from('shift_confirmations')
              .update({ sms_sent: true, sms_error: null })
              .eq('token', token);
            return { staffId, status: 'sent', isUpdate };
          } catch (smsErr) {
            // Use errToString so Supabase-shaped errors (plain objects) don't
            // stringify to "[object Object]" in the sms_error column.
            await supabaseAdmin
              .from('shift_confirmations')
              .update({ sms_sent: false, sms_error: errToString(smsErr) })
              .eq('token', token);
            throw smsErr;
          }
        } catch (err) {
          // Don't log the raw name — staff names are PII and any trailing
          // bytes in a malformed payload would reach our log aggregator.
          // The staffId is enough to identify the row in DB if needed.
          console.error(`[send-shift-confirmations] failed for staffId=${staffId}: ${errToString(err)}`);
          const reason = err instanceof Error ? err.message : 'sms_error';
          return { staffId, status: 'failed', reason };
        }
      })
    );

    const sent    = perStaff.filter(r => r.status === 'sent').length;
    const skipped = perStaff.filter(r => r.status === 'skipped').length;
    const failed  = perStaff.filter(r => r.status === 'failed').length;
    const updated = perStaff.filter(r => r.status === 'sent' && r.isUpdate === true).length;
    const fresh   = sent - updated;

    return NextResponse.json({ sent, failed, skipped, updated, fresh, perStaff });
  } catch (err) {
    console.error('send-shift-confirmations error:', err);
    // Persist the error so we can diagnose without shell logs.
    try {
      await supabaseAdmin.from('error_logs').insert({
        source: '/api/send-shift-confirmations',
        message: errToString(err),
        stack: err instanceof Error ? err.stack ?? null : null,
      });
    } catch {}
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
