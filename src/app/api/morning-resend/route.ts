/**
 * POST /api/morning-resend
 *
 * Runs before the shift starts (e.g. 6am). For each confirmed HK:
 *   1. Re-checks current room counts from Firestore (scraper may have updated them overnight)
 *   2. Re-runs smart room assignment with the confirmed headcount
 *   3. If the room list changed for any HK, sends an updated text + updates their confirmation doc
 *
 * Call this from the scheduler (6am trigger) or manually via the scheduling page.
 *
 * Body: { uid, pid, shiftDate, baseUrl }
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';
import { isValidDateStr } from '@/lib/utils';

// ─── Helpers ────────────────────────────────────────────────────────────────

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}


interface RoomDoc {
  number: string;
  type: 'checkout' | 'stayover' | 'vacant';
  [key: string]: unknown;
}

interface HKSlot {
  index: number;
  rooms: string[];
  totalMinutes: number;
}

const CLEANING_TIMES = { checkout: 30, stayover: 20 };
const SHIFT_MINUTES  = 480;

/**
 * Re-runs smart room assignment: groups by floor, distributes floor groups
 * to the HK with the least work. Checkouts before stayovers per floor.
 */
function smartAssignRooms(rooms: RoomDoc[], numHousekeepers: number): HKSlot[] {
  if (numHousekeepers <= 0 || rooms.length === 0) return [];

  const byFloor: Record<string, RoomDoc[]> = {};
  for (const room of rooms) {
    const floor = String(room.number).charAt(0);
    if (!byFloor[floor]) byFloor[floor] = [];
    byFloor[floor].push(room);
  }

  for (const floor of Object.keys(byFloor)) {
    byFloor[floor].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
      return parseInt(a.number) - parseInt(b.number);
    });
  }

  const slots: HKSlot[] = Array.from({ length: numHousekeepers }, (_, i) => ({
    index: i, rooms: [], totalMinutes: 0,
  }));

  for (const floorRooms of Object.values(byFloor)) {
    const lightest = slots.reduce((min, s) => s.totalMinutes < min.totalMinutes ? s : min, slots[0]);
    for (const room of floorRooms) {
      lightest.rooms.push(room.number);
      lightest.totalMinutes += CLEANING_TIMES[room.type as 'checkout' | 'stayover'] ?? 25;
    }
  }

  return slots;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { uid, pid, shiftDate, baseUrl } = await req.json() as {
      uid: string; pid: string; shiftDate: string; baseUrl: string;
    };

    if (!uid || !pid || !shiftDate) {
      return NextResponse.json({ error: 'Missing uid, pid, or shiftDate' }, { status: 400 });
    }

    if (!isValidDateStr(shiftDate)) {
      return NextResponse.json({ error: 'Invalid shiftDate format (expected YYYY-MM-DD)' }, { status: 400 });
    }

    const db = admin.firestore();

    // Fetch hotel name from property doc
    const propSnap = await db.collection('users').doc(uid).collection('properties').doc(pid).get();
    const hotelName = propSnap.data()?.name || 'Your Hotel';

    // ── 1. Load confirmed HKs for this shift date ────────────────────────────
    const confirmsSnap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('shiftConfirmations')
      .where('shiftDate', '==', shiftDate)
      .where('status', '==', 'confirmed')
      .get();

    if (confirmsSnap.empty) {
      return NextResponse.json({ message: 'No confirmed HKs for this date', updated: 0 });
    }

    const confirmed = confirmsSnap.docs.map(d => ({ docId: d.id, ...d.data() })) as Array<{
      docId: string;
      staffId: string;
      staffName: string;
      staffPhone: string;
      language: 'en' | 'es';
      assignedRooms: string[];
      assignedAreas: string[];
      hkUrl: string;
    }>;

    // ── 2. Re-fetch today's room data from Firestore ─────────────────────────
    // shiftDate is tomorrow from the HK's perspective, but the scraper writes
    // rooms for "today" (the day the data is current). We read shiftDate's docs.
    const roomsSnap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('rooms')
      .where('date', '==', shiftDate)
      .get();

    // If no rooms for shiftDate yet, fall back to the day before (scraper may
    // not have run for that date yet - rooms are written on the day itself)
    let roomDocs = roomsSnap.docs.map(d => d.data() as RoomDoc);
    if (roomDocs.length === 0) {
      // Try yesterday's data as proxy for tomorrow's workload
      const [y, m, d] = shiftDate.split('-').map(Number);
      const prev = new Date(y, m - 1, d - 1);
      const prevISO = prev.toLocaleDateString('en-CA');
      const prevSnap = await db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('rooms')
        .where('date', '==', prevISO)
        .get();
      roomDocs = prevSnap.docs.map(d => d.data() as RoomDoc);
    }

    const cleanableRooms = roomDocs.filter(r => r.type === 'checkout' || r.type === 'stayover');

    // ── 3. Re-run smart assignment with confirmed headcount ──────────────────
    const numHKs       = confirmed.length;
    const newAssignments = smartAssignRooms(cleanableRooms, numHKs);

    // ── 4. For each confirmed HK, check if rooms changed, send update if so ─
    let updatedCount = 0;

    await Promise.allSettled(
      confirmed.map(async (hk, idx) => {
        const newRooms = newAssignments[idx]?.rooms ?? [];
        const oldRooms = hk.assignedRooms ?? [];

        const changed =
          newRooms.length !== oldRooms.length ||
          newRooms.some((r, i) => r !== oldRooms[i]);

        if (!changed) return; // nothing to do

        // Update the confirmation doc with the new room list
        await db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('shiftConfirmations').doc(hk.docId)
          .update({ assignedRooms: newRooms, morningResendAt: admin.firestore.FieldValue.serverTimestamp() });

        // Send update SMS
        const phone164  = toE164(hk.staffPhone);
        const firstName = hk.staffName.split(' ')[0];
        const lang      = hk.language ?? 'en';
        const hkUrl     = hk.hkUrl ?? `${baseUrl}/housekeeper/${hk.staffId}`;

        if (phone164) {
          let msg: string;
          if (lang === 'es') {
            msg  = `📋 Actualización de turno, ${firstName}. Lista revisada:`;
            if (newRooms.length > 0) msg += `\nHabitaciones: ${newRooms.join(', ')}`;
            if (hk.assignedAreas?.length > 0) msg += `\nÁreas: ${hk.assignedAreas.join(', ')}`;
            msg += `\nTu enlace: ${hkUrl}\n– ${hotelName}`;
          } else {
            msg  = `📋 Shift update, ${firstName}. Revised list:`;
            if (newRooms.length > 0) msg += `\nRooms: ${newRooms.join(', ')}`;
            if (hk.assignedAreas?.length > 0) msg += `\nAreas: ${hk.assignedAreas.join(', ')}`;
            msg += `\nYour link: ${hkUrl}\n– ${hotelName}`;
          }

          try {
            await sendSms(phone164, msg);
            updatedCount++;
          } catch (err) {
            console.error(`Morning resend SMS failed for ${hk.staffName}:`, err);
          }
        }
      })
    );

    return NextResponse.json({
      message: `Morning resend complete. ${updatedCount} of ${numHKs} HKs received updated room lists.`,
      updated: updatedCount,
      total: numHKs,
    });

  } catch (err) {
    console.error('morning-resend error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
