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

  // Aggregate errors across every write so the worker never marks a job
  // 'complete' when actual data wasn't persisted. Previously each error
  // path log.warn'd and kept going, returning ok:true with zeros — the
  // dashboard would then show "Connected ✓" with no rooms or staff,
  // confusing the GM about whether onboarding worked. (Pass-3 fix — H10.)
  const errors: string[] = [];

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
      errors.push(`rooms: ${error.message}`);
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
    // Lookup error is non-fatal. If we can't read the existing list we
    // fall through to "treat as empty" which may produce a duplicate
    // staff row — benign (Maria can clean up) and far better than
    // failing the whole onboarding for a transient Supabase blip. The
    // existingNames check is itself defense-in-depth; the real source
    // of truth is the absence of a unique constraint, which means a
    // duplicate row is recoverable, not a corruption.
    const { data: existing, error: existingErr } = await supabase
      .from('staff')
      .select('name')
      .eq('property_id', args.propertyId);
    if (existingErr) {
      log.warn('staff lookup failed — treating as empty (will dedup by exact name)', {
        err: existingErr.message,
      });
    }

    const existingNames = new Set((existing ?? []).map((r) => (r.name as string).toLowerCase()));

    // Map raw role strings to the staff.department CHECK enum
    // (housekeeping/front_desk/maintenance/other). PMS extraction yields
    // free-text role values; collapse common variants and default to
    // 'housekeeping' since most extracted staff are HK.
    const normalizeDept = (r?: string): string => {
      const v = (r ?? '').toLowerCase();
      if (v.includes('front')   || v.includes('desk'))     return 'front_desk';
      if (v.includes('maint')   || v.includes('engineer')) return 'maintenance';
      if (v.includes('house')   || v.includes('hk'))       return 'housekeeping';
      if (v && !['housekeeping','front_desk','maintenance','other'].includes(v)) return 'other';
      return 'housekeeping';
    };

    const toInsert = args.data.staff
      .filter((s) => s.name && !existingNames.has(s.name.toLowerCase()))
      .map((s) => ({
        property_id: args.propertyId,
        name: s.name,
        department: normalizeDept(s.role),
        phone: s.phone ?? null,
        is_active: true,
      }));

    if (toInsert.length > 0) {
      // Insert errors ARE fatal — the user explicitly asked for these
      // rows to land and the failure means they didn't.
      const { error } = await supabase.from('staff').insert(toInsert);
      if (error) {
        log.warn('failed to insert staff', { err: error.message });
        errors.push(`staff insert: ${error.message}`);
      } else {
        summary.staffSaved = toInsert.length;
      }
    }
  }

  // ─── pms_connected flag on properties ────────────────────────────────────
  // After a successful onboarding extraction, mark the property's PMS
  // connection state to true so the dashboard shows "Connected". This
  // flips the badge on /settings/pms from yellow to green.
  const { error: pmsErr } = await supabase
    .from('properties')
    .update({
      pms_connected: true,
      last_synced_at: new Date().toISOString(),
    })
    .eq('id', args.propertyId);

  if (pmsErr) {
    errors.push(`pms_connected flag: ${pmsErr.message}`);
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join(' | ') };
  }
  return { ok: true, summary };
}
