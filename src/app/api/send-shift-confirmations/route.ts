/**
 * POST /api/send-shift-confirmations
 *
 * Called by the Housekeeping → Schedule tab's "Send" button.
 * For each selected housekeeper, sends ONE SMS with their personal link and
 * assigned rooms for tomorrow's shift, and stores a `shiftConfirmations` doc
 * so /api/sms-reply can route any replies back to the right shift.
 *
 * Maria confirms availability in-person at 3pm, so there is no YES/NO prompt
 * in the SMS itself. The link text is the only thing sent on the first pass.
 * Re-clicking Send later refreshes the same doc and re-sends the link with
 * the latest room list (no "update" branch — it's one action, repeatable).
 *
 * YES/NO is still accepted by /api/sms-reply if a HK happens to reply — YES
 * just marks the doc 'confirmed' as a nice acknowledgment; NO marks it
 * 'declined' and pings managers so Maria knows someone flaked.
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

    // ── Failsafe: refuse to Send with zero real assignments across the crew.
    // A buggy client that sends an empty staff list would otherwise fire
    // "no assignments" SMS to everyone and wipe rooms. Require `allowEmpty:
    // true` to explicitly opt in.
    const hasAnyWork = staff.some(s =>
      (s.assignedRooms ?? []).length > 0 || (s.assignedAreas ?? []).length > 0,
    );
    const allowEmpty = (body as { allowEmpty?: boolean }).allowEmpty === true;
    if (!hasAnyWork && !allowEmpty) {
      return NextResponse.json({
        error: 'Refusing to Send with no room or area assignments. Assign at least one HK before sending, or pass allowEmpty=true to override.',
      }, { status: 400 });
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

    // Per-staff outcome. We always include every crew member in the response
    // (even phoneless ones) so the UI can render a status badge next to each
    // name. Room assignments are ALREADY saved above regardless of phone, so
    // phoneless staff keep their rooms.
    type StaffOutcome = {
      staffId: string;
      status: 'sent' | 'skipped' | 'failed';
      reason?: 'no_phone' | 'invalid_phone' | 'sms_error' | string;
      isUpdate?: boolean;
    };

    const perStaff: StaffOutcome[] = await Promise.all(
      staff.map(async ({ staffId, name, phone, language, assignedRooms, assignedAreas }): Promise<StaffOutcome> => {
        try {
          if (!phone || !phone.trim()) {
            return { staffId, status: 'skipped', reason: 'no_phone' };
          }
          const phone164 = toE164(phone);
          if (!phone164) {
            return { staffId, status: 'skipped', reason: 'invalid_phone' };
          }

          const rooms = assignedRooms ?? [];
          const areas = assignedAreas ?? [];
          // Include uid + pid in the HK link so the mobile page can fire
          // /api/help-request and /api/report-issue. Without them, the
          // Need Help button silently fails (those endpoints require both).
          const hkUrl = `${baseUrl}/housekeeper/${staffId}?uid=${encodeURIComponent(uid)}&pid=${encodeURIComponent(pid)}`;

          // One shiftConfirmation per (shiftDate, staffId). Deterministic ID so
          // re-clicking Send doesn't create duplicates — it refreshes the doc.
          const docId = `${shiftDate}_${staffId}`;
          const confirmRef = db
            .collection('users').doc(uid)
            .collection('properties').doc(pid)
            .collection('shiftConfirmations').doc(docId);

          // Check for an existing confirmation doc. If the HK already replied
          // YES ("confirmed"), we preserve that status. Otherwise the doc
          // enters/remains in 'sent' state (the normal resting state — Maria
          // confirms availability in person at 3pm). We send the SAME link
          // SMS either way, just with slightly different copy for updates so
          // the HK knows the list changed.
          const existingSnap = await confirmRef.get();
          const existingData = existingSnap.exists ? existingSnap.data() : null;
          const isUpdate = existingSnap.exists;
          const preserveConfirmed = existingData?.status === 'confirmed';

          if (isUpdate) {
            // Keep the existing 'confirmed' flag if they'd already replied YES.
            // Otherwise bump status back to 'sent'. Either way refresh rooms,
            // link, language, and reset smsSent so this Send can mark it true.
            await confirmRef.update({
              staffName: name,
              staffPhone: phone164,
              language,
              assignedRooms: rooms,
              assignedAreas: areas,
              hkUrl,
              hotelName,
              ...(preserveConfirmed ? {} : { status: 'sent' }),
              lastUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
              smsSent: false,
            });
          } else {
            await confirmRef.set({
              uid, pid,
              staffId,
              staffName: name,
              staffPhone: phone164,
              shiftDate,
              status: 'sent',          // sent | confirmed | declined
              language,
              assignedRooms: rooms,
              assignedAreas: areas,
              hkUrl,
              hotelName,
              sentAt: admin.firestore.FieldValue.serverTimestamp(),
              respondedAt: null,
              smsSent: false,
            });
          }

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

          // Minimal SMS: name + date + link + language toggle line + hotel
          // footer. Room assignments live on the HK's personal page (opened
          // via the link), NOT in the text. One template for every send.
          const message = language === 'es'
            ? `Hola ${firstName}! Tu lista para ${dateLabel}:\n${hkUrl}\n\nFor English, reply ENGLISH\n\n– ${hotelName}`
            : `Hi ${firstName}! Your list for ${dateLabel}:\n${hkUrl}\n\nPara español, responde ESPAÑOL\n\n– ${hotelName}`;

          await sendSms(phone164, message);
          await confirmRef.update({ smsSent: true });

          return { staffId, status: 'sent', isUpdate };
        } catch (err) {
          console.error(`send-shift-confirmations failed for ${name}:`, err);
          const reason = err instanceof Error ? err.message : 'sms_error';
          return { staffId, status: 'failed', reason };
        }
      })
    );

    const sent    = perStaff.filter(r => r.status === 'sent').length;
    const skipped = perStaff.filter(r => r.status === 'skipped').length;
    const failed  = perStaff.filter(r => r.status === 'failed').length;
    const updated = perStaff.filter(r => r.status === 'sent' && r.isUpdate === true).length;
    const fresh   = sent - updated;

    return NextResponse.json({ sent, failed, skipped, updated, fresh, perStaff });
  } catch (err) {
    console.error('send-shift-confirmations error:', err);
    // Persist the error so we can diagnose without shell logs.
    try {
      await admin.firestore().collection('errorLogs').add({
        route: '/api/send-shift-confirmations',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack ?? null : null,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch {}
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
