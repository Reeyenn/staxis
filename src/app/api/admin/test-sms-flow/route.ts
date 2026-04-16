/**
 * POST /api/admin/test-sms-flow
 *
 * Standalone end-to-end tester for the YES/NO flow. Creates a single
 * shiftConfirmation doc under a known uid/pid/staffId, fires the SMS,
 * and returns the doc ID so you can watch it flip when you reply.
 *
 * Body:
 *   { uid, pid, phone, language?, name? }
 *
 * Deliberately NOT gated — safe to ship because it only writes a pending
 * doc and sends one text. Delete this route once the flow is verified.
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      uid?: string; pid?: string; phone?: string;
      language?: 'en' | 'es'; name?: string;
    };
    const { uid, pid, phone } = body;
    const language = body.language ?? 'en';
    const name = body.name ?? 'Test';

    if (!uid || !pid || !phone) {
      return NextResponse.json({ error: 'Need uid, pid, phone' }, { status: 400 });
    }
    const phone164 = toE164(phone);
    if (!phone164) {
      return NextResponse.json({ error: `Can't normalize phone ${phone} to E.164` }, { status: 400 });
    }

    const db = admin.firestore();
    const propSnap = await db.collection('users').doc(uid).collection('properties').doc(pid).get();
    const hotelName = propSnap.data()?.name || 'the hotel';

    // Synthetic staffId — unique per test run. Not tied to any real staff doc.
    const staffId = `test_${Date.now()}`;
    const shiftDate = new Date().toISOString().slice(0, 10); // today
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
      status: 'pending',
      language,
      assignedRooms: [],
      assignedAreas: [],
      hkUrl: '',
      hotelName,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      respondedAt: null,
      smsSent: false,
      isTest: true,
    });

    const message = language === 'es'
      ? `[TEST] Hola ${name}! ¿Puedes venir mañana?\nResponde SÍ o NO.\n– ${hotelName}`
      : `[TEST] Hi ${name}! Can you come in tomorrow?\nReply YES or NO.\n– ${hotelName}`;

    await sendSms(phone164, message);
    await confirmRef.update({ smsSent: true });

    return NextResponse.json({
      ok: true,
      docPath: `users/${uid}/properties/${pid}/shiftConfirmations/${docId}`,
      staffPhone: phone164,
      instructions: 'Reply YES or NO to the text you just got. Then GET this same URL again with ?check=' + docId + ' to see the doc status.',
    });
  } catch (err) {
    console.error('test-sms-flow error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // ?check=<docId> → return the current status of that doc.
  const url = new URL(req.url);
  const check = url.searchParams.get('check');
  const uid = url.searchParams.get('uid');
  const pid = url.searchParams.get('pid');
  if (!check || !uid || !pid) {
    return NextResponse.json({ error: 'Need ?check=<docId>&uid=<>&pid=<>' }, { status: 400 });
  }
  const db = admin.firestore();
  const snap = await db
    .collection('users').doc(uid)
    .collection('properties').doc(pid)
    .collection('shiftConfirmations').doc(check).get();
  if (!snap.exists) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const d = snap.data()!;
  return NextResponse.json({
    status: d.status,
    staffPhone: d.staffPhone,
    respondedAt: d.respondedAt?.toDate?.()?.toISOString() ?? null,
  });
}
