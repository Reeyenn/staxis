/**
 * POST /api/sms-reply
 *
 * Twilio inbound-SMS webhook. Matches every incoming text against the most
 * recent pending shiftConfirmation for that phone.
 *
 *   YES / SÍ / Y / S    → confirm → send HK their personal link → ping manager(s)
 *   NO / N              → decline → ack the HK → ping manager(s) (no auto-cascade)
 *   ESPAÑOL / ENGLISH   → toggle language preference, resend the YES/NO prompt
 *   anything else       → "didn't catch that, reply YES or NO"
 *
 * Manager = every active staff member with department === 'front_desk' and a phone.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

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

function normalise(text: string): string {
  return text.trim().toUpperCase().replace(/[.!?¿¡]/g, '').trim();
}

const YES_SET = new Set(['YES', 'Y', 'SI', 'SÍ', 'SÌ', 'S']);
const NO_SET  = new Set(['NO', 'N']);
const ES_SET  = new Set(['ESPANOL', 'ESPAÑOL', 'SPANISH', 'ESP']);
const EN_SET  = new Set(['ENGLISH', 'INGLES', 'INGLÉS', 'EN']);

type ShiftConfirmation = {
  uid: string;
  pid: string;
  staffId: string;
  staffName: string;
  staffPhone: string;
  shiftDate: string;
  status: 'pending' | 'confirmed' | 'declined';
  language: 'en' | 'es';
  assignedRooms?: string[];
  assignedAreas?: string[];
  hkUrl?: string;
  hotelName?: string;
};

/**
 * Find active front-desk staff with phone numbers. These are the people we
 * SMS when a housekeeper confirms or declines.
 */
async function getManagerPhones(uid: string, pid: string): Promise<Array<{ name: string; phone: string }>> {
  const db = admin.firestore();
  const snap = await db
    .collection('users').doc(uid)
    .collection('properties').doc(pid)
    .collection('staff')
    .where('department', '==', 'front_desk')
    .get();

  const results: Array<{ name: string; phone: string }> = [];
  snap.docs.forEach(doc => {
    const d = doc.data() as { name?: string; phone?: string; isActive?: boolean };
    if (d.isActive === false) return;
    if (!d.phone) return;
    const phone164 = toE164(d.phone);
    if (!phone164) return;
    results.push({ name: d.name ?? 'Manager', phone: phone164 });
  });
  return results;
}

async function notifyManagers(
  uid: string,
  pid: string,
  message: string,
): Promise<void> {
  const managers = await getManagerPhones(uid, pid);
  await Promise.allSettled(
    managers.map(m => sendSms(m.phone, message)),
  );
}

export async function POST(req: NextRequest) {
  try {
    // Twilio sends form-encoded; some legacy senders send JSON.
    let fromNumber: string | undefined;
    let text: string | undefined;

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await req.json() as { fromNumber?: string; From?: string; text?: string; Body?: string };
      fromNumber = body.fromNumber ?? body.From;
      text = body.text ?? body.Body;
    } else {
      const rawBody = await req.text();
      const params = new URLSearchParams(rawBody);
      fromNumber = params.get('From') ?? params.get('fromNumber') ?? undefined;
      text = params.get('Body') ?? params.get('text') ?? undefined;
    }

    if (!fromNumber || !text) {
      return NextResponse.json({ ok: true });
    }

    const phone164 = toE164(fromNumber);
    if (!phone164) return NextResponse.json({ ok: true });

    const reply = normalise(text);
    const db = admin.firestore();

    // Find the most recent pending shiftConfirmation for this phone. Try both
    // the raw number and the E.164 version so it works whichever format was
    // stored on the staff record.
    async function findPending(phoneVariant: string) {
      return db
        .collectionGroup('shiftConfirmations')
        .where('staffPhone', '==', phoneVariant)
        .where('status', '==', 'pending')
        .orderBy('sentAt', 'desc')
        .limit(1)
        .get();
    }

    let snap = await findPending(fromNumber);
    if (snap.empty && phone164 !== fromNumber) {
      snap = await findPending(phone164);
    }

    if (snap.empty) {
      // Nothing pending for this phone — probably an old reply. Drop silently.
      return NextResponse.json({ ok: true });
    }

    const checkDoc = snap.docs[0];
    const data = checkDoc.data() as ShiftConfirmation;
    const { uid, pid, staffName, shiftDate } = data;
    const lang: 'en' | 'es' = data.language ?? 'en';
    const firstName = (staffName ?? 'there').split(' ')[0];
    const hotelName = data.hotelName || 'the hotel';

    // ── ESPAÑOL — switch to Spanish and resend ─────────────────────────────
    if (ES_SET.has(reply)) {
      await db.collection('staffPrefs').doc(data.staffId).set(
        { language: 'es', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      await checkDoc.ref.update({ language: 'es' });

      const dateLabel = formatShiftDate(shiftDate, 'es');
      await sendSms(
        phone164,
        `Hola ${firstName}! ¿Puedes venir mañana (${dateLabel})?\nResponde SÍ o NO.\n\nFor English, reply ENGLISH\n– ${hotelName}`,
      );
      return NextResponse.json({ ok: true });
    }

    // ── ENGLISH — switch back to English and resend ────────────────────────
    if (EN_SET.has(reply)) {
      await db.collection('staffPrefs').doc(data.staffId).set(
        { language: 'en', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      await checkDoc.ref.update({ language: 'en' });

      const dateLabel = formatShiftDate(shiftDate, 'en');
      await sendSms(
        phone164,
        `Hi ${firstName}! Can you come in tomorrow (${dateLabel})?\nReply YES or NO.\n\nPara español, responde ESPAÑOL\n– ${hotelName}`,
      );
      return NextResponse.json({ ok: true });
    }

    // ── YES — confirm, send personal link, ping manager(s) ──────────────────
    if (YES_SET.has(reply)) {
      await checkDoc.ref.update({
        status: 'confirmed',
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const hkUrl = data.hkUrl ?? '';
      const confirmMsg = lang === 'es'
        ? `✅ ¡Confirmado, ${firstName}! Mañana te esperamos.${hkUrl ? `\nTu enlace: ${hkUrl}` : ''}\n– ${hotelName}`
        : `✅ Confirmed, ${firstName}! See you tomorrow.${hkUrl ? `\nYour link: ${hkUrl}` : ''}\n– ${hotelName}`;
      await sendSms(phone164, confirmMsg);

      const dateLabel = formatShiftDate(shiftDate, 'en');
      await notifyManagers(
        uid, pid,
        `✅ ${staffName} confirmed for ${dateLabel}.`,
      );

      // In-app notification for the dashboard panel
      await db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('managerNotifications').add({
          uid, pid,
          type: 'availability_confirmed',
          message: `${staffName} confirmed for ${shiftDate}`,
          staffId: data.staffId,
          staffName,
          shiftDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return NextResponse.json({ ok: true });
    }

    // ── NO — acknowledge, ping manager(s), NO auto-cascade ──────────────────
    if (NO_SET.has(reply)) {
      await checkDoc.ref.update({
        status: 'declined',
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const ackMsg = lang === 'es'
        ? `Entendido, ${firstName}. Gracias por avisar.\n– ${hotelName}`
        : `No problem, ${firstName}. Thanks for letting us know.\n– ${hotelName}`;
      await sendSms(phone164, ackMsg);

      const dateLabel = formatShiftDate(shiftDate, 'en');
      await notifyManagers(
        uid, pid,
        `⚠️ ${staffName} can't come in ${dateLabel}. Please arrange cover.`,
      );

      await db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('managerNotifications').add({
          uid, pid,
          type: 'availability_declined',
          message: `${staffName} can't come in ${shiftDate}`,
          staffId: data.staffId,
          staffName,
          shiftDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return NextResponse.json({ ok: true });
    }

    // ── Unrecognised ─────────────────────────────────────────────────────────
    const hint = lang === 'es'
      ? `No entendí eso. Por favor responde SÍ o NO.\n– ${hotelName}`
      : `Didn't catch that. Please reply YES or NO.\n– ${hotelName}`;
    await sendSms(phone164, hint);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('sms-reply error:', err);
    // Always 200 so Twilio doesn't retry
    return NextResponse.json({ ok: true });
  }
}
