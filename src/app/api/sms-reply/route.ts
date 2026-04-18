/**
 * POST /api/sms-reply
 *
 * Twilio inbound-SMS webhook. Under the new flow the outbound SMS is just a
 * link to the HK's personal page — there is no YES/NO prompt, no escalation,
 * no manager paging. Maria confirms availability in person at 3pm.
 *
 * The only reply we act on is a language switch:
 *
 *   ESPAÑOL → mirror lang='es' to staffPrefs + staff doc + confirmation doc,
 *             then resend the link SMS in Spanish.
 *   ENGLISH → mirror lang='en' and resend the link SMS in English.
 *   anything else → friendly "got your message, open your link" ack.
 *
 * Every code path returns an empty TwiML <Response/> so Twilio doesn't send
 * its own auto-reply on top of ours.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

// Twilio expects TwiML (XML), not JSON. An empty <Response/> tells Twilio
// "handled, send no auto-reply" — we've fired our own sendSms() already.
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
  return text.trim().toUpperCase().replace(/[.!?¿¡,;:()"'`]/g, '').trim();
}

const ES_SET = new Set(['ESPANOL', 'ESPAÑOL', 'SPANISH', 'ESP']);
const EN_SET = new Set(['ENGLISH', 'INGLES', 'INGLÉS', 'EN']);

type ShiftConfirmation = {
  uid: string;
  pid: string;
  staffId: string;
  staffName: string;
  staffPhone: string;
  shiftDate: string;
  status: 'sent' | 'pending' | 'confirmed' | 'declined';
  language: 'en' | 'es';
  hkUrl?: string;
  hotelName?: string;
};

// Debug: write every webhook hit (and the final lookup outcome) to a
// top-level `webhookLog` collection so we can diagnose failures end-to-end.
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

    // Find the most recent open shiftConfirmation for this phone via the
    // top-level `phoneLookup/{phone164}` index that /api/send-shift-confirmations
    // writes on every send. Direct get — no collectionGroup, no composite
    // index, no FAILED_PRECONDITION. Last-write-wins: newest send for this
    // phone is always what replies match.
    const digits = fromNumber.replace(/\D/g, '');
    const tenDigit = digits.length >= 10 ? digits.slice(-10) : digits;
    const variants = Array.from(new Set([
      phone164,
      fromNumber,
      tenDigit,
      `1${tenDigit}`,
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
        // 'sent' is the new default. 'pending' is legacy from the old yes/no
        // flow — treat it the same for lookup purposes so legacy docs still
        // match. 'confirmed' / 'declined' are resolved states — ignore.
        if (docData?.status !== 'sent' && docData?.status !== 'pending') continue;
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
      // Nothing open for this phone — drop silently; Twilio still needs 200.
      return twimlOk();
    }
    const data = checkDoc.data() as ShiftConfirmation;
    const { uid, pid, staffName, shiftDate } = data;
    const firstName = (staffName ?? 'there').split(' ')[0];
    const hotelName = data.hotelName || 'the hotel';

    // Render the same minimal link SMS that /api/send-shift-confirmations
    // sends. Used when the HK toggles language — we resend in the new lang.
    const renderLinkMessage = (targetLang: 'en' | 'es'): string => {
      const hkUrl = data.hkUrl ?? '';
      const label = formatShiftDate(shiftDate, targetLang);
      return targetLang === 'es'
        ? `Hola ${firstName}! Tu lista para ${label}:\n${hkUrl}\n\nFor English, reply ENGLISH\n\n– ${hotelName}`
        : `Hi ${firstName}! Your list for ${label}:\n${hkUrl}\n\nPara español, responde ESPAÑOL\n\n– ${hotelName}`;
    };

    const mirrorLang = async (next: 'en' | 'es'): Promise<void> => {
      // Mirror the language onto three places so everything stays in sync:
      // the legacy staffPrefs doc (kept for backward compat), the staff
      // doc (canonical — what the admin Staff modal reads/writes and what
      // the HK personal page seeds from), and the current confirmation.
      await db.collection('staffPrefs').doc(data.staffId).set(
        { language: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      try {
        await db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('staff').doc(data.staffId)
          .update({ language: next });
      } catch (err) {
        console.error(`[sms-reply] staff doc lang mirror (${next}) failed:`, err);
      }
      await checkDoc!.ref.update({ language: next });
    };

    // ── ESPAÑOL — switch to Spanish and resend the link ─────────────────────
    if (ES_SET.has(reply)) {
      await mirrorLang('es');
      await sendSms(phone164, renderLinkMessage('es'));
      return twimlOk();
    }

    // ── ENGLISH — switch to English and resend the link ─────────────────────
    if (EN_SET.has(reply)) {
      await mirrorLang('en');
      await sendSms(phone164, renderLinkMessage('en'));
      return twimlOk();
    }

    // ── Anything else — friendly ack, point at their link ───────────────────
    const lang: 'en' | 'es' = data.language ?? 'en';
    const hint = lang === 'es'
      ? `¡Gracias, ${firstName}! Abre tu enlace para ver tu lista.\n– ${hotelName}`
      : `Thanks, ${firstName}! Open your link to see your list.\n– ${hotelName}`;
    await sendSms(phone164, hint);

    return twimlOk();
  } catch (err) {
    console.error('sms-reply error:', err);
    try {
      await logHit({ stage: 'handler_error', error: String(err) });
    } catch {}
    // Always 200 so Twilio doesn't retry
    return twimlOk();
  }
}
