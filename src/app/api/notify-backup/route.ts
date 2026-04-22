import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';

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
  try {
    const body = await req.json();
    const { pid, backupStaffId, roomNumber, language } = body;

    if (!pid || !backupStaffId || !roomNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

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
      console.error('[notify-backup] staff query failed', backupErr);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!backup) {
      return NextResponse.json(
        { error: 'Backup staff member not found' },
        { status: 404 }
      );
    }

    const propertyName = prop?.name || 'Your Hotel';

    if (!backup.phone || backup.is_active === false) {
      console.warn(
        `[notify-backup] Backup staff ${backup.name} has no phone or is inactive. Not texted.`
      );
      return NextResponse.json({ sent: 0, failed: 0, reason: 'backup-unreachable' });
    }

    const e164 = toE164(backup.phone);
    if (!e164) {
      console.error(`[notify-backup] Invalid phone for backup: ${backup.phone}`);
      return NextResponse.json({ sent: 0, failed: 1, reason: 'invalid-phone' });
    }

    const lang = language === 'es' ? 'es' : 'en';
    const message = lang === 'es'
      ? `🙋‍♀️ Por favor ve a ayudar en Habitación ${roomNumber}. – ${propertyName}`
      : `🙋‍♀️ Please head to Room ${roomNumber} to help out. – ${propertyName}`;

    try {
      await sendSms(e164, message);
      return NextResponse.json({ sent: 1, failed: 0, staffName: backup.name });
    } catch (err) {
      console.error(
        `[notify-backup] SMS failed for ${backup.name} (${backup.phone}):`,
        err
      );
      return NextResponse.json({ sent: 0, failed: 1 });
    }
  } catch (err) {
    console.error('[notify-backup] error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
