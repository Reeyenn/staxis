/**
 * POST /api/sync-room-assignments
 *
 * Mirrors the room-level `assignedTo`/`assignedName` writes that
 * /api/send-shift-confirmations does — BUT without sending any SMS or
 * touching shiftConfirmations.
 *
 * Called by the Schedule tab's debounced autosave so that every drag-and-drop
 * change is reflected on the `rooms` docs themselves in real time. This fixes
 * the bug where clicking the crew-row "Link" button before hitting Send would
 * open the HK's page with stale (or no) rooms — because the HK page queries
 * `collectionGroup('rooms') where assignedTo == staffId` and only the Send
 * flow used to write that field.
 *
 * Body:
 *   {
 *     uid, pid, shiftDate,                    // required
 *     staff: [
 *       { staffId, staffName, assignedRooms }  // room NUMBERS, same shape Send uses
 *     ]
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { isValidDateStr } from '@/lib/utils';

interface StaffEntry {
  staffId: string;
  staffName: string;
  assignedRooms?: string[];
}

interface RequestBody {
  uid: string;
  pid: string;
  shiftDate: string;
  staff: StaffEntry[];
}

function deriveRoomType(
  number: string,
  snapData: { rooms?: Array<{ number: string; stayType?: string | null }> } | null,
): 'checkout' | 'stayover' {
  if (!snapData?.rooms) return 'checkout';
  const match = snapData.rooms.find(r => r.number === number);
  if (!match) return 'checkout';
  return match.stayType === 'Stay' ? 'stayover' : 'checkout';
}

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { uid, pid, shiftDate, staff } = body;

    if (!uid || !pid || !shiftDate || !Array.isArray(staff)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidDateStr(shiftDate)) {
      return NextResponse.json({ error: 'Invalid shiftDate' }, { status: 400 });
    }

    // ── Failsafe: refuse to wipe all assignments without explicit opt-in ────
    // A buggy client that sends an empty staff list would otherwise blank
    // every assignment for the day. Require `allowClearAll: true` to mean it.
    const hasAnyAssignment = staff.some(s => (s.assignedRooms ?? []).length > 0);
    const allowClearAll = (body as { allowClearAll?: boolean }).allowClearAll === true;
    if (!hasAnyAssignment && !allowClearAll) {
      return NextResponse.json({
        error: 'Refusing to clear all room assignments without allowClearAll=true',
      }, { status: 400 });
    }

    const db = admin.firestore();

    // Pull plan snapshot so we can seed any new (future-date) rooms with the
    // correct checkout/stayover flag — same behavior as send-shift-confirmations.
    const planSnap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('planSnapshots').doc(shiftDate)
      .get();
    const planSnapData = planSnap.exists
      ? (planSnap.data() as { rooms?: Array<{ number: string; stayType?: string | null }> })
      : null;

    // Build the (roomNumber → who) map.
    const assignmentMap = new Map<string, { staffId: string; staffName: string }>();
    for (const entry of staff) {
      for (const num of (entry.assignedRooms ?? [])) {
        assignmentMap.set(num, { staffId: entry.staffId, staffName: entry.staffName });
      }
    }

    const roomsForDate = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('rooms')
      .where('date', '==', shiftDate)
      .get();

    const existingByNumber = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    roomsForDate.forEach(doc => {
      const num = (doc.data().number ?? '') as string;
      if (num) existingByNumber.set(num, doc);
    });

    const batch = db.batch();
    let writes = 0;

    // Upsert assigned rooms
    for (const [num, who] of assignmentMap) {
      const docId = `${shiftDate}_${num}`;
      const ref = db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('rooms').doc(docId);

      const existing = existingByNumber.get(num);
      if (existing) {
        const data = existing.data();
        // Only write if something actually changed — saves writes.
        if (data.assignedTo !== who.staffId || data.assignedName !== who.staffName) {
          batch.update(ref, {
            assignedTo: who.staffId,
            assignedName: who.staffName,
          });
          writes++;
        }
      } else {
        batch.set(ref, {
          number: num,
          type: deriveRoomType(num, planSnapData),
          status: 'dirty',
          priority: 'standard',
          date: shiftDate,
          propertyId: pid,
          assignedTo: who.staffId,
          assignedName: who.staffName,
          _seededBy: 'sync-room-assignments',
          _seededAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        writes++;
      }
    }

    // Clear assignments on rooms that USED to be assigned but aren't anymore.
    for (const [num, doc] of existingByNumber) {
      if (assignmentMap.has(num)) continue;
      const data = doc.data();
      if (data.assignedTo) {
        batch.update(doc.ref, { assignedTo: null, assignedName: null });
        writes++;
      }
    }

    if (writes > 0) await batch.commit();

    return NextResponse.json({ ok: true, writes });
  } catch (err) {
    console.error('sync-room-assignments error:', err);
    try {
      await admin.firestore().collection('errorLogs').add({
        route: '/api/sync-room-assignments',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack ?? null : null,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch {}
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
