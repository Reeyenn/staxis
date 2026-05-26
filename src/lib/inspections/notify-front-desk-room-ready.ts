/**
 * Inspection-pass → "Room is ready" SMS to whoever is currently
 * working at the front desk.
 *
 * Lives in src/lib/inspections/ (not in the coordination directory) so
 * the only edit to correction-loop.ts is one import + two call sites.
 * The actual dispatch + audit + Twilio gating happens inside
 * dispatchSMS — this helper just shapes the payload.
 *
 * Failure policy: this notification is best-effort. A network blip, a
 * missing properties row, an unreachable scheduled_shifts table — none
 * should reverse the inspection that just passed. Any thrown error is
 * caught here and logged; the caller never sees it.
 */

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  dispatchSMS,
  findCurrentlyWorkingFrontDesk,
} from '@/lib/front-desk-coordination';
import type { DispatchRecipient } from '@/lib/front-desk-coordination';
import type { Inspection } from '@/types/inspections';

async function lookupRoomType(propertyId: string, roomNumber: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_rooms_inventory')
      .select('room_type')
      .eq('property_id', propertyId)
      .eq('room_number', roomNumber)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { room_type?: string | null }).room_type ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true if today's rooms row for (propertyId, roomNumber) is
 * flagged priority='vip'. Used to escalate the event_type from
 * 'room_ready' to 'vip_arrival' so the notification log can filter on
 * it and the SMS body lands more attention-grabbing.
 *
 * On any error returns false — fail-safe (a regular room_ready is the
 * safer default; vip_arrival is the louder one).
 */
async function isVipRoomToday(
  propertyId: string,
  roomNumber: string,
  today: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('priority')
      .eq('property_id', propertyId)
      .eq('date', today)
      .eq('number', roomNumber)
      .maybeSingle();
    if (error || !data) return false;
    return (data as { priority?: string | null }).priority === 'vip';
  } catch {
    return false;
  }
}

function buildBody(roomNumber: string, roomType: string | null, isVip: boolean): string {
  if (isVip) {
    if (roomType) {
      return `VIP room ${roomNumber} is now ready (${roomType}). Welcome amenity confirmed.`;
    }
    return `VIP room ${roomNumber} is now ready. Welcome amenity confirmed.`;
  }
  if (roomType) {
    return `Room ${roomNumber} is ready for the next guest (${roomType}).`;
  }
  return `Room ${roomNumber} is ready for the next guest.`;
}

function todayInUtc(): string {
  // The inspection-complete path doesn't carry the property timezone
  // through, so we pin to UTC midnight. The downstream consumer (the
  // rooms board) is already keyed on UTC-rolling YYYY-MM-DD per
  // useTodayStr, so the mismatch surface is bounded to the ~6h window
  // around UTC midnight in US time zones.
  return new Date().toISOString().slice(0, 10);
}

export async function notifyFrontDeskRoomReady(inspection: Inspection): Promise<void> {
  try {
    const propertyId = inspection.propertyId;
    const roomNumber = inspection.roomNumber;
    if (!propertyId || !roomNumber) return;

    const today = todayInUtc();
    const [recipients, roomType, isVip] = await Promise.all([
      findCurrentlyWorkingFrontDesk(propertyId),
      lookupRoomType(propertyId, roomNumber),
      isVipRoomToday(propertyId, roomNumber, today),
    ]);

    const mappedRecipients: DispatchRecipient[] = recipients.map((r) => ({
      staffId: r.staffId,
      name: r.name,
      phone: r.phone,
    }));

    await dispatchSMS({
      propertyId,
      eventType: isVip ? 'vip_arrival' : 'room_ready',
      body: buildBody(roomNumber, roomType, isVip),
      payload: {
        room_number: roomNumber,
        room_type: roomType,
        vip: isVip,
        inspection_id: inspection.id,
        cleaning_task_id: inspection.cleaningTaskId,
        housekeeper_staff_id: inspection.housekeeperStaffId,
      },
      recipients: mappedRecipients,
    });
  } catch (err) {
    log.warn('[notify-front-desk-room-ready] dispatch threw — best-effort, no rethrow', {
      inspectionId: inspection.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
