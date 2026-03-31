import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

/**
 * POST /api/sms-reply
 *
 * Textbelt reply webhook — receives raw SMS replies from housekeepers.
 *
 * Supported replies:
 *   YES / SÍ / SI  → mark availability confirmed, send room assignment + personal link
 *   NO             → mark declined, acknowledge, cascade to next eligible staff
 *   ESPAÑOL / ESPANOL → save language preference, resend availability check in Spanish
 *   (anything else) → send a "didn't catch that" hint
 *
 * Textbelt sends a POST with JSON body: { fromNumber, text, textId }
 */

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

async function sendSms(
  phone: string,
  message: string,
  replyWebhookUrl?: string,
): Promise<void> {
  const body: Record<string, string> = {
    phone,
    message,
    key: process.env.TEXTBELT_API_KEY ?? 'textbelt',
  };
  if (replyWebhookUrl) body.replyWebhookUrl = replyWebhookUrl;

  const res = await fetch('https://textbelt.com/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { success: boolean; error?: string };
  if (!data.success) throw new Error(data.error ?? 'Textbelt send failed');
}

function formatShiftDate(dateStr: string, lang: 'en' | 'es'): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const dayName = d.toLocaleDateString(locale, { weekday: 'long' });
  const dateFormatted = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${dayName}, ${dateFormatted}`;
}

// Normalise the raw reply text for matching
function normalise(text: string): string {
  return text.trim().toUpperCase().replace(/[.!?¿¡]/g, '').trim();
}

const YES_SET = new Set(['YES', 'Y', 'SI', 'SÍ', 'SÌ', 'S']);
const NO_SET  = new Set(['NO', 'N']);
const ES_SET  = new Set(['ESPANOL', 'ESPAÑOL', 'SPANISH', 'ESP']);
const EN_SET  = new Set(['ENGLISH', 'INGLES', 'INGLÉS', 'EN']);

export async function POST(req: NextRequest) {
  try {
    // Textbelt sends JSON: { fromNumber, text, textId }
    // Some versions send form-encoded; handle both.
    let fromNumber: string | undefined;
    let text: string | undefined;

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await req.json() as { fromNumber?: string; text?: string };
      fromNumber = body.fromNumber;
      text = body.text;
    } else {
      const form = await req.formData();
      fromNumber = form.get('fromNumber') as string | undefined ?? undefined;
      text = form.get('text') as string | undefined ?? undefined;
    }

    if (!fromNumber || !text) {
      return NextResponse.json({ ok: true }); // Always 200 to prevent Textbelt retries
    }

    const phone164 = toE164(fromNumber);
    if (!phone164) return NextResponse.json({ ok: true });

    const reply = normalise(text);
    const db = admin.firestore();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://hotelops-ai.vercel.app';
    const replyWebhookUrl = `${baseUrl}/api/sms-reply`;

    // ── Find the most recent pending availability check for this phone ──────
    // Try raw fromNumber first, then E164, so we match however the phone was stored.
    async function findCheck(phoneVariant: string) {
      return db
        .collectionGroup('nightlyAvailabilityChecks')
        .where('staffPhone', '==', phoneVariant)
        .where('status', '==', 'pending')
        .orderBy('sentAt', 'desc')
        .limit(1)
        .get();
    }

    let snap = await findCheck(fromNumber);
    if (snap.empty && phone164 !== fromNumber) {
      snap = await findCheck(phone164);
    }

    if (snap.empty) {
      // No pending check — ignore (could be an old reply or spam)
      return NextResponse.json({ ok: true });
    }

    const checkDoc = snap.docs[0];
    const checkData = checkDoc.data() as {
      uid: string;
      pid: string;
      staffId: string;
      staffName: string;
      staffPhone: string;
      shiftDate: string;
      language: 'en' | 'es';
    };
    const { uid, pid, staffId, staffName, shiftDate } = checkData;
    const lang: 'en' | 'es' = checkData.language ?? 'en';
    const firstName = (staffName ?? 'there').split(' ')[0];

    // ── ESPAÑOL — save preference and resend in Spanish ───────────────────
    if (ES_SET.has(reply)) {
      await db.collection('staffPrefs').doc(staffId).set(
        { language: 'es', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );

      await checkDoc.ref.update({ language: 'es' });

      const dateLabel = formatShiftDate(shiftDate, 'es');
      const esMsg =
        `Hola ${firstName}! ¿Puedes venir mañana (${dateLabel})?\n` +
        `Responde SÍ o NO.\n\nFor English, reply ENGLISH\n– HotelOps`;

      await sendSms(phone164, esMsg, replyWebhookUrl);
      return NextResponse.json({ ok: true });
    }

    // ── ENGLISH — switch back to English ─────────────────────────────────
    if (EN_SET.has(reply)) {
      await db.collection('staffPrefs').doc(staffId).set(
        { language: 'en', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );

      await checkDoc.ref.update({ language: 'en' });

      const dateLabel = formatShiftDate(shiftDate, 'en');
      const enMsg =
        `Hi ${firstName}! Can you come in tomorrow (${dateLabel})?\n` +
        `Reply YES or NO.\n\nPara español, responde ESPAÑOL\n– HotelOps`;

      await sendSms(phone164, enMsg, replyWebhookUrl);
      return NextResponse.json({ ok: true });
    }

    // ── YES — confirm and send room assignment ────────────────────────────
    if (YES_SET.has(reply)) {
      await checkDoc.ref.update({
        status: 'confirmed',
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const hkUrl = `${baseUrl}/housekeeper/${staffId}`;

      // Best-effort: look up any room assignments already saved by the scheduler
      let assignedRooms: string[] = [];
      let assignedAreas: string[] = [];
      try {
        const scSnap = await db
          .collectionGroup('shiftConfirmations')
          .where('staffId', '==', staffId)
          .where('shiftDate', '==', shiftDate)
          .limit(1)
          .get();
        if (!scSnap.empty) {
          const scData = scSnap.docs[0].data();
          assignedRooms = (scData.assignedRooms as string[] | undefined) ?? [];
          assignedAreas = (scData.assignedAreas as string[] | undefined) ?? [];
        }
      } catch {
        // Non-fatal — send confirmation without room list
      }

      let confirmMsg: string;
      if (lang === 'es') {
        confirmMsg = `✅ ¡Confirmado, ${firstName}!`;
        if (assignedRooms.length > 0) confirmMsg += `\nHabitaciones: ${assignedRooms.join(', ')}`;
        if (assignedAreas.length > 0) confirmMsg += `\nÁreas: ${assignedAreas.join(', ')}`;
        confirmMsg += `\nTu enlace: ${hkUrl}\n– HotelOps`;
      } else {
        confirmMsg = `✅ Got it, ${firstName}! See you tomorrow.`;
        if (assignedRooms.length > 0) confirmMsg += `\nRooms: ${assignedRooms.join(', ')}`;
        if (assignedAreas.length > 0) confirmMsg += `\nAreas: ${assignedAreas.join(', ')}`;
        confirmMsg += `\nYour link: ${hkUrl}\n– HotelOps`;
      }

      await sendSms(phone164, confirmMsg);

      // Notify manager
      await db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('managerNotifications')
        .add({
          uid, pid,
          type: 'availability_confirmed',
          message: `${staffName} confirmed availability for ${shiftDate}`,
          staffId, staffName, shiftDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return NextResponse.json({ ok: true });
    }

    // ── NO — acknowledge, notify manager, cascade ─────────────────────────
    if (NO_SET.has(reply)) {
      await checkDoc.ref.update({
        status: 'declined',
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const ackMsg = lang === 'es'
        ? `Entendido, ${firstName}. No te preocupes.\n– HotelOps`
        : `No problem, ${firstName}. We'll find cover.\n– HotelOps`;
      await sendSms(phone164, ackMsg);

      const notifRef = db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('managerNotifications');

      await notifRef.add({
        uid, pid,
        type: 'availability_declined',
        message: `${staffName} can't come in on ${shiftDate}`,
        staffId, staffName, shiftDate,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ── Cascade: find next eligible staff not yet asked ──────────────────
      type StaffDoc = {
        id: string;
        isActive?: boolean;
        phone?: string;
        vacationDates?: string[];
        maxDaysPerWeek?: number;
        daysWorkedThisWeek?: number;
        name?: string;
        [key: string]: unknown;
      };

      const [staffSnap, allChecksSnap] = await Promise.all([
        db.collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('staff')
          .where('isActive', '!=', false)
          .get(),
        db.collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('nightlyAvailabilityChecks')
          .where('shiftDate', '==', shiftDate)
          .get(),
      ]);

      const alreadyAsked = new Set(
        allChecksSnap.docs.map(d => d.data().staffId as string),
      );

      const eligible: StaffDoc[] = staffSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as StaffDoc))
        .filter(s => {
          if (s.isActive === false) return false;
          if (!s.phone) return false;
          if (alreadyAsked.has(s.id)) return false;
          if ((s.vacationDates as string[] | undefined)?.includes(shiftDate)) return false;
          const maxDays = (s.maxDaysPerWeek as number | undefined) ?? 5;
          if (((s.daysWorkedThisWeek as number | undefined) ?? 0) >= maxDays) return false;
          return true;
        })
        .sort((a, b) =>
          ((a.daysWorkedThisWeek as number) ?? 0) - ((b.daysWorkedThisWeek as number) ?? 0),
        );

      if (eligible.length === 0) {
        await notifRef.add({
          uid, pid,
          type: 'no_replacement',
          message: `No more eligible staff to ask for ${shiftDate} — everyone has been contacted or is at their limit`,
          shiftDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const next = eligible[0];
        const nextPhone164 = toE164(next.phone as string);
        if (nextPhone164) {
          const prefSnap = await db.collection('staffPrefs').doc(next.id).get();
          const nextLang: 'en' | 'es' = prefSnap.exists
            ? (prefSnap.data() as { language?: 'en' | 'es' }).language ?? 'en'
            : 'en';
          const nextFirstName = ((next.name as string) ?? 'there').split(' ')[0];
          const dateLabel = formatShiftDate(shiftDate, nextLang);

          const nextMsg = nextLang === 'es'
            ? `Hola ${nextFirstName}! ¿Puedes venir mañana (${dateLabel})?\nResponde SÍ o NO.\n– HotelOps`
            : `Hi ${nextFirstName}! Can you come in tomorrow (${dateLabel})?\nReply YES or NO.\n\nPara español, responde ESPAÑOL\n– HotelOps`;

          const newCheckRef = db
            .collection('users').doc(uid)
            .collection('properties').doc(pid)
            .collection('nightlyAvailabilityChecks')
            .doc(`${shiftDate}_${next.id}`);

          await newCheckRef.set({
            uid, pid,
            staffId: next.id,
            staffName: next.name ?? '',
            staffPhone: next.phone,
            shiftDate,
            language: nextLang,
            status: 'pending',
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            respondedAt: null,
            smsSent: false,
          });

          try {
            await sendSms(nextPhone164, nextMsg, replyWebhookUrl);
            await newCheckRef.update({ smsSent: true });
          } catch (smsErr) {
            console.error('Cascade SMS failed:', smsErr);
            await newCheckRef.update({ smsError: String(smsErr) });
          }

          await notifRef.add({
            uid, pid,
            type: 'cascade_sent',
            message: `Sent availability check to ${next.name as string} for ${shiftDate} (replacing ${staffName})`,
            replacementName: next.name,
            staffName,
            shiftDate,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      return NextResponse.json({ ok: true });
    }

    // ── Unrecognised reply ────────────────────────────────────────────────
    const hint = lang === 'es'
      ? `No entendí eso. Por favor responde SÍ o NO.\n– HotelOps`
      : `Didn't catch that. Please reply YES or NO.\n– HotelOps`;
    await sendSms(phone164, hint);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('sms-reply error:', err);
    // Always return 200 so Textbelt doesn't retry
    return NextResponse.json({ ok: true });
  }
}
