/**
 * POST /api/admin/normalize-confirmation-phones
 *
 * One-off migration. Walks every pending `shiftConfirmations` doc and rewrites
 * `staffPhone` to E.164 if it isn't already. Needed because the first version
 * of /api/send-shift-confirmations stored whatever the user typed (e.g.
 * "4098282023", "(409) 828-2023") which the SMS-reply lookup can't always
 * match against Twilio's E.164 `From`.
 *
 * Safe to call repeatedly. Returns counts so you can see what it did.
 */
import { NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

function toE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST() {
  try {
    const db = admin.firestore();
    // Pull every shiftConfirmation (no status filter → no composite index needed).
    const snap = await db.collectionGroup('shiftConfirmations').get();

    let scanned = 0;
    let rewritten = 0;
    let skipped = 0;
    let nonPending = 0;
    const examples: Array<{ from: string; to: string; status: string }> = [];

    const batch = db.batch();
    snap.docs.forEach(doc => {
      scanned += 1;
      const data = doc.data();
      const status = (data.status ?? 'pending') as string;
      if (status !== 'pending') { nonPending += 1; return; }

      const current = (data.staffPhone ?? '') as string;
      const normalized = toE164(current);
      if (!normalized) { skipped += 1; return; }
      if (normalized === current) { skipped += 1; return; }
      batch.update(doc.ref, { staffPhone: normalized });
      rewritten += 1;
      if (examples.length < 10) examples.push({ from: current, to: normalized, status });
    });

    if (rewritten > 0) await batch.commit();

    return NextResponse.json({ scanned, nonPending, rewritten, skipped, examples });
  } catch (err) {
    console.error('normalize-confirmation-phones error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  // Easier to trigger from a browser — same behaviour as POST.
  return POST();
}
