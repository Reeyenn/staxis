import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

// One-time seed endpoint to populate Comfort Suites Beaumont staff roster.
// DELETE THIS AFTER USE.

const STAFF = [
  // Variable Housekeepers
  { name: 'Astri Ravanales',    department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Brenda Sandoval',    department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Erika Rivera',       department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Julia Jacinto',      department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Lucia Flores',       department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Maite Bulux',        department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Marisol Perez',      department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Mata Heriberto',     department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Yoselein Bulux',     department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper' },
  { name: 'Maria Posas',        department: 'housekeeping', language: 'es', isSenior: false, notes: 'Housekeeper (overtime proxy for Maria Castro)' },

  // Fixed Staff
  { name: 'Brittney Cobbs',     department: 'other',        language: 'en', isSenior: true,  notes: 'General Manager — covers 2-3 HK shifts when needed' },
  { name: 'Maria Castro',       department: 'housekeeping', language: 'es', isSenior: true,  notes: 'Head Housekeeper — supervises, does occasional tasks' },
  { name: 'Katherine White',    department: 'front_desk',   language: 'en', isSenior: false, notes: 'Front Desk' },
  { name: 'Mary Martinez',      department: 'front_desk',   language: 'en', isSenior: false, notes: 'Front Desk' },
  { name: 'Michelle Humphrey',  department: 'front_desk',   language: 'en', isSenior: false, notes: 'Front Desk' },
  { name: 'Shanequa Hamilton',  department: 'front_desk',   language: 'en', isSenior: false, notes: 'Front Desk Clerk' },
  { name: 'Sylvia Mata',        department: 'maintenance',  language: 'en', isSenior: false, notes: 'Maintenance' },
];

export async function POST(req: NextRequest) {
  const { uid, pid } = await req.json();

  if (!uid || !pid) {
    return NextResponse.json({ error: 'Missing uid or pid' }, { status: 400 });
  }

  const staffCol = admin.firestore()
    .collection('users').doc(uid)
    .collection('properties').doc(pid)
    .collection('staff');

  // Clear existing staff first
  const existing = await staffCol.get();
  if (existing.size > 0) {
    const deleteBatch = admin.firestore().batch();
    existing.docs.forEach(d => deleteBatch.delete(d.ref));
    await deleteBatch.commit();
  }

  const batch = admin.firestore().batch();
  const added: string[] = [];

  for (const s of STAFF) {
    const ref = staffCol.doc();
    batch.set(ref, {
      name: s.name,
      department: s.department,
      language: s.language,
      isSenior: s.isSenior,
      scheduledToday: false,
      weeklyHours: 0,
      maxWeeklyHours: 40,
      maxDaysPerWeek: 5,
      isActive: true,
    });
    added.push(s.name);
  }

  await batch.commit();

  return NextResponse.json({ success: true, added, count: added.length });
}
