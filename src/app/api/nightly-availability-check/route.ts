import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

/**
 * POST /api/nightly-availability-check
 *
 * Sends a night-before YES/NO availability text to every active staff member.
 * Includes a one-time ESPAÑOL prompt at the bottom so they can switch language.
 *
 * Body: { uid, pid, shiftDate }   (shiftDate = tomorrow YYYY-MM-DD)
 *
 * Each text looks like:
 *   Hi Maria! Can you come in tomorrow (Tuesday, Apr 1)?
 *   Reply YES or NO.
 *
 *   Para español, responde ESPAÑOL
 *   – Comfort Suites
 *
 * Stores a nightlyAvailabilityCheck doc per staff member so sms-reply
 * can look up who replied what.
 */

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


export async function POST(req: NextRequest) {
  try {
    const { uid, pid, shiftDate } = await req.json() as {
      uid: string;
      pid: string;
      shiftDate: string; // tomorrow YYYY-MM-DD
    };

    if (!uid || !pid || !shiftDate) {
      return NextResponse.json({ error: 'Missing uid, pid, or shiftDate' }, { status: 400 });
    }

    const db = admin.firestore();

    // Fetch hotel name from property doc
    const propSnap = await db.collection('users').doc(uid).collection('properties').doc(pid).get();
    const hotelName = propSnap.data()?.name || 'Your Hotel';

    // Load all active staff with phone numbers
    const staffSnap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('staff')
      .where('isActive', '!=', false)
      .get();

    type StaffEntry = {
      id: string;
      name?: string;
      phone?: string;
      isActive?: boolean;
      [key: string]: unknown;
    };

    const activeStaff = staffSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as Omit<StaffEntry, 'id'>) } as StaffEntry))
      .filter((s): s is StaffEntry & { phone: string } => typeof s.phone === 'string' && s.phone.length > 0);

    if (activeStaff.length === 0) {
      return NextResponse.json({ message: 'No active staff with phone numbers', sent: 0 });
    }

    // Load language preferences (top-level staffPrefs collection)
    const prefSnaps = await Promise.all(
      activeStaff.map(s =>
        db.collection('staffPrefs').doc(s.id).get()
      )
    );
    const langByStaffId = new Map<string, 'en' | 'es'>();
    prefSnaps.forEach((snap, i) => {
      if (snap.exists) {
        const pref = snap.data() as { language?: 'en' | 'es' };
        if (pref.language === 'es' || pref.language === 'en') {
          langByStaffId.set(activeStaff[i].id, pref.language);
        }
      }
    });

    const results = await Promise.allSettled(
      activeStaff.map(async (staff) => {
        const phone164 = toE164(staff.phone as string);
        if (!phone164) throw new Error(`Invalid phone: ${staff.phone}`);

        const lang = langByStaffId.get(staff.id) ?? 'en';
        const firstName = (staff.name as string ?? 'there').split(' ')[0];
        const dateLabel = formatShiftDate(shiftDate, lang);

        // Build the message - Spanish if preference saved, English otherwise
        // Always include ESPAÑOL prompt unless they already speak Spanish
        let message: string;
        if (lang === 'es') {
          message = `Hola ${firstName}! ¿Puedes venir mañana (${dateLabel})?\nResponde SÍ o NO.\n\nFor English, reply ENGLISH\n– ${hotelName}`;
        } else {
          message = `Hi ${firstName}! Can you come in tomorrow (${dateLabel})?\nReply YES or NO.\n\nPara español, responde ESPAÑOL\n– ${hotelName}`;
        }

        // Store the check doc so sms-reply can look it up by phone
        const checkRef = db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('nightlyAvailabilityChecks')
          .doc(`${shiftDate}_${staff.id}`);

        await checkRef.set({
          uid,
          pid,
          staffId: staff.id,
          staffName: staff.name ?? '',
          staffPhone: staff.phone,
          shiftDate,
          language: lang,
          status: 'pending',   // pending | confirmed | declined
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          respondedAt: null,
        });

        await sendSms(phone164, message);

        await checkRef.update({ smsSent: true });

        return { staffId: staff.id, name: staff.name };
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Availability check failed for ${activeStaff[i].name}:`, r.reason);
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    console.error('nightly-availability-check error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
