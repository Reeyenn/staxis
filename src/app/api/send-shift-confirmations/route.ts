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
import { NextRequest, NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isValidDateStr, errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';
import {
  validateUuid, validateString, validateArray, validateDateStr, validateEnum,
  sanitizeForSms, redactPhone, safeBaseUrl, LIMITS,
} from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { enqueueSms, processSmsJobs } from '@/lib/sms-jobs';
import { buildHousekeeperLink } from '@/lib/staff-auth';
import { buildOkBody, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

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
  const requestId = getOrMintRequestId(req);
  // Auth: this route fires bulk SMS to every housekeeper on the crew
  // and is the highest-Twilio-cost endpoint we have.
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  // Idempotency: Stripe-style header dedup. Mario's UI generates a UUID
  // per click and sends it as Idempotency-Key. If the network drops or
  // he double-clicks, the second call hits the cache and returns the
  // first call's response — no duplicate SMS to housekeepers.
  // Legacy callers (no header) bypass; we still send.
  const idem = await checkIdempotency(req, 'send-shift-confirmations');
  if (idem.kind === 'cached') {
    return idem.response;
  }
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const b = body as Record<string, unknown>;

    // Strict validation. Each user-controlled field is checked for type,
    // length, and shape before it touches a query or an SMS body.
    const pidV = validateUuid(b.pid, 'pid');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const shiftV = validateDateStr(b.shiftDate, {
      label: 'shiftDate', allowFutureDays: LIMITS.SHIFT_DATE_FUTURE_DAYS, allowPastDays: 7,
    });
    if (shiftV.error) return err(shiftV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const staffArrV = validateArray<unknown>(b.staff, { max: LIMITS.STAFF_ARRAY_MAX, min: 1, label: 'staff' });
    if (staffArrV.error) return err(staffArrV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    const pid = pidV.value!;
    const shiftDate = shiftV.value!;
    const staff: StaffEntry[] = [];
    for (let i = 0; i < staffArrV.value!.length; i++) {
      const e = staffArrV.value![i] as Record<string, unknown>;
      if (!e || typeof e !== 'object') {
        return err(`staff[${i}] must be an object`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const idV = validateUuid(e.staffId, `staff[${i}].staffId`);
      if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const nameV = validateString(e.name, { max: LIMITS.STAFF_NAME_MAX, label: `staff[${i}].name` });
      if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const phoneV = typeof e.phone === 'string' ? e.phone : '';
      const langV = validateEnum(e.language ?? 'en', ['en', 'es'] as const, `staff[${i}].language`);
      if (langV.error) return err(langV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const roomsV = validateArray<unknown>(e.assignedRooms ?? [], { max: LIMITS.ASSIGNED_ROOMS_MAX, label: `staff[${i}].assignedRooms` });
      if (roomsV.error) return err(roomsV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const areasV = validateArray<unknown>(e.assignedAreas ?? [], { max: LIMITS.ASSIGNED_AREAS_MAX, label: `staff[${i}].assignedAreas` });
      if (areasV.error) return err(areasV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      // Each room/area string must be short.
      for (let j = 0; j < (roomsV.value as unknown[]).length; j++) {
        const r = (roomsV.value as unknown[])[j];
        if (typeof r !== 'string' || r.length > LIMITS.ROOM_NUMBER_MAX) {
          return err(`staff[${i}].assignedRooms[${j}] invalid`, {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
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
      return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }
    if (!isValidDateStr(shiftDate)) {  // belt-and-suspenders, never hits
      return err('Invalid shiftDate', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
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
      return err(
        'Refusing to Send with no room or area assignments. Assign at least one HK before sending, or pass allowEmpty=true to override.',
        { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
      );
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

          // Magic-link URL via the shared helper. This is BYTE-IDENTICAL to
          // what the Schedule tab's Link/Copy button mints — same staff-auth
          // user, same hashed_token format, same path. The token in the URL
          // lets the housekeeper page auto-sign-in on mount, after which
          // realtime postgres_changes flow over the supabase channel and the
          // HK sees Start/Done taps reflect instantly (no 4s polling delay).
          //
          // If buildHousekeeperLink throws, we fall back to the legacy
          // tokenless URL so the SMS still goes out — degraded UX (polling,
          // no realtime) is strictly better than no SMS at all.
          let hkUrl: string;
          try {
            hkUrl = await buildHousekeeperLink(staffId, pid, baseUrl);
          } catch (linkErr) {
            console.error('[send-shift-confirmations] magic-link mint failed, falling back to tokenless URL:', errToString(linkErr));
            hkUrl = `${baseUrl}/housekeeper/${staffId}?pid=${encodeURIComponent(pid)}`;
          }

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
          //
          // sms_sent stays false here — the queue worker flips it to true
          // when Twilio actually accepts the message (see
          // applyMetadataCallback in src/lib/sms-jobs.ts). On terminal
          // failure (max retries exhausted, or terminal Twilio code like
          // invalid phone), the worker sets sms_sent=false + sms_error
          // with the failure reason.
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

          // Enqueue rather than sending synchronously. Producer-side
          // benefits: (a) the route returns immediately even for big
          // crews; (b) Twilio failures retry per-staff instead of bailing
          // the whole batch; (c) Mario can resend ONLY the failed ones
          // later via a UI that reads sms_jobs status.
          //
          // Idempotency key: include both the deterministic token AND the
          // request's Idempotency-Key. Re-clicking Send refreshes the
          // shift_confirmations row but ALSO mints a fresh sms_jobs row
          // (different idem.key), so the new SMS goes out. The
          // shift_confirmations.sms_sent state is what the UI shows; the
          // sms_jobs row is just the delivery vehicle.
          const idemKeyPart = idem.kind === 'first' ? idem.key : `auto-${nowIso}`;
          try {
            await enqueueSms({
              propertyId: pid,
              toPhone: phone164,
              body: message,
              idempotencyKey: `shift-conf:${token}:${idemKeyPart}`,
              metadata: {
                kind: 'shift-confirmation',
                shiftConfirmationToken: token,
                staffId,
              },
            });
            // Status is 'sent' from Mario's perspective — the message has
            // been committed to the durable queue and will be delivered.
            // The shift_confirmations.sms_sent flag flips true only after
            // Twilio confirms (see worker's applyMetadataCallback).
            return { staffId, status: 'sent', isUpdate };
          } catch (enqueueErr) {
            // The producer enqueue itself failed (DB unreachable, schema
            // mismatch, etc). Mark the shift_confirmation as errored so
            // Mario sees red and can retry — the queue worker isn't going
            // to pick anything up because nothing landed in sms_jobs.
            await supabaseAdmin
              .from('shift_confirmations')
              .update({ sms_sent: false, sms_error: errToString(enqueueErr) })
              .eq('token', token);
            throw enqueueErr;
          }
        } catch (innerErr) {
          // Don't log the raw name — staff names are PII and any trailing
          // bytes in a malformed payload would reach our log aggregator.
          // The staffId is enough to identify the row in DB if needed.
          console.error(`[send-shift-confirmations] failed for staffId=${staffId}: ${errToString(innerErr)}`);
          const reason = innerErr instanceof Error ? innerErr.message : 'sms_error';
          return { staffId, status: 'failed', reason };
        }
      })
    );

    const sent    = perStaff.filter(r => r.status === 'sent').length;
    const skipped = perStaff.filter(r => r.status === 'skipped').length;
    const failed  = perStaff.filter(r => r.status === 'failed').length;
    const updated = perStaff.filter(r => r.status === 'sent' && r.isUpdate === true).length;
    const fresh   = sent - updated;

    // Build the envelope BEFORE caching so retries get the same shape as
    // fresh responses. The envelope shape is stored as-is in
    // idempotency_log.response and round-trips back through
    // checkIdempotency on cache hit.
    const envelope = buildOkBody(
      { sent, failed, skipped, updated, fresh, perStaff },
      requestId,
    );

    // Cache the response for retries within the next 24h. Only the
    // success path — failures shouldn't be cached because the caller
    // probably wants to retry against a working state. Best-effort:
    // if the insert fails (race with a parallel retry that beat us
    // to it, transient DB error) we just don't cache.
    if (idem.kind === 'first') {
      await recordIdempotency(idem.key, 'send-shift-confirmations', envelope, 200, pid);
    }

    // Drain the SMS queue inline AFTER the response is sent. Vercel's
    // `after()` keeps the function alive long enough to finish background
    // work without blocking the user. This means the first Twilio sends
    // start within a couple of seconds of Mario clicking — instead of
    // waiting for the every-5-min cron tick. If Vercel cuts us off
    // mid-drain (60s function cap on Hobby), the GitHub Actions cron
    // (.github/workflows/sms-jobs-cron.yml) picks up whatever's left
    // within 5 min. Either way, no SMS is lost.
    after(async () => {
      try {
        await processSmsJobs(50);
      } catch (workerErr) {
        // Don't surface this to the user — they already got their
        // response. Log so we see it in Vercel + Sentry.
        console.error('[send-shift-confirmations] inline drain failed:', errToString(workerErr));
      }
    });

    return NextResponse.json(envelope);
  } catch (caughtErr) {
    console.error('send-shift-confirmations error:', caughtErr);
    // Persist the error so we can diagnose without shell logs.
    try {
      await supabaseAdmin.from('error_logs').insert({
        source: '/api/send-shift-confirmations',
        message: errToString(caughtErr),
        stack: caughtErr instanceof Error ? caughtErr.stack ?? null : null,
      });
    } catch {}
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
