/**
 * GET /api/admin/diagnose?uid=&pid=
 *
 * Read-only snapshot for debugging the SMS flow:
 *   - Last 20 webhookLog entries (every inbound SMS hit and its lookup result)
 *   - Last 10 shiftConfirmations for the given uid/pid (status + staffPhone)
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get('uid');
    const pid = url.searchParams.get('pid');
    if (!uid || !pid) {
      return NextResponse.json({ error: 'need ?uid=&pid=' }, { status: 400 });
    }

    const db = admin.firestore();

    const [logSnap, confSnap] = await Promise.all([
      db.collection('webhookLog').orderBy('ts', 'desc').limit(20).get(),
      db.collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('shiftConfirmations').get(),
    ]);

    const logs = logSnap.docs.map(d => {
      const x = d.data();
      return {
        ...x,
        ts: x.ts?.toDate?.()?.toISOString() ?? null,
      };
    });

    const confs = confSnap.docs.map(d => {
      const x = d.data();
      return {
        docId: d.id,
        staffName: x.staffName,
        staffPhone: x.staffPhone,
        status: x.status,
        shiftDate: x.shiftDate,
        sentAt: x.sentAt?.toDate?.()?.toISOString() ?? null,
        respondedAt: x.respondedAt?.toDate?.()?.toISOString() ?? null,
      };
    }).sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')).slice(0, 10);

    return NextResponse.json({ webhookLogs: logs, confirmations: confs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
