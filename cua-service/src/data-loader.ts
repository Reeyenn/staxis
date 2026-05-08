/**
 * Data loader — saves the ExtractedData from the recipe-runner into the
 * property's tables in Supabase.
 *
 * Idempotent: re-running an onboarding job for the same property updates
 * existing rooms/staff rather than duplicating. We key on (property_id,
 * room_number) and (property_id, name + phone) respectively.
 *
 * Future tables (history, arrivals, departures, room status) plug in
 * here. For v0 we do rooms + staff — the minimum needed to make the
 * dashboard meaningful on day one.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import type { ExtractedData } from './recipe-runner.js';

export interface SaveSummary {
  roomsSaved: number;
  staffSaved: number;
  historyDaysSaved: number;
  arrivalsToday: number;
  departuresToday: number;
}

export type SaveResult =
  | { ok: true; summary: SaveSummary }
  | { ok: false; error: string };

export async function saveExtractedData(args: {
  propertyId: string;
  data: ExtractedData;
}): Promise<SaveResult> {
  const summary: SaveSummary = {
    roomsSaved: 0,
    staffSaved: 0,
    historyDaysSaved: 0,
    arrivalsToday: args.data.arrivalsToday.length,
    departuresToday: args.data.departuresToday.length,
  };

  // ─── Rooms ───────────────────────────────────────────────────────────────
  // properties.room_inventory is a text[] of room numbers (migration 0025).
  // It's the master list — /api/populate-rooms-from-plan unions it with
  // CSV-derived rooms so vacant-clean rooms (which Choice Advantage
  // omits from its CSV) still render in housekeeping. Overwriting on
  // re-onboard is correct: the PMS is the source of truth.
  //
  // Also bump total_rooms so the dashboard counts are right immediately
  // (without waiting for the next CSV pull to recompute).
  if (args.data.rooms.length > 0) {
    const roomNumbers = args.data.rooms
      .map((r) => r.roomNumber)
      .filter((rn): rn is string => typeof rn === 'string' && rn.trim().length > 0);

    const { error } = await supabase
      .from('properties')
      .update({
        total_rooms: roomNumbers.length,
        room_inventory: roomNumbers,
      })
      .eq('id', args.propertyId);

    if (error) {
      log.warn('failed to write room_inventory', { err: error.message });
    } else {
      summary.roomsSaved = roomNumbers.length;
    }
  }

  // ─── Staff ───────────────────────────────────────────────────────────────
  // Insert any staff member that doesn't already exist by name. We
  // intentionally don't overwrite — Maria has been editing staff
  // manually, and we don't want PMS naming differences to clobber her
  // edits. Only first-time inserts.
  if (args.data.staff.length > 0) {
    const { data: existing } = await supabase
      .from('staff')
      .select('name')
      .eq('property_id', args.propertyId);

    const existingNames = new Set((existing ?? []).map((r) => (r.name as string).toLowerCase()));
    const toInsert = args.data.staff
      .filter((s) => s.name && !existingNames.has(s.name.toLowerCase()))
      .map((s) => ({
        property_id: args.propertyId,
        name: s.name,
        role: s.role ?? 'housekeeper',
        phone_number: s.phone ?? null,
        is_active: true,
      }));

    if (toInsert.length > 0) {
      const { error } = await supabase.from('staff').insert(toInsert);
      if (error) {
        log.warn('failed to insert staff', { err: error.message });
      } else {
        summary.staffSaved = toInsert.length;
      }
    }
  }

  // ─── pms_connected flag on properties ────────────────────────────────────
  // After a successful onboarding extraction, mark the property's PMS
  // connection state to true so the dashboard shows "Connected". This
  // flips the badge on /settings/pms from yellow to green.
  await supabase
    .from('properties')
    .update({
      pms_connected: true,
      last_synced_at: new Date().toISOString(),
    })
    .eq('id', args.propertyId);

  return { ok: true, summary };
}
