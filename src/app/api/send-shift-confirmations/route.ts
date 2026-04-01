import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

interface StaffEntry {
  staffId: string;
  name: string;
  phone: string;
  language: 'en' | 'es';
  assignedRooms?: string[];   // room numbers assigned to this HK
  assignedAreas?: string[];   // public area names assigned to this HK
}

interface RequestBody {
  uid: string;
  pid: string;
  shiftDate: string;   // YYYY-MM-DD
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
  return `${dayName} ${dateFormatted}`;
}

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { uid, pid, shiftDate, baseUrl, staff } = body;

    if (!uid || !pid || !shiftDate || !staff?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = admin.firestore();

    const results = await Promise.allSettled(
      staff.map(async ({ staffId, name, phone, language, assignedRooms, assignedAreas }) => {
        const token = randomUUID();
        const phone164 = toE164(phone);
        if (!phone164) throw new Error(`Invalid phone number: ${phone}`);

        const rooms  = assignedRooms ?? [];
        const areas  = assignedAreas ?? [];
        const hkUrl  = `${baseUrl}/housekeeper/${staffId}`;

        // Store confirmation doc with room + area assignments so the
        // post-confirm SMS can include the full list.
        await db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('shiftConfirmations').doc(token)
          .set({
            uid,
            pid,
            staffId,
            staffName: name,
            staffPhone: phone,
            shiftDate,
            status: 'pending',
            language,
            assignedRooms:  rooms,
            assignedAreas:  areas,
            hkUrl,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            respondedAt: null,
            smsSent: false,
          });

        const dateLabel   = formatShiftDate(shiftDate, language);
        const confirmUrl  = `${baseUrl}/confirm/${token}?uid=${uid}&pid=${pid}`;
        const firstName   = name.split(' ')[0];

        // Availability check — mention room count so they know what to expect.
        const roomCount  = rooms.length;
        const areaCount  = areas.length;
        const workSummary = language === 'es'
          ? `${roomCount} hab.${areaCount > 0 ? ` + ${areaCount} área(s)` : ''}`
          : `${roomCount} room${roomCount !== 1 ? 's' : ''}${areaCount > 0 ? ` + ${areaCount} area${areaCount !== 1 ? 's' : ''}` : ''}`;

        const message = language === 'es'
          ? `Hola ${firstName} 👋 ¿Puedes venir mañana (${dateLabel})? Tendrías ${workSummary}. Confirma: ${confirmUrl} – Comfort Suites`
          : `Hi ${firstName} 👋 Can you come in tomorrow (${dateLabel})? You'd have ${workSummary}. Confirm: ${confirmUrl} – Comfort Suites`;

        await sendSms(phone164, message);

        await db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('shiftConfirmations').doc(token)
          .update({ smsSent: true });

        return { staffId, token };
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    const tokens = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Confirmation SMS failed for ${staff[i].name} (${staff[i].phone}):`, r.reason);
      }
    });

    return NextResponse.json({ sent, failed, tokens });
  } catch (err) {
    console.error('send-shift-confirmations error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
