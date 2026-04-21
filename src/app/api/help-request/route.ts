import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';
import type { StaffMember } from '@/types';

/**
 * POST /api/help-request
 *
 * Triggered when a housekeeper taps "Need Help" on their mobile page.
 * Sends ONE SMS to the single staff member flagged as the property's
 * Scheduling Manager (`isSchedulingManager: true` on their staff doc).
 *
 * No broadcasts. No department-based routing. One person, one text.
 * If no scheduling manager is flagged, the request is a no-op (sent = 0).
 *
 * Payload:
 *   uid        – auth user id (property owner)
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
  try {
    const body = await req.json();
    const { uid, pid, staffName, roomNumber, language } = body;

    if (!uid || !pid || !staffName || !roomNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const db = admin.firestore();

    // Get property name
    const propSnap = await db
      .collection('users')
      .doc(uid)
      .collection('properties')
      .doc(pid)
      .get();

    const propertyName = propSnap.data()?.name || 'Your Hotel';

    // Find the single Scheduling Manager for this property.
    // There is only ever one per property — the Staff page enforces that
    // invariant via a swap-confirm modal.
    const managerSnap = await db
      .collection('users')
      .doc(uid)
      .collection('properties')
      .doc(pid)
      .collection('staff')
      .where('isSchedulingManager', '==', true)
      .limit(1)
      .get();

    if (managerSnap.empty) {
      console.warn(
        `[help-request] No scheduling manager flagged for property ${pid}. Help request from ${staffName} in Room ${roomNumber} was not routed.`
      );
      return NextResponse.json({ sent: 0, failed: 0, reason: 'no-scheduling-manager' });
    }

    const manager = {
      id: managerSnap.docs[0].id,
      ...managerSnap.docs[0].data(),
    } as StaffMember & { id: string };

    if (!manager.phone || manager.isActive === false) {
      console.warn(
        `[help-request] Scheduling manager ${manager.name} is inactive or has no phone. Help request not routed.`
      );
      return NextResponse.json({ sent: 0, failed: 0, reason: 'manager-unreachable' });
    }

    const e164 = toE164(manager.phone);
    if (!e164) {
      console.error(`[help-request] Invalid phone for scheduling manager: ${manager.phone}`);
      return NextResponse.json({ sent: 0, failed: 1, reason: 'invalid-phone' });
    }

    const lang = language === 'es' ? 'es' : 'en';
    const message = lang === 'es'
      ? `🆘 ¡Ayuda necesaria! ${staffName} necesita ayuda en Habitación ${roomNumber}. – ${propertyName}`
      : `🆘 Help needed! ${staffName} is requesting help in Room ${roomNumber}. – ${propertyName}`;

    try {
      await sendSms(e164, message);
      return NextResponse.json({ sent: 1, failed: 0 });
    } catch (err) {
      console.error(
        `[help-request] SMS failed for scheduling manager ${manager.name} (${manager.phone}):`,
        err
      );
      return NextResponse.json({ sent: 0, failed: 1 });
    }
  } catch (err) {
    console.error('[help-request] error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
