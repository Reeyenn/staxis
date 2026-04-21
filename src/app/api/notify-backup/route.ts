import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';
import type { StaffMember } from '@/types';

/**
 * POST /api/notify-backup
 *
 * Triggered from the manager's housekeeping board when a "Need Help" flag
 * is on a room and the manager picks a backup housekeeper to send over.
 * Texts the selected backup housekeeper (the one Mario picked), telling
 * them which room to head to.
 *
 * This is a separate endpoint from /api/help-request on purpose:
 *   - /api/help-request → single text to the Scheduling Manager only.
 *   - /api/notify-backup → single text to one specific housekeeper the
 *                          manager picked from a dropdown.
 *
 * Payload:
 *   uid              – auth user id (property owner)
 *   pid              – property id
 *   backupStaffId    – Firestore staff doc id of the housekeeper being sent
 *   roomNumber       – room the backup is being sent to
 *   language         – 'en' | 'es' (optional, defaults to en)
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
  try {
    const body = await req.json();
    const { uid, pid, backupStaffId, roomNumber, language } = body;

    if (!uid || !pid || !backupStaffId || !roomNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const db = admin.firestore();

    // Property name for the SMS footer.
    const propSnap = await db
      .collection('users')
      .doc(uid)
      .collection('properties')
      .doc(pid)
      .get();
    const propertyName = propSnap.data()?.name || 'Your Hotel';

    // Load the specific backup staff member by id.
    const backupSnap = await db
      .collection('users')
      .doc(uid)
      .collection('properties')
      .doc(pid)
      .collection('staff')
      .doc(backupStaffId)
      .get();

    if (!backupSnap.exists) {
      return NextResponse.json(
        { error: 'Backup staff member not found' },
        { status: 404 }
      );
    }

    const backup = { id: backupSnap.id, ...backupSnap.data() } as StaffMember & { id: string };

    if (!backup.phone || backup.isActive === false) {
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
