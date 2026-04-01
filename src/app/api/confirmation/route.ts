import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
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
  return `${dayName} ${dateFormatted}`;
}

// GET — load confirmation data for the HK confirm page (no auth required)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');
    const uid = searchParams.get('uid');
    const pid = searchParams.get('pid');

    if (!token || !uid || !pid) {
      return NextResponse.json({ error: 'Missing token, uid, or pid' }, { status: 400 });
    }

    const db = admin.firestore();
    const snap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('shiftConfirmations').doc(token)
      .get();

    if (!snap.exists) {
      return NextResponse.json({ error: 'Confirmation not found' }, { status: 404 });
    }

    const data = snap.data()!;
    return NextResponse.json({
      staffName: data.staffName as string,
      shiftDate: data.shiftDate as string,
      status: data.status as string,
      language: data.language as 'en' | 'es',
    });
  } catch (err) {
    console.error('confirmation GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST — handle HK yes/no response, with decline cascade
export async function POST(req: NextRequest) {
  try {
    const { token, uid, pid, response } = await req.json() as {
      token: string;
      uid: string;
      pid: string;
      response: 'confirmed' | 'declined';
    };

    if (!token || !uid || !pid || !response) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = admin.firestore();
    const confirmRef = db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('shiftConfirmations').doc(token);

    const snap = await confirmRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Confirmation not found' }, { status: 404 });
    }

    const data = snap.data()!;

    // Already responded — idempotent
    if (data.status !== 'pending') {
      return NextResponse.json({ ok: true, alreadyResponded: true });
    }

    await confirmRef.update({
      status: response,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const notifRef = db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('managerNotifications');

    if (response === 'confirmed') {
      // ── Follow-up SMS: room list + personal app link ─────────────────────
      const rooms     = (data.assignedRooms as string[] | undefined) ?? [];
      const areas     = (data.assignedAreas as string[] | undefined) ?? [];
      const hkUrl     = (data.hkUrl as string | undefined) ?? '';
      const lang      = (data.language as 'en' | 'es' | undefined) ?? 'en';
      const firstName = (data.staffName as string).split(' ')[0];
      const phone164  = toE164(data.staffPhone as string);

      if (phone164 && (rooms.length > 0 || areas.length > 0)) {
        let followUp: string;
        if (lang === 'es') {
          followUp = `✅ ¡Confirmado, ${firstName}! Mañana te toca:`;
          if (rooms.length > 0) followUp += `\nHabitaciones: ${rooms.join(', ')}`;
          if (areas.length > 0) followUp += `\nÁreas: ${areas.join(', ')}`;
          if (hkUrl)            followUp += `\nTu enlace: ${hkUrl}`;
          followUp += `\n– Comfort Suites`;
        } else {
          followUp = `✅ Confirmed, ${firstName}! Here's your assignment for tomorrow:`;
          if (rooms.length > 0) followUp += `\nRooms: ${rooms.join(', ')}`;
          if (areas.length > 0) followUp += `\nAreas: ${areas.join(', ')}`;
          if (hkUrl)            followUp += `\nYour link: ${hkUrl}`;
          followUp += `\n– Comfort Suites`;
        }
        try {
          await sendSms(phone164, followUp);
        } catch (smsErr) {
          console.error('Follow-up SMS failed:', smsErr);
          // Non-fatal — confirmation is already saved
        }
      }

      // ── Check if everyone has confirmed ──────────────────────────────────
      const allSnap = await db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('shiftConfirmations')
        .where('shiftDate', '==', data.shiftDate)
        .get();

      const statuses = allSnap.docs.map(d => d.data().status as string);
      const allConfirmed = statuses.length > 0 && statuses.every(s => s === 'confirmed');

      if (allConfirmed) {
        await notifRef.add({
          uid, pid,
          type: 'all_confirmed',
          message: `All ${statuses.length} housekeepers confirmed for ${data.shiftDate}`,
          shiftDate: data.shiftDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } else {
      // Declined — notify manager and find cascade replacement
      await notifRef.add({
        uid, pid,
        type: 'decline',
        message: `${data.staffName} can't make it on ${data.shiftDate}`,
        staffName: data.staffName,
        shiftDate: data.shiftDate,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Load staff + existing confirmations for this date
      const [staffSnap, confirmsSnap] = await Promise.all([
        db.collection('users').doc(uid).collection('properties').doc(pid).collection('staff').get(),
        db.collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('shiftConfirmations')
          .where('shiftDate', '==', data.shiftDate)
          .get(),
      ]);

      // Staff already in the confirmation pool (not declined)
      const alreadyInPool = new Set(
        confirmsSnap.docs
          .filter(d => d.data().status !== 'declined')
          .map(d => d.data().staffId as string)
      );

      type StaffDoc = {
        id: string;
        isActive?: boolean;
        phone?: string;
        vacationDates?: string[];
        maxDaysPerWeek?: number;
        maxWeeklyHours?: number;
        daysWorkedThisWeek?: number;
        weeklyHours?: number;
        language?: 'en' | 'es';
        name?: string;
        [key: string]: unknown;
      };

      const eligible: StaffDoc[] = staffSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as StaffDoc))
        .filter(s => {
          if (s.isActive === false) return false;
          if (!s.phone) return false;
          if (alreadyInPool.has(s.id)) return false;
          if (s.vacationDates?.includes(data.shiftDate as string)) return false;
          const maxDays = s.maxDaysPerWeek ?? 5;
          const maxHrs  = s.maxWeeklyHours ?? 40;
          if ((s.daysWorkedThisWeek ?? 0) >= maxDays) return false;
          if ((s.weeklyHours ?? 0) >= maxHrs) return false;
          return true;
        })
        .sort((a, b) => (a.daysWorkedThisWeek ?? 0) - (b.daysWorkedThisWeek ?? 0));

      if (eligible.length === 0) {
        await notifRef.add({
          uid, pid,
          type: 'no_replacement',
          message: `No replacement found for ${data.shiftDate} — all eligible staff are at their limit`,
          staffName: data.staffName,
          shiftDate: data.shiftDate,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const replacement = eligible[0];
        const phone164 = toE164(replacement.phone as string);

        if (phone164) {
          const newToken = randomUUID();
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://hotelops-ai.vercel.app';
          const confirmUrl = `${baseUrl}/confirm/${newToken}?uid=${uid}&pid=${pid}`;
          const lang = (replacement.language as 'en' | 'es' | undefined) ?? 'en';
          const dateLabel = formatShiftDate(data.shiftDate as string, lang);
          const firstName = (replacement.name as string).split(' ')[0];

          const message = lang === 'es'
            ? `Hola ${firstName}, estás programada para el ${dateLabel}. Confirma aquí: ${confirmUrl} – Comfort Suites`
            : `Hi ${firstName}, you're scheduled for ${dateLabel}. Confirm: ${confirmUrl} – Comfort Suites`;

          await db
            .collection('users').doc(uid)
            .collection('properties').doc(pid)
            .collection('shiftConfirmations').doc(newToken)
            .set({
              uid, pid,
              staffId: replacement.id,
              staffName: replacement.name,
              staffPhone: replacement.phone,
              shiftDate: data.shiftDate,
              status: 'pending',
              language: lang,
              sentAt: admin.firestore.FieldValue.serverTimestamp(),
              respondedAt: null,
              smsSent: false,
            });

          try {
            await sendSms(phone164, message);
            await db
              .collection('users').doc(uid)
              .collection('properties').doc(pid)
              .collection('shiftConfirmations').doc(newToken)
              .update({ smsSent: true });
          } catch (smsErr) {
            console.error('Replacement SMS failed:', smsErr);
            await db
              .collection('users').doc(uid)
              .collection('properties').doc(pid)
              .collection('shiftConfirmations').doc(newToken)
              .update({ smsError: String(smsErr) });
          }

          await notifRef.add({
            uid, pid,
            type: 'replacement_found',
            message: `${replacement.name as string} was offered the shift on ${data.shiftDate as string} (replacing ${data.staffName as string})`,
            staffName: data.staffName,
            replacementName: replacement.name,
            shiftDate: data.shiftDate,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('confirmation POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
