import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import {
  validateUuid, validateString, validateArray, sanitizeForSms, LIMITS,
} from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  NO_PROPERTY_RATE_LIMIT_KEY,
} from '@/lib/api-ratelimit';
import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';
import { NextResponse } from 'next/server';
import { buildOkBody, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

interface SmsEntry {
  phone: string;          // E.164 format, e.g. +15551234567
  name:  string;
  rooms: string[];
  housekeeperId?: string; // staff.id — used to build personal room link
}

/** Normalise a phone number to E.164. Strips non-digits and prepends +1 for 10-digit US numbers. */
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    // Lock this route behind CRON_SECRET. /api/notify-housekeepers-sms
    // is currently dead in the codebase (the active SMS path is
    // /api/send-shift-confirmations) but the URL is still public and
    // would fire SMS through our Twilio account if anyone discovered
    // it. Same secret as /api/cron/* and /api/morning-resend. Now
    // timing-safe via the shared helper.
    const unauth = requireCronSecret(req);
    if (unauth) return unauth;

    const reqBody = await req.json().catch(() => null);
    if (reqBody == null) {
      return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    // Handle both array format (legacy) and object format with uid/pid.
    let rawEntries: unknown;
    let pid: string | undefined;

    if (Array.isArray(reqBody)) {
      rawEntries = reqBody;
    } else if (reqBody && typeof reqBody === 'object') {
      rawEntries = (reqBody as { entries?: unknown }).entries ?? [];
      pid = (reqBody as { pid?: string }).pid;
    } else {
      rawEntries = [];
    }

    // ── Strict per-entry validation ─────────────────────────────────────
    // The route is CRON_SECRET-gated, but defense in depth: a stale call
    // site or a typo'd payload should fail loudly with a 400, not tunnel
    // unbounded strings into Twilio bodies. Every name/room/phone we
    // ultimately stick into an SMS must be length-bounded and free of
    // newline injection.
    const arrV = validateArray<unknown>(rawEntries, {
      max: LIMITS.STAFF_ARRAY_MAX,
      label: 'entries',
    });
    if (arrV.error) return err(arrV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    if (arrV.value!.length === 0) {
      return err('No entries provided', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const entries: SmsEntry[] = [];
    for (let i = 0; i < arrV.value!.length; i++) {
      const e = arrV.value![i];
      if (!e || typeof e !== 'object') {
        return err(`entries[${i}] not an object`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const ee = e as Record<string, unknown>;
      const phoneV = validateString(ee.phone, { max: 20, label: `entries[${i}].phone` });
      if (phoneV.error) return err(phoneV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const nameV  = validateString(ee.name,  { max: LIMITS.STAFF_NAME_MAX, label: `entries[${i}].name` });
      if (nameV.error)  return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const roomsArr = validateArray<unknown>(ee.rooms, { max: LIMITS.ASSIGNED_ROOMS_MAX, label: `entries[${i}].rooms` });
      if (roomsArr.error) return err(roomsArr.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const rooms: string[] = [];
      for (let j = 0; j < roomsArr.value!.length; j++) {
        const r = validateString(roomsArr.value![j], { max: LIMITS.ROOM_NUMBER_MAX, label: `entries[${i}].rooms[${j}]` });
        if (r.error) return err(r.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
        rooms.push(r.value!);
      }
      let hkId: string | undefined;
      if (ee.housekeeperId != null) {
        const hkV = validateUuid(ee.housekeeperId, `entries[${i}].housekeeperId`);
        if (hkV.error) return err(hkV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
        hkId = hkV.value!;
      }
      entries.push({
        phone: phoneV.value!,
        name:  sanitizeForSms(nameV.value!),
        rooms: rooms.map(sanitizeForSms),
        housekeeperId: hkId,
      });
    }

    // Idempotency check BEFORE rate limit. A retry of the same logical
    // request (same Idempotency-Key) returns the cached response without
    // burning rate-limit budget OR re-firing the SMS fan-out.
    const idem = await checkIdempotency(req, 'notify-housekeepers-sms');
    if (idem.kind === 'cached') return idem.response;

    // Rate limit BEFORE we burn Twilio credits. Per-property bucket if pid
    // is supplied AND is a valid UUID; otherwise drop into a single global
    // bucket via the sentinel UUID, which is still a meaningful protection
    // against a runaway legacy caller. CRON_SECRET above is the primary
    // gate; this is defense in depth.
    let rateLimitPid: string = NO_PROPERTY_RATE_LIMIT_KEY;
    if (pid) {
      const pidV = validateUuid(pid, 'pid');
      if (!pidV.error) rateLimitPid = pidV.value!;
    }
    const limit = await checkAndIncrementRateLimit('notify-housekeepers-sms', rateLimitPid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    let hotelName = 'Your Hotel';
    if (pid) {
      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('name')
        .eq('id', pid)
        .maybeSingle();
      hotelName = sanitizeForSms(prop?.name || 'Your Hotel');
    }

    const results = await Promise.allSettled(
      entries.map(({ phone, name, rooms, housekeeperId }) => {
        const e164 = toE164(phone);
        if (!e164) throw new Error(`Invalid phone number: ${phone}`);

        const roomList = rooms.length <= 4
          ? rooms.join(', ')
          : `${rooms.slice(0, 3).join(', ')} +${rooms.length - 3} more`;

        const link = housekeeperId
          ? ` View your rooms: https://hotelops-ai.vercel.app/housekeeper/${housekeeperId}`
          : '';
        const message = `Hi ${name.split(' ')[0]}, your rooms for today: ${roomList}.${link} – ${hotelName}`;

        return sendSms(e164, message);
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        // Redact phone + log staffId-ish position rather than the raw name,
        // to keep PII out of log aggregators.
        const redacted = (entries[i].phone ?? '').replace(/\D/g, '').slice(-4);
        console.error(`[notify-housekeepers-sms] SMS failed entry[${i}] phone=***${redacted}: ${errToString(r.reason)}`);
      }
    });

    // Build the envelope BEFORE storing so the idempotency cache holds the
    // exact same shape that gets returned to the caller. Without this, a
    // cache hit returns the raw `{ sent, failed }` while a fresh request
    // returns the full envelope, which is a real shape inconsistency.
    const envelope = buildOkBody({ sent, failed }, requestId);
    if (idem.kind === 'first') {
      await recordIdempotency(
        idem.key,
        'notify-housekeepers-sms',
        envelope,
        200,
        pid ?? null,
      );
    }
    return NextResponse.json(envelope);
  } catch (caughtErr) {
    // Server-side error detail in log; generic 500 to the caller.
    console.error('[notify-housekeepers-sms] error:', errToString(caughtErr));
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
