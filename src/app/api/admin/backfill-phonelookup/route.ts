/**
 * GET or POST /api/admin/backfill-phonelookup
 *
 * One-off backfill. Walks every `shiftConfirmations` doc across every user
 * /property and, for any PENDING one, writes a top-level `phoneLookup/{phone}`
 * pointing to that doc. Multiple pending rows for the same phone are resolved
 * by keeping the one with the latest `sentAt` — same rule the send endpoint
 * uses (last-write-wins by send time).
 *
 * Safe to call repeatedly. Returns counts + examples so you can verify.
 *
 * Uses a collectionGroup .get() with NO filters (always allowed — needs no
 * composite index). Filtering for `status === 'pending'` happens in memory.
 */
import { NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

export async function POST() {
  try {
    const db = admin.firestore();
    const snap = await db.collectionGroup('shiftConfirmations').get();

    // Group pending confirmations by staffPhone; keep the one with the
    // most-recent sentAt per phone.
    type Doc = {
      ref: FirebaseFirestore.DocumentReference;
      data: Record<string, unknown>;
      sentAtMs: number;
    };
    const latestByPhone = new Map<string, Doc>();

    snap.docs.forEach(doc => {
      const data = doc.data();
      if (data.status !== 'pending') return;
      const phone = (data.staffPhone ?? '') as string;
      if (!phone) return;
      const sentAt = (data.sentAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const prev = latestByPhone.get(phone);
      if (!prev || sentAt > prev.sentAtMs) {
        latestByPhone.set(phone, { ref: doc.ref, data, sentAtMs: sentAt });
      }
    });

    // Write each phoneLookup doc. Small volume — no batching needed for
    // correctness, but use a WriteBatch to keep it atomic-ish and fast.
    const batch = db.batch();
    const examples: Array<{ phone: string; path: string; status: string; sentAt: number }> = [];
    for (const [phone, entry] of latestByPhone) {
      batch.set(db.collection('phoneLookup').doc(phone), {
        path: entry.ref.path,
        uid: entry.data.uid,
        pid: entry.data.pid,
        staffId: entry.data.staffId,
        shiftDate: entry.data.shiftDate,
        backfilledAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (examples.length < 10) {
        examples.push({
          phone,
          path: entry.ref.path,
          status: entry.data.status as string,
          sentAt: entry.sentAtMs,
        });
      }
    }
    if (latestByPhone.size > 0) await batch.commit();

    return NextResponse.json({
      scanned: snap.size,
      pendingPhones: latestByPhone.size,
      examples,
    });
  } catch (err) {
    console.error('backfill-phonelookup error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
