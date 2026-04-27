import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  validateUuid, validateString, validateEnum, sanitizeForSms, redactPhone, LIMITS,
} from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

/**
 * POST /api/notify-backup
 *
 * Triggered from the manager's housekeeping board when a "Need Help" flag
 * is on a room and the manager picks a backup housekeeper to send over.
 *
 * Separate from /api/help-request on purpose:
 *   - /api/help-request → single text to the Scheduling Manager only.
 *   - /api/notify-backup → single text to one specific housekeeper the
 *                          manager picked from a dropdown.
 *
 * Payload:
 *   pid              – property id
 *   backupStaffId    – staff.id of the housekeeper being sent
 *   roomNumber       – room the backup is being sent to
 *   language         – 'en' | 'es' (optional, defaults to en)
 */

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST(req: NextRequest) {
  // Auth: require an authenticated Supabase session AND verify the caller
  // has access to the property they're sending notifications for. Without
  // this, anyone could POST {pid, backupStaffId, roomNumber} and run our
  // Twilio meter to zero by texting random staff numbers we look up by id.
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;

    const pidV = validateUuid(b.pid, 'pid');
    if (pidV.error) return NextResponse.json({ error: pidV.error }, { status: 400 });
    const backupV = validateUuid(b.backupStaffId, 'backupStaffId');
    if (backupV.error) return NextResponse.json({ error: backupV.error }, { status: 400 });
    const roomV = validateString(b.roomNumber, { max: LIMITS.ROOM_NUMBER_MAX, label: 'roomNumber' });
    if (roomV.error) return NextResponse.json({ error: roomV.error }, { status: 400 });
    const langV = b.language == null
      ? { value: 'en' as const }
      : validateEnum(b.language, ['en', 'es'] as const, 'language');
    if (langV.error) return NextResponse.json({ error: langV.error }, { status: 400 });

    const pid = pidV.value!;
    const backupStaffId = backupV.value!;
    const roomNumber = sanitizeForSms(roomV.value!);
    const lang = langV.value!;

    if (!(await userHasPropertyAccess(session.userId, pid))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // Cap at 20 backup-dispatches/hour/property — way over real-world need.
    const limit = await checkAndIncrementRateLimit('notify-backup', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    // Property name + specific backup staff in parallel.
    const [{ data: prop }, { data: backup, error: backupErr }] = await Promise.all([
      supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle(),
      supabaseAdmin
        .from('staff')
        .select('id, name, phone, is_active')
        .eq('id', backupStaffId)
        .eq('property_id', pid)
        .maybeSingle(),
    ]);

    if (backupErr) {
      console.error('[notify-backup] staff query failed:', backupErr.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!backup) {
      // Don't 404 with a specific "Backup staff member not found" — that
      // confirms the id format was correct but the row was missing.
      // Return generic 200 with reason so the UI can show "couldn't reach".
      return NextResponse.json({ sent: 0, failed: 0, reason: 'unknown-staff' });
    }

    const propertyName = sanitizeForSms(prop?.name || 'Your Hotel');

    if (!backup.phone || backup.is_active === false) {
      console.warn(`[notify-backup] Backup staff (id=${backupStaffId}) has no phone or is inactive`);
      return NextResponse.json({ sent: 0, failed: 0, reason: 'backup-unreachable' });
    }

    const e164 = toE164(backup.phone);
    if (!e164) {
      // Redact phone before logging.
      console.error(`[notify-backup] Invalid phone for backup (id=${backupStaffId}, phone=${redactPhone(backup.phone)})`);
      return NextResponse.json({ sent: 0, failed: 1, reason: 'invalid-phone' });
    }

    const message = lang === 'es'
      ? `🙋‍♀️ Por favor ve a ayudar en Habitación ${roomNumber}. – ${propertyName}`
      : `🙋‍♀️ Please head to Room ${roomNumber} to help out. – ${propertyName}`;

    try {
      await sendSms(e164, message);
      return NextResponse.json({ sent: 1, failed: 0, staffName: sanitizeForSms(backup.name ?? '') });
    } catch (err) {
      console.error(
        `[notify-backup] SMS failed (id=${backupStaffId}, phone=${redactPhone(backup.phone)}): ${errToString(err)}`,
      );
      return NextResponse.json({ sent: 0, failed: 1 });
    }
  } catch (err) {
    // Don't echo raw error messages back — they can leak Postgres / internal
    // path info. Log full error server-side, return generic 500 to caller.
    console.error('[notify-backup] error:', errToString(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
