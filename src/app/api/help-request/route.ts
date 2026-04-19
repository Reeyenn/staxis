import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';
import type { StaffMember } from '@/types';

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

    // Get all front_desk staff members (they're the ones who need to be notified)
    const staffSnap = await db
      .collection('users')
      .doc(uid)
      .collection('properties')
      .doc(pid)
      .collection('staff')
      .where('department', '==', 'front_desk')
      .get();

    const frontDeskStaff = staffSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() } as StaffMember & { id: string }))
      .filter(staff => staff.phone && staff.isActive !== false);

    if (frontDeskStaff.length === 0) {
      // No front desk staff to notify
      return NextResponse.json({ sent: 0, failed: 0 });
    }

    // Build SMS message based on language preference
    const lang = language === 'es' ? 'es' : 'en';
    const message = lang === 'es'
      ? `🆘 ¡Ayuda necesaria! ${staffName} necesita ayuda en Habitación ${roomNumber}. – ${propertyName}`
      : `🆘 Help needed! ${staffName} is requesting help in Room ${roomNumber}. – ${propertyName}`;

    // Send SMS to all front desk staff
    const results = await Promise.allSettled(
      frontDeskStaff.map(staff => {
        const e164 = toE164(staff.phone!);
        if (!e164) throw new Error(`Invalid phone number: ${staff.phone}`);
        return sendSms(e164, message);
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Log any failures for debugging
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(
          `SMS failed for ${frontDeskStaff[i].name} (${frontDeskStaff[i].phone}):`,
          r.reason
        );
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    console.error('[help-request] error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
