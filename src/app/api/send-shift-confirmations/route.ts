/**
 * POST /api/send-shift-confirmations
 *
 * Called by the Housekeeping → Schedule tab's "Send" button.
 * For each selected housekeeper, sends a simple YES/NO availability text and
 * stores a `shiftConfirmations` doc so /api/sms-reply can look up the reply.
 *
 * The follow-up message after YES (with their personal link) is sent by
 * /api/sms-reply, NOT by this route.
 *
 * Body:
 *   {
 *     uid, pid, shiftDate,                    // required
 *     baseUrl,                                // required — used to build hkUrl
 *     staff: [
 *       {
 *         staffId, name, phone, language,     // required
 *         assignedRooms?: string[],           // room numbers for this HK
 *         assignedAreas?: string[],           // public areas for this HK
 *       },
 *       ...
 *     ]
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';
import { isValidDateStr } from '@/lib/utils';

interface StaffEntry {
  staffId: string;
  name: string;
  phone: string;
  language: 'en' | 'es';
  assignedRooms?: string[];
  assignedAreas?: string[];
}

interface RequestBody {
  uid: string;
  pid: string;
  shiftDate: string;
  baseUrl: string;
  staff: StaffEntry[];
}

// Pull room type from the CSV planSnapshot so we can seed rooms/{date}_{num}
// with the correct checkout/stayover flag. Default to 'checkout' when unknown
// so workload estimates err on the heavier side.
function deriveRoomType(
  number: string,
  snapData: { rooms?: Array<{ number: string; stayType?: string | null }> } | null,
): 'checkout' | 'stayover' {
  if (!snapData?.rooms) return 'checkout';
  const match = snapData.rooms.find(r => r.number === number);
  if (!match) return 'checkout';
  return match.stayType === 'Stay' ? 'stayover' : 'checkout';
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

function formatShiftDate(dateStr: string, lang: 'en' | 'es'): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const dayName = d.toLocaleDateString(locale, { weekday: 'long' });
  const dateFormatted = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${dayName}, ${dateFormatted}`;
}

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { uid, pid, shiftDate, baseUrl, staff } = body;

    if (!uid || !pid || !shiftDate || !staff?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidDateStr(shiftDate)) {
      return NextResponse.json({ error: 'Invalid shiftDate (expected YYYY-MM-DD)' }, { status: 400 });
    }

    const db = admin.firestore();

    const propSnap = await db.collection('users').doc(uid).collection('properties').doc(pid).get();
    const hotelName = propSnap.data()?.name || 'Your Hotel';

    // Pull this shift's plan snapshot once so we can seed rooms with correct types.
    const planSnap = await db
      .collection('users').doc(uid)
      .collection('properties').doc(pid)
      .collection('planSnapshots').doc(shiftDate)
      .get();
    const planSnapData = planSnap.exists
      ? (planSnap.data() as { rooms?: Array<{ number: string; stayType?: string | null }> })
      : null;

    // ── Seed rooms/{shiftDate}_{num} with assignments so the HK link page finds them.
    //
    // The HK link page queries `collectionGroup('rooms') where assignedTo == hkId and date == today`.
    // For future dates (tomorrow) the 15-min scraper hasn't written these docs yet, so we seed
    // them here from the CSV. When the scraper runs at 6am on the shift date, it merges new
    // live data in without touching assignedTo, so Maria's assignments survive the refresh.
    //
    // Also CLEARS assignments on any rooms that used to be assigned but aren't in this Send
    // (so unassigning works when Maria re-sends after tweaks).
    {
      const assignmentMap = new Map<string, { staffId: string; staffName: string }>();
      for (const entry of staff) {
        for (const num of (entry.assignedRooms ?? [])) {
          assignmentMap.set(num, { staffId: entry.staffId, staffName: entry.name });
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

      // Write / update every room Maria is assigning
      for (const [num, who] of assignmentMap) {
        const docId = `${shiftDate}_${num}`;
        const ref = db
          .collection('users').doc(uid)
          .collection('properties').doc(pid)
          .collection('rooms').doc(docId);

        const existing = existingByNumber.get(num);
        if (existing) {
          batch.update(ref, {
            assignedTo: who.staffId,
            assignedName: who.staffName,
          });
        } else {
          // No doc yet (future date, scraper hasn't written this one). Create it.
          batch.set(ref, {
            number: num,
            type: deriveRoomType(num, planSnapData),
            status: 'dirty',
            priority: 'standard',
            date: shiftDate,
            propertyId: pid,
            assignedTo: who.staffId,
            assignedName: who.staffName,
            _seededBy: 'send-shift-confirmations',
            _seededAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      // Clear assignments on rooms that used to be assigned but aren't in this Send.
      for (const [num, doc] of existingByNumber) {
        if (assignmentMap.has(num)) continue;
        const data = doc.data();
        if (data.assignedTo) {
          batch.update(doc.ref, { assignedTo: null, assignedName: null });
        }
      }

      await batch.commit();
    }

    // ── Mirror the assignments into scheduleAssignments/{shiftDate}.
    // The client already saves this before calling us, but doing it here too
    // is cheap and guarantees the doc exists even if the client save raced.
    {
      const roomAssignments: Record<string, string> = {};
      const staffNames: Record<string, string> = {};
      const crew: string[] = [];
      for (const entry of staff) {
        crew.push(entry.staffId);
        staffNames[entry.staffId] = entry.name;
        for (const num of (entry.assignedRooms ?? [])) {
          roomAssignments[`${shiftDate}_${num}`] = entry.staffId;
        }
      }
      await db
        .collection('users').doc(uid)
        .collection('properties').doc(pid)
        .collection('scheduleAssignments').doc(shiftDate)
        .set({
          date: shiftDate,
          roomAssignments,
          crew,
          staffNames,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    }

    const results = await Promise.allSettled(
      staff.map(async ({ staffId, name, phone, language, assignedRooms, assignedAreas }) => {
        const phone164 = toE164(phone);
        if (!phone164) throw new Error(`Invalid phone: ${phone}`);

        const rooms = assignedRooms ?? [];
        const areas = assignedAreas ?? [];
        const hkUrl = `${baseUrl}/housekeeper/${staffId}`;

        // One shiftConfirmation per (shiftDate, staffId). Deterministic ID so
        // re-clicking Send doesn't create duplicates — it refreshes the doc.
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
          status: 'pending',       // pending | confirmed | declined
          language,
          assignedRooms: rooms,
          assignedAreas: areas,
          hkUrl,
          hotelName,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          respondedAt: null,
          smsSent: false,
        });

        // Top-level phone → doc path index so /api/sms-reply can find the
        // pending confirmation via a direct GET (no collectionGroup query,
        // no composite index required). Last-write-wins — the newest send
        // for this phone is always what inbound replies match.
        await db.collection('phoneLookup').doc(phone164).set({
          path: confirmRef.path,
          uid, pid, staffId,
          shiftDate,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const firstName = name.split(' ')[0];
        const dateLabel = formatShiftDate(shiftDate, language);

        const message = language === 'es'
          ? `Hola ${firstName}! ¿Puedes venir mañana (${dateLabel})?\nResponde SÍ o NO.\n\nFor English, reply ENGLISH\n– ${hotelName}`
          : `Hi ${firstName}! Can you come in tomorrow (${dateLabel})?\nReply YES or NO.\n\nPara español, responde ESPAÑOL\n– ${hotelName}`;

        await sendSms(phone164, message);
        await confirmRef.update({ smsSent: true });

        return { staffId, docId };
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`send-shift-confirmations failed for ${staff[i].name}:`, r.reason);
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    console.error('send-shift-confirmations error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
