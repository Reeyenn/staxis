/**
 * Room-move: move a guest from room A to room B.
 *
 * Both rooms need to rebuild correctly:
 *   - A flips to "needs a turnaround clean" (rooms.status='dirty',
 *     type='checkout', issue_note set with the move context).
 *   - B is now occupied — flips type='stayover' and clears any prior
 *     issue_note.
 *   - The matching pms_reservations row for today is updated to point
 *     at B.
 *   - Both rooms get a row in pms_room_status_log so the audit reflects
 *     the change (source='manual').
 *
 * All writes are bundled. If any step fails, we still apply the writes
 * that already succeeded but return error_text so the caller can show a
 * warning. The audit + dispatchSMS layer above us catches the user-facing
 * surface; this module focuses on data consistency.
 *
 * Why we don't wrap in a Postgres transaction: the writes span
 * pms_reservations (CUA-owned schema, sometimes empty in the rooms
 * fallback path) AND rooms (legacy day-bucketed) AND
 * pms_room_status_log (append-only). A failed pms_* write should never
 * block the rooms-side update — the housekeeping side is the source of
 * truth for "this room needs cleaning". The orchestrator returns a
 * structured result so the caller can decide whether to surface the
 * partial failure.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface RoomMoveInput {
  propertyId: string;
  fromRoom: string;
  toRoom: string;
  /** YYYY-MM-DD in property TZ — used to pick today's rooms row + reservation. */
  today: string;
  reason: 'maintenance' | 'guest_request' | 'upgrade' | 'other';
  note: string | null;
  /** Account id of the front-desk staffer who pressed the button (for audit). */
  actorAccountId: string | null;
}

export interface RoomMoveResult {
  ok: boolean;
  fromRoomsUpdated: boolean;
  toRoomsUpdated: boolean;
  reservationUpdated: boolean;
  statusLogWritten: boolean;
  errors: string[];
}

export async function executeRoomMove(input: RoomMoveInput): Promise<RoomMoveResult> {
  const errors: string[] = [];
  const noteSuffix = input.note ? ` — ${input.note}` : '';
  const reasonLabel = input.reason.replace(/_/g, ' ');
  const fromNote = `Guest moved out of ${input.fromRoom} to ${input.toRoom} (${reasonLabel})${noteSuffix}. Needs turnaround clean.`;

  // ── 1. From room: status=dirty, type=checkout (turnaround), issue_note set
  let fromRoomsUpdated = false;
  try {
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .update({
        status: 'dirty',
        type: 'checkout',
        completed_at: null,
        issue_note: fromNote,
        updated_at: new Date().toISOString(),
      })
      .eq('property_id', input.propertyId)
      .eq('date', input.today)
      .eq('number', input.fromRoom)
      .select('id');
    if (error) throw new Error(error.message);
    fromRoomsUpdated = Array.isArray(data) && data.length > 0;
    if (!fromRoomsUpdated) {
      errors.push(`from_room_not_found: rooms row for ${input.fromRoom} on ${input.today}`);
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    errors.push(`from_rooms_update_failed: ${m}`);
    log.error('[room-move] from rooms update failed', {
      propertyId: input.propertyId, fromRoom: input.fromRoom, err: m,
    });
  }

  // ── 2. To room: status=clean stays as-is conceptually but type → stayover,
  //               issue_note cleared. Don't touch status — housekeeping
  //               owns that lifecycle.
  let toRoomsUpdated = false;
  try {
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .update({
        type: 'stayover',
        issue_note: null,
        updated_at: new Date().toISOString(),
      })
      .eq('property_id', input.propertyId)
      .eq('date', input.today)
      .eq('number', input.toRoom)
      .select('id');
    if (error) throw new Error(error.message);
    toRoomsUpdated = Array.isArray(data) && data.length > 0;
    if (!toRoomsUpdated) {
      errors.push(`to_room_not_found: rooms row for ${input.toRoom} on ${input.today}`);
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    errors.push(`to_rooms_update_failed: ${m}`);
    log.error('[room-move] to rooms update failed', {
      propertyId: input.propertyId, toRoom: input.toRoom, err: m,
    });
  }

  // ── 3. pms_reservations: today's reservation in fromRoom → point at toRoom
  //
  // Codex adversarial fix: only proceed when the FROM room rebuild
  // succeeded (i.e. the housekeeping side reflects "needs turnaround
  // clean"). Without this guard, a failed from-room update would
  // leave 305 marked clean while the guest is conceptually in 312,
  // and the reservation flip would lock in that inconsistent state.
  let reservationUpdated = false;
  if (!fromRoomsUpdated) {
    errors.push(
      'reservation_update_skipped: from_room rebuild failed — aborting before pms_reservations to avoid an inconsistent move',
    );
    log.warn('[room-move] aborting reservation update because from-room rebuild failed', {
      propertyId: input.propertyId,
      fromRoom: input.fromRoom,
      toRoom: input.toRoom,
    });
  } else try {
    // Look up the in-house reservation (arrival_date <= today,
    // departure_date > today) that's currently in fromRoom. There can
    // be at most one — pick the most recent if data drift produced
    // duplicates.
    const { data: reservations, error: resErr } = await supabaseAdmin
      .from('pms_reservations')
      .select('id, room_number, arrival_date, departure_date, status, last_synced_at')
      .eq('property_id', input.propertyId)
      .eq('room_number', input.fromRoom)
      .lte('arrival_date', input.today)
      .gte('departure_date', input.today)
      .order('last_synced_at', { ascending: false })
      .limit(1);
    if (resErr) throw new Error(resErr.message);
    const reservation = (reservations ?? [])[0] as { id: string } | undefined;
    if (reservation) {
      const { error: updErr } = await supabaseAdmin
        .from('pms_reservations')
        .update({
          room_number: input.toRoom,
          updated_at: new Date().toISOString(),
        })
        .eq('id', reservation.id);
      if (updErr) throw new Error(updErr.message);
      reservationUpdated = true;
    }
    // No reservation row found is acceptable — the rooms board may
    // contain a stayover that pre-dates the PMS pull (or the hotel
    // doesn't have CUA wired up yet). The rooms-side update above
    // is authoritative for today's cleaning logic regardless.
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    errors.push(`reservation_update_failed: ${m}`);
    log.error('[room-move] reservation update failed', {
      propertyId: input.propertyId, fromRoom: input.fromRoom, toRoom: input.toRoom, err: m,
    });
  }

  // ── 4. Append two pms_room_status_log rows — audit trail.
  // The trigger in migration 0228 will mirror these into activity_log.
  let statusLogWritten = false;
  try {
    const { error: logErr } = await supabaseAdmin
      .from('pms_room_status_log')
      .insert([
        {
          property_id: input.propertyId,
          room_number: input.fromRoom,
          status: 'vacant_dirty',
          source: 'manual',
          changed_by: input.actorAccountId,
          notes: `Room move: guest left ${input.fromRoom} → ${input.toRoom} (${reasonLabel})`,
        },
        {
          property_id: input.propertyId,
          room_number: input.toRoom,
          status: 'occupied',
          source: 'manual',
          changed_by: input.actorAccountId,
          notes: `Room move: guest moved into ${input.toRoom} from ${input.fromRoom} (${reasonLabel})`,
        },
      ]);
    if (logErr) throw new Error(logErr.message);
    statusLogWritten = true;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    errors.push(`status_log_write_failed: ${m}`);
    log.error('[room-move] pms_room_status_log insert failed', {
      propertyId: input.propertyId, err: m,
    });
  }

  return {
    ok: errors.length === 0,
    fromRoomsUpdated,
    toRoomsUpdated,
    reservationUpdated,
    statusLogWritten,
    errors,
  };
}
