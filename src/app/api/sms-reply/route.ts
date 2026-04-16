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

// Twilio's inbound-SMS webhook expects TwiML (XML), not JSON. Returning JSON
// makes Twilio log errorCode 12300 ("Invalid Content-Type") for every reply,
// which is exactly the bug that was breaking the YES/NO flow. An empty
// <Response/> tells Twilio "handled, send no auto-reply" — we've already
// fired our own sendSms() above.
function twimlOk(): NextResponse {
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
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

// Debug: write every webhook hit (and the final lookup outcome) to a
// top-level `webhookLog` collection so we can diagnose failures end-to-end.
// Safe to leave in — writes are tiny and capped implicitly by traffic.
async function logHit(entry: Record<string, unknown>): Promise<void> {
  try {
    await admin.firestore().collection('webhookLog').add({
      ...entry,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('logHit failed:', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    // Twilio sends form-encoded; some legacy senders send JSON.
    let fromNumber: string | undefined;
    let text: string | undefined;
    let rawBodyForLog = '';

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const jsonText = await req.text();
      rawBodyForLog = jsonText;
      const body = JSON.parse(jsonText) as { fromNumber?: string; From?: string; text?: string; Body?: string };
      fromNumber = body.fromNumber ?? body.From;
      text = body.text ?? body.Body;
    } else {
      const rawBody = await req.text();
      rawBodyForLog = rawBody;
      const params = new URLSearchParams(rawBody);
      fromNumber = params.get('From') ?? params.get('fromNumber') ?? undefined;
      text = params.get('Body') ?? params.get('text') ?? undefined;
    }

    await logHit({
      stage: 'received',
      contentType,
      fromNumber: fromNumber ?? null,
      text: text ?? null,
      rawBodyLen: rawBodyForLog.length,
      rawBodyPreview: rawBodyForLog.slice(0, 500),
    });

    if (!fromNumber || !text) {
      await logHit({ stage: 'drop_missing_from_or_text', fromNumber, text });
      return twimlOk();
    }

    const phone164 = toE164(fromNumber);
    if (!phone164) return twimlOk();

    const reply = normalise(text);
    const db = admin.firestore();

    // Find the pending shiftConfirmation for this phone via the top-level
    // `phoneLookup/{phone164}` index that /api/send-shift-confirmations writes
    // on every send. Direct get — no collectionGroup, no composite index, no
    // FAILED_PRECONDITION. New sends always last-write-win the lookup doc, so
    // inbound replies always match the newest confirmation for this phone.
    //
    // We still try a few phone-format variants for the lookup key in case
    // something upstream normalised differently (Twilio sends E.164, but legacy
    // entries could have landed under a different key).
    const digits = fromNumber.replace(/\D/g, '');
    const tenDigit = digits.length >= 10 ? digits.slice(-10) : digits;
    const variants = Array.from(new Set([
      phone164,              // +14098282023  (what we store going forward)
      fromNumber,            // whatever Twilio sent us (usually same as phone164)
      tenDigit,              // 4098282023    (legacy — raw user-entered)
      `1${tenDigit}`,        // 14098282023   (legacy — country code, no +)
    ].filter(Boolean) as string[]));

    let checkDoc: FirebaseFirestore.DocumentSnapshot | null = null;
    const tried: string[] = [];
    let lookupError: string | null = null;
    let resolvedPath: string | null = null;
    try {
      for (const v of variants) {
        tried.push(v);
        const lookupSnap = await db.collection('phoneLookup').doc(v).get();
        if (!lookupSnap.exists) continue;
        const lookupData = lookupSnap.data() as { path?: string } | undefined;
        const path = lookupData?.path;
        if (!path) continue;
        resolvedPath = path;
        const docSnap = await db.doc(path).get();
        if (!docSnap.exists) continue;
        const docData = docSnap.data() as { status?: string } | undefined;
        if (docData?.status !== 'pending') continue; // already resolved — ignore
        checkDoc = docSnap;
        break;
      }
    } catch (e) {
      lookupError = String(e);
    }

    await logHit({
      stage: 'after_lookup',
      reply,
      phone164,
      fromNumber,
      variantsTried: tried,
      matched: !!checkDoc,
      matchedDocPath: checkDoc?.ref.path ?? null,
      resolvedPath,
      lookupError,
    });

    if (!checkDoc) {
      // Nothing pending for this phone — probably an old reply, or the lookup
      // threw (see lookupError above). Drop silently; Twilio still needs a 200.
      return twimlOk();
    }
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
      return twimlOk();
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
      return twimlOk();
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

      return twimlOk();
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

      return twimlOk();
    }

    // ── Unrecognised ─────────────────────────────────────────────────────────
    const hint = lang === 'es'
      ? `No entendí eso. Por favor responde SÍ o NO.\n– ${hotelName}`
      : `Didn't catch that. Please reply YES or NO.\n– ${hotelName}`;
    await sendSms(phone164, hint);

    return twimlOk();
  } catch (err) {
    console.error('sms-reply error:', err);
    // Surface the error to the webhookLog so we can diagnose without shell logs.
    try {
      await logHit({ stage: 'handler_error', error: String(err) });
    } catch {}
    // Always 200 so Twilio doesn't retry
    return twimlOk();
  }
}
