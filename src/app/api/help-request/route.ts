import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import {
  validateUuid, validateString, validateEnum, sanitizeForSms, redactPhone, LIMITS,
} from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

/**
 * POST /api/help-request
 *
 * Triggered when a housekeeper taps "Need Help" on their mobile page.
 * Sends ONE SMS to the single staff member flagged as the property's
 * Scheduling Manager (is_scheduling_manager = true on their staff row).
 *
 * No broadcasts. No department-based routing. One person, one text.
 * If no scheduling manager is flagged, the request is a no-op (sent = 0).
 *
 * Payload:
 *   uid        – retained for back-compat; no longer required for scoping
 *                (RLS + pid are enough under Supabase)
 *   pid        – property id
 *   staffName  – name of the housekeeper asking for help (shown in the SMS)
 *   roomNumber – room the housekeeper is in
 *   language   – 'en' | 'es' (optional, defaults to en)
 */

/** E.164 phone normalization */
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
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const { pid: rawPid, staffId: rawStaffId, staffName: rawStaffName,
            roomNumber: rawRoomNumber, language: rawLanguage } = body as Record<string, unknown>;

    // Validate every field. We're sticking strings into Twilio messages — if
    // we don't strip newlines + cap length, an attacker can put `\n\nSPAM` in
    // a staffName and inject extra SMS content.
    const pidV = validateUuid(rawPid, 'pid');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const staffNameV = validateString(rawStaffName, { max: LIMITS.STAFF_NAME_MAX, label: 'staffName' });
    if (staffNameV.error) return err(staffNameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const roomNumV = validateString(rawRoomNumber, { max: LIMITS.ROOM_NUMBER_MAX, label: 'roomNumber' });
    if (roomNumV.error) return err(roomNumV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const langV = rawLanguage == null
      ? { value: 'en' as const }
      : validateEnum(rawLanguage, ['en', 'es'] as const, 'language');
    if (langV.error) return err(langV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    const pid = pidV.value!;
    const staffName = sanitizeForSms(staffNameV.value!);
    const roomNumber = sanitizeForSms(roomNumV.value!);
    const lang = langV.value!;

    // ── Caller verification ───────────────────────────────────────────────
    // 2026-05-12: previously staffId was OPTIONAL. With just a property id
    // (which is not secret — it appears in URLs), anyone could trigger an
    // SMS to the scheduling manager up to the rate-limit cap. The HK
    // mobile page always includes staffId in the link, so requiring it
    // only blocks abuse.
    const staffIdV = validateUuid(rawStaffId, 'staffId');
    if (staffIdV.error) {
      return err(staffIdV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const staffId = staffIdV.value!;

    // Rate limit: cap at 20 help requests per property per hour. A single
    // hotel will never legitimately need more.
    const limit = await checkAndIncrementRateLimit('help-request', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    // Verify the staffId belongs to this property and is active. Mismatch
    // silently no-ops so we don't leak existence.
    const { data: staffRow, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, property_id, is_active')
      .eq('id', staffId)
      .maybeSingle();
    if (staffErr) {
      log.error('[help-request] staff lookup error', { err: staffErr, requestId });
      return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!staffRow || staffRow.property_id !== pid) {
      return ok({ sent: 0, failed: 0, reason: 'unknown-staff' }, { requestId });
    }
    if (staffRow.is_active === false) {
      return ok({ sent: 0, failed: 0, reason: 'staff-inactive' }, { requestId });
    }

    // Fetch property name and scheduling manager in parallel.
    const [{ data: prop }, { data: managers, error: mgrErr }] = await Promise.all([
      supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle(),
      supabaseAdmin
        .from('staff')
        .select('id, name, phone, is_active, is_scheduling_manager')
        .eq('property_id', pid)
        .eq('is_scheduling_manager', true)
        .limit(1),
    ]);

    if (mgrErr) {
      log.error('[help-request] staff query failed', { err: mgrErr, requestId });
      return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }

    const propertyName = prop?.name || 'Your Hotel';

    if (!managers || managers.length === 0) {
      // Don't log staffName + roomNumber here — they're user-controlled and
      // would let us tag a property's logs by injection. Just log the pid.
      log.warn('[help-request] No scheduling manager', { pid, requestId });
      return ok({ sent: 0, failed: 0, reason: 'no-scheduling-manager' }, { requestId });
    }

    const manager = managers[0];

    if (!manager.phone || manager.is_active === false) {
      log.warn('[help-request] Scheduling manager unreachable (no phone or inactive)', { pid, requestId });
      return ok({ sent: 0, failed: 0, reason: 'manager-unreachable' }, { requestId });
    }

    const e164 = toE164(manager.phone);
    if (!e164) {
      // Redact phone so we don't leak PII to log aggregators.
      log.error('[help-request] Invalid phone for scheduling manager', { pid, phone: redactPhone(manager.phone), requestId });
      return ok({ sent: 0, failed: 1, reason: 'invalid-phone' }, { requestId });
    }

    const message = lang === 'es'
      ? `🆘 ¡Ayuda necesaria! ${staffName} necesita ayuda en Habitación ${roomNumber}. – ${sanitizeForSms(propertyName)}`
      : `🆘 Help needed! ${staffName} is requesting help in Room ${roomNumber}. – ${sanitizeForSms(propertyName)}`;

    try {
      await sendSms(e164, message);
      return ok({ sent: 1, failed: 0 }, { requestId });
    } catch (smsErr) {
      log.error('[help-request] SMS failed', { err: smsErr, pid, mgr: redactPhone(manager.phone), requestId });
      return ok({ sent: 0, failed: 1 }, { requestId });
    }
  } catch (caughtErr) {
    // Don't leak stack traces or internal field values to the caller in prod.
    log.error('[help-request] error', { err: caughtErr, requestId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
