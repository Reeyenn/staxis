import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

// Public endpoint - returns scheduled staff for a given property so
// housekeepers can register their device without needing an account.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const uid = searchParams.get('uid');
  const pid = searchParams.get('pid');

  if (!uid || !pid) {
    return NextResponse.json({ error: 'Missing uid or pid' }, { status: 400 });
  }

  const snap = await admin.firestore()
    .collection('users').doc(uid)
    .collection('properties').doc(pid)
    .collection('staff')
    .get();

  const staff = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter((s: any) => s.scheduledToday);

  return NextResponse.json(staff);
}
