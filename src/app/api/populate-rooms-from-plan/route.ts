/**
 * POST /api/populate-rooms-from-plan
 *
 * Manual "load all 74 rooms from the CSV" button on the Rooms tab.
 * Reads planSnapshots/{date} (the last CSV pull at 6am or 7pm) and seeds
 * every room in that snapshot into rooms/{date}_{roomNumber} so the Rooms
 * tab grid shows the full property, not just the 15 rooms Maria assigned.
 *
 * Behavior:
 *   • NEW doc (doesn't exist yet) → create with type + status from CSV
 *   • EXISTING doc → overwrite type + status from CSV, clear stale
 *     timestamps/notes; PRESERVE assignedTo/assignedName/isDnd/stayover*
 *     so Maria's Send-shift-confirmations work and HK progress are not lost.
 *
 * This endpoint is fired only when the user clicks the button. Nothing
 * calls it automatically.
 *
 * Body: { uid, pid, date }
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { isValidDateStr } from '@/lib/utils';

interface RequestBody {
  uid: string;
  pid: string;
  date: string;
}

// CSV room → Room.type
// Mirrors send-shift-confirmations' logic so both endpoints agree.
//   stayType === 'C/O'             → 'checkout'   (↗ icon)
//   status === 'OCC'               → 'stayover'   (🔒 icon; covers "Stay" AND
//                                                  arrivals where stayType is blank
//                                                  — both have a guest in-room)
//   VAC / OOO / anything else      → 'vacant'     (no icon)
function mapRoomType(
  stayType: string | null | undefined,
  status: string | null | undefined,
): 'checkout' | 'stayover' | 'vacant' {
  if (stayType === 'C/O') return 'checkout';
  if (status === 'OCC') return 'stayover';
  return 'vacant';
}

// CSV `condition` → RoomStatus. Anything other than a literal "Clean" is dirty.
function mapRoomStatus(condition: string | null | undefined): 'clean' | 'dirty' {
  return condition === 'Clean' ? 'clean' : 'dirty';
}

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { uid, pid, date } = body;

    if (!uid || !pid || !date) {
      return NextResponse.json({ error: 'Missing uid, pid, or date' }, { status: 400 });
    }
    if (!isValidDateStr(date)) {
      return NextResponse.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
    }

    const db = admin.firestore();

    // Pull the plan snapshot for this date — that's the last CSV pull.
    const planSnapRef = db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('planSnapshots').doc(date);
    const planSnap = await planSnapRef.get();

    if (!planSnap.exists) {
      return NextResponse.json(
        { error: `No planSnapshots/${date} doc found — no CSV has been pulled for that date yet.` },
        { status: 404 },
      );
    }

    const planData = planSnap.data() as {
      rooms?: Array<{
        number: string;
        roomType?: string;
        status?: string | null;          // OCC / VAC / OOO
        condition?: string | null;       // Clean / Dirty
        stayType?: string | null;        // "Stay" | "C/O" | null
        service?: string | null;         // Full / None (Choice brand cycle, ignored)
        stayoverDay?: number | null;
        stayoverMinutes?: number;
        arrival?: string | null;
      }>;
      pulledAt?: FirebaseFirestore.Timestamp;
    };
    const csvRooms = planData.rooms ?? [];

    if (csvRooms.length === 0) {
      return NextResponse.json(
        { error: `planSnapshots/${date} has no rooms array — CSV pull may have failed.` },
        { status: 404 },
      );
    }

    // Pull existing room docs for this date so we can preserve assignments.
    const existingSnap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('rooms')
      .where('date', '==', date)
      .get();

    const existingByNumber = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    existingSnap.forEach(doc => {
      const num = (doc.data().number ?? '') as string;
      if (num) existingByNumber.set(num, doc);
    });

    const batch = db.batch();
    let created = 0;
    let updated = 0;

    for (const csv of csvRooms) {
      const num = csv.number;
      if (!num) continue;

      const type = mapRoomType(csv.stayType, csv.status);
      const status = mapRoomStatus(csv.condition);

      const docId = `${date}_${num}`;
      const ref = db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('rooms').doc(docId);

      const existing = existingByNumber.get(num);
      if (existing) {
        // Overwrite type + status with CSV baseline. Clear stale progress
        // timestamps (fresh baseline). Preserve assignedTo/assignedName so
        // Maria's shift Send is not blown away. Preserve isDnd flags.
        batch.update(ref, {
          type,
          status,
          startedAt:   null,
          completedAt: null,
          issueNote:   admin.firestore.FieldValue.delete(),
          helpRequested: false,
          stayoverDay:     csv.stayoverDay ?? admin.firestore.FieldValue.delete(),
          stayoverMinutes: csv.stayoverMinutes ?? admin.firestore.FieldValue.delete(),
          arrival:         csv.arrival ?? admin.firestore.FieldValue.delete(),
          _lastPopulatedAt: admin.firestore.FieldValue.serverTimestamp(),
          _lastPopulatedFrom: 'populate-rooms-button',
        });
        updated++;
      } else {
        // New doc — seed everything.
        const payload: Record<string, unknown> = {
          number:     num,
          type,
          status,
          priority:   'standard',
          date,
          propertyId: pid,
          _seededBy:  'populate-rooms-button',
          _seededAt:  admin.firestore.FieldValue.serverTimestamp(),
        };
        if (csv.stayoverDay !== null && csv.stayoverDay !== undefined) {
          payload.stayoverDay = csv.stayoverDay;
        }
        if (csv.stayoverMinutes !== undefined) {
          payload.stayoverMinutes = csv.stayoverMinutes;
        }
        if (csv.arrival) {
          payload.arrival = csv.arrival;
        }
        batch.set(ref, payload);
        created++;
      }
    }

    await batch.commit();

    const pulledAt = planData.pulledAt?.toDate?.()?.toISOString() ?? null;

    return NextResponse.json({
      ok: true,
      date,
      created,
      updated,
      total: created + updated,
      csvPulledAt: pulledAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[populate-rooms-from-plan] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
