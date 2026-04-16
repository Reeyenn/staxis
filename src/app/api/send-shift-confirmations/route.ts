/**
 * POST /api/send-shift-confirmations
 *
 * Called by the Housekeeping → Schedule tab's "Send" button.
 * For each selected housekeeper, sends a simple YES/NO availability text and
 * stores a `shiftConfirmations` doc so /api/sms-reply can look up the reply.
 *
 * The follow-up message after YES (with their personal link) is sent by
 * /api/sms-reply, NOT by this route.
 *
 * Body:
 *   {
 *     uid, pid, shiftDate,                    // required
 *     baseUrl,                                // required — used to build hkUrl
 *     staff: [
 *       {
 *         staffId, name, phone, language,     // required
 *         assignedRooms?: string[],           // room numbers for this HK
 *         assignedAreas?: string[],           // public areas for this HK
 *       },
 *       ...
 *     ]
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';
import { isValidDateStr } from '@/lib/utils';

interface StaffEntry {
  staffId: string;
  name: string;
  phone: string;
  language: 'en' | 'es';
  assignedRooms?: string[];
  assignedAreas?: string[];
}

interface RequestBody {
  uid: string;
  pid: string;
  shiftDate: string;
  baseUrl: string;
  staff: StaffEntry[];
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

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { uid, pid, shiftDate, baseUrl, staff } = body;

    if (!uid || !pid || !shiftDate || !staff?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidDateStr(shiftDate)) {
      return NextResponse.json({ error: 'Invalid shiftDate (expected YYYY-MM-DD)' }, { status: 400 });
    }

    const db = admin.firestore();

    const propSnap = await db.collection('users').doc(uid).collection('properties').doc(pid).get();
    const hotelName = propSnap.data()?.name || 'Your Hotel';

    const results = await Promise.allSettled(
      staff.map(async ({ staffId, name, phone, language, assignedRooms, assignedAreas }) => {
        const phone164 = toE164(phone);
        if (!phone164) throw new Error(`Invalid phone: ${phone}`);

        const rooms = assignedRooms ?? [];
        const areas = assignedAreas ?? [];
        const hkUrl = `${baseUrl}/housekeeper/${staffId}`;

        // One shiftConfirmation per (shiftDate, staffId). Deterministic ID so
        // re-clicking Send doesn't create duplicates — it refreshes the doc.
        const docId = `${shiftDate}_${staffId}`;
        const confirmRef = db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('shiftConfirmations').doc(docId);

        await confirmRef.set({
          uid, pid,
          staffId,
          staffName: name,
          staffPhone: phone164,
          shiftDate,
          status: 'pending',       // pending | confirmed | declined
          language,
          assignedRooms: rooms,
          assignedAreas: areas,
          hkUrl,
          hotelName,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          respondedAt: null,
          smsSent: false,
        });

        const firstName = name.split(' ')[0];
        const dateLabel = formatShiftDate(shiftDate, language);

        const message = language === 'es'
          ? `Hola ${firstName}! ¿Puedes venir mañana (${dateLabel})?\nResponde SÍ o NO.\n\nFor English, reply ENGLISH\n– ${hotelName}`
          : `Hi ${firstName}! Can you come in tomorrow (${dateLabel})?\nReply YES or NO.\n\nPara español, responde ESPAÑOL\n– ${hotelName}`;

        await sendSms(phone164, message);
        await confirmRef.update({ smsSent: true });

        return { staffId, docId };
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`send-shift-confirmations failed for ${staff[i].name}:`, r.reason);
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    console.error('send-shift-confirmations error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
