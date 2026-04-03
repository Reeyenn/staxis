import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

export async function POST(req: NextRequest) {
  // Guard: admin SDK must be initialized (requires server env vars)
  if (!admin.apps.length) {
    console.error('save-fcm-token: Firebase Admin SDK not initialized');
    return NextResponse.json(
      { error: 'Server not configured - token could not be saved' },
      { status: 503 }
    );
  }

  const { uid, pid, staffId, token } = await req.json();
  if (!uid || !pid || !staffId || !token) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  await admin.firestore()
    .collection('users').doc(uid)
    .collection('properties').doc(pid)
    .collection('staff').doc(staffId)
    .update({ fcmToken: token });

  return NextResponse.json({ ok: true });
}
