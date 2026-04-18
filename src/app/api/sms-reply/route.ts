/**
 * POST /api/sms-reply
 *
 * Twilio inbound-SMS webhook. Matches every incoming text against the most
 * recent open shiftConfirmation ('sent' or legacy 'pending') for that phone.
 *
 *   YES / SÍ / Y / S    → confirm → short thanks → ping manager(s)
 *                         (HK already has the link — no need to resend)
 *   NO / N              → decline → ack the HK → ping manager(s) (no auto-cascade)
 *   ESPAÑOL / ENGLISH   → toggle language preference, resend the LINK message
 *                         in the new language
 *   anything else       → gentle "didn't catch that" hint
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
  return text.trim().toUpperCase().replace(/[.!?¿¡,;:()"'`]/g, '').trim();
}

// Tight exact-match sets for short replies (protects against false positives
// on replies like "NOPE" or "YES but I'm late" which we handle via the fuzzy
// matchers below).
const YES_SET = new Set(['YES', 'Y', 'SI', 'SÍ', 'SÌ', 'S']);
const NO_SET  = new Set(['NO', 'N']);
const ES_SET  = new Set(['ESPANOL', 'ESPAÑOL', 'SPANISH', 'ESP']);
const EN_SET  = new Set(['ENGLISH', 'INGLES', 'INGLÉS', 'EN']);

/**
 * Fuzzy classifier for short conversational replies from non-native English
 * speakers on mobile keyboards. Examples we need to accept:
 *
 *   YES:  "yeah", "yep", "yup", "sure", "ok", "okay", "will do",
 *         "coming", "ill be there", "im coming", "si si", "claro",
 *         "yes im coming", "y es", "yess", "yes!!"
 *
 *   NO:   "nope", "nah", "cant", "cant make it", "sorry no",
 *         "no puedo", "not coming", "sick"
 *
 * Returns 'yes' | 'no' | null. Returns null (not yes or no) on truly
 * ambiguous inputs so the caller can send the "didn't catch that" hint.
 *
 * IMPORTANT: order of checks matters — we check NO *first* because replies
 * like "not coming" could otherwise accidentally hit a YES keyword if we
 * checked YES first.
 */
function classifyReply(normalised: string): 'yes' | 'no' | null {
  if (!normalised) return null;

  // 1. Exact matches (strict, fastest path)
  if (YES_SET.has(normalised)) return 'yes';
  if (NO_SET.has(normalised)) return 'no';

  // 2. Collapse repeated chars ("YESSSS" → "YES") and re-check exact sets
  const collapsed = normalised.replace(/(.)\1{2,}/g, '$1$1');
  if (YES_SET.has(collapsed)) return 'yes';
  if (NO_SET.has(collapsed)) return 'no';

  // 3. Word-level tokenisation so we only match whole words, not substrings.
  //    "SICK" should be NO, but should NOT accidentally match "YES" inside
  //    another word.
  const tokens = normalised.split(/\s+/).filter(Boolean);
  const tokenSet = new Set(tokens);

  // Strong NO signals — check these BEFORE any YES signal, since phrases like
  // "not coming" or "sorry no" contain tokens that would otherwise match YES.
  const NO_WORDS = [
    'NO', 'N', 'NOPE', 'NAH', 'NEGATIVE', 'NEVER',
    'CANT', 'CANNOT', 'WONT',
    'SICK', 'BUSY', 'SORRY',
    'NOT',         // "not coming", "not going"
    'POR',         // rare but shows up in "no puedo" variations
    'PUEDO',       // "no puedo"
  ];
  for (const w of NO_WORDS) {
    if (tokenSet.has(w)) return 'no';
  }

  // Strong YES signals
  const YES_WORDS = [
    'YES', 'Y', 'YEAH', 'YEA', 'YEP', 'YUP', 'YUH',
    'OK', 'OKAY', 'KAY', 'K',
    'SURE', 'DEFINITELY', 'ABSOLUTELY',
    'COMING', 'COMIN',
    'SI', 'SÍ', 'CLARO', 'VALE', 'LISTO',
    'CONFIRM', 'CONFIRMED',
    'WILL',         // "will do", "will be there"
    'AFFIRMATIVE',
  ];
  for (const w of YES_WORDS) {
    if (tokenSet.has(w)) return 'yes';
  }

  // 4. Last-ditch substring check for glued-together replies like "YESS" or
  //    typo'd "YS" — only apply when the whole normalised string is very
  //    short, so we don't accidentally match "YES" inside a longer sentence.
  if (normalised.length <= 6) {
    if (/^Y(E|S|ES|ESS|SS)?$/.test(normalised)) return 'yes';
    if (/^N(O|OP|OPE|AH)?$/.test(normalised)) return 'no';
  }

  return null;
}

type ShiftConfirmation = {
  uid: string;
  pid: string;
  staffId: string;
  staffName: string;
  staffPhone: string;
  shiftDate: string;
  status: 'sent' | 'pending' | 'confirmed' | 'declined';
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
        // 'sent' is the new default status after Send; 'pending' is legacy
        // from the old yes/no flow. Either counts as "open" — replies should
        // still work. We only skip docs that are already resolved.
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
      // Nothing pending for this phone — probably an old reply, or the lookup
      // threw (see lookupError above). Drop silently; Twilio still needs a 200.
      return twimlOk();
    }
    const data = checkDoc.data() as ShiftConfirmation;
    const { uid, pid, staffName, shiftDate } = data;
    const lang: 'en' | 'es' = data.language ?? 'en';
    const firstName = (staffName ?? 'there').split(' ')[0];
    const hotelName = data.hotelName || 'the hotel';

    // Compose the link-with-rooms message used when the HK toggles language.
    // Same template as /api/send-shift-confirmations — we just re-render in
    // the new language and resend so they see their assignment in the
    // language they asked for.
    const renderLinkMessage = (targetLang: 'en' | 'es'): string => {
      const rooms  = data.assignedRooms ?? [];
      const areas  = data.assignedAreas ?? [];
      const hkUrl  = data.hkUrl ?? '';
      const label  = formatShiftDate(shiftDate, targetLang);
      const roomsLabel = rooms.length
        ? (targetLang === 'es' ? `Cuartos: ${rooms.join(', ')}` : `Rooms: ${rooms.join(', ')}`)
        : (areas.length
            ? (targetLang === 'es' ? `Áreas: ${areas.join(', ')}` : `Areas: ${areas.join(', ')}`)
            : (targetLang === 'es' ? 'Sin asignaciones' : 'No assignments'));
      return targetLang === 'es'
        ? `Hola ${firstName}! Tu lista para ${label}:\n${roomsLabel}\nAbrir: ${hkUrl}\n\nFor English, reply ENGLISH\n– ${hotelName}`
        : `Hi ${firstName}! Your list for ${label}:\n${roomsLabel}\nOpen: ${hkUrl}\n\nPara español, responde ESPAÑOL\n– ${hotelName}`;
    };

    // ── ESPAÑOL — switch to Spanish and resend the link ─────────────────────
    if (ES_SET.has(reply)) {
      // Mirror the language choice onto three places so everything stays
      // in sync: the legacy staffPrefs doc (kept for backward compat),
      // the staff doc (canonical — what the admin Staff modal reads/writes
      // and what the HK personal page now seeds from), and the current
      // shift confirmation (so follow-up copy uses the right language).
      await db.collection('staffPrefs').doc(data.staffId).set(
        { language: 'es', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      try {
        await db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('staff').doc(data.staffId)
          .update({ language: 'es' });
      } catch (err) {
        console.error('[sms-reply] staff doc lang mirror (es) failed:', err);
      }
      await checkDoc.ref.update({ language: 'es' });

      await sendSms(phone164, renderLinkMessage('es'));
      return twimlOk();
    }

    // ── ENGLISH — switch back to English and resend the link ───────────────
    if (EN_SET.has(reply)) {
      // Mirror onto staffPrefs + staff doc + confirmation (see ESPAÑOL branch).
      await db.collection('staffPrefs').doc(data.staffId).set(
        { language: 'en', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      try {
        await db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('staff').doc(data.staffId)
          .update({ language: 'en' });
      } catch (err) {
        console.error('[sms-reply] staff doc lang mirror (en) failed:', err);
      }
      await checkDoc.ref.update({ language: 'en' });

      await sendSms(phone164, renderLinkMessage('en'));
      return twimlOk();
    }

    // ── YES/NO fuzzy classification ─────────────────────────────────────────
    // Translate conversational replies like "yes im coming", "yeah sure",
    // "nope", "cant make it" into a clean yes/no/null signal. Falls through
    // to the "didn't catch that" hint for truly ambiguous input.
    const intent = classifyReply(reply);
    await logHit({ stage: 'classified', reply, intent });

    // ── YES — confirm, send personal link, ping manager(s) ──────────────────
    if (intent === 'yes') {
      await checkDoc.ref.update({
        status: 'confirmed',
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Short acknowledgment. The HK already has their link from the initial
      // send — no need to resend it here. Maria confirms availability in
      // person at 3pm anyway; this reply is just a courtesy.
      const confirmMsg = lang === 'es'
        ? `✅ ¡Gracias, ${firstName}! Nos vemos mañana.\n– ${hotelName}`
        : `✅ Thanks, ${firstName}! See you tomorrow.\n– ${hotelName}`;
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
    if (intent === 'no') {
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
    // New flow: the SMS is just a link. There's no YES/NO prompt, so we
    // don't tell the HK to reply YES or NO. We just let them know we got
    // their message and point them at the link they already have.
    const hint = lang === 'es'
      ? `¡Gracias, ${firstName}! Recibí tu mensaje. Abre tu enlace para ver tu lista de hoy.\n– ${hotelName}`
      : `Thanks, ${firstName}! Got your message. Open your link to see today's list.\n– ${hotelName}`;
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
