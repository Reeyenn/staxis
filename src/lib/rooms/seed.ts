/**
 * Shared room-seeding logic.
 *
 * Round 14 (2026-05-14). Extracted from the original
 * `/api/populate-rooms-from-plan` route so two callers share one code
 * path:
 *   1. The manual "Load Rooms from CSV" button on the Rooms tab.
 *   2. The new hourly `seed-rooms-daily` cron (Layer 2 of the Round 14
 *      accuracy fix) which keeps today's seed reliable even when no one
 *      clicked the button.
 *
 * Behavior — three branches per inventory room:
 *   • CSV mentioned the room → insert (new) OR update (existing), keep
 *     assigned_to / is_dnd / mid-clean timestamps intact.
 *   • Existing DB row, no CSV mention → leave alone (manual override
 *     wins; we don't blow away an in-progress clean).
 *   • In inventory, no CSV mention, no DB row → phantom-seed as
 *     vacant + clean so every room from the master inventory renders.
 *
 * Robustness — if the `plan_snapshots` row is missing for the date, we
 * still phantom-seed every inventory room as vacant + clean rather
 * than erroring out. The cron needs this: if the scraper hiccups, the
 * staff still arrive to a fully-rendered Rooms tab.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export type PlanRoom = {
  number: string;
  roomType?: string;
  status?: string | null;
  condition?: string | null;
  stayType?: string | null;
  service?: string | null;
  stayoverDay?: number | null;
  stayoverMinutes?: number | null;
  arrival?: string | null;
};

export interface SeedResult {
  created: number;
  updated: number;
  phantomCreated: number;
  csvPulledAt: string | null;
  /** When false, seedRoomsForDate ran phantom-seed only (no plan_snapshots
   *  row existed for this date). Caller can decide whether to surface
   *  this — useful in the cron's log line, not in the manual-button UI. */
  csvAvailable: boolean;
  inventoryLength: number;
}

// CSV `stayType` / `status` → rooms.type. Mirrors the Send-Shift logic so
// both code paths land on the same answer for the same CSV input.
function mapRoomType(
  stayType: string | null | undefined,
  status: string | null | undefined,
): 'checkout' | 'stayover' | 'vacant' {
  if (stayType === 'C/O') return 'checkout';
  if (status === 'OCC') return 'stayover';
  return 'vacant';
}

// CSV `condition` → rooms.status. Anything not literal "Clean" is dirty.
function mapRoomStatus(condition: string | null | undefined): 'clean' | 'dirty' {
  return condition === 'Clean' ? 'clean' : 'dirty';
}

export async function seedRoomsForDate(
  propertyId: string,
  date: string,
): Promise<SeedResult> {
  // ─── Inputs ─────────────────────────────────────────────────────────────
  const [planRes, existingRes, propRes] = await Promise.all([
    supabaseAdmin
      .from('plan_snapshots')
      .select('rooms, pulled_at')
      .eq('property_id', propertyId)
      .eq('date', date)
      .maybeSingle(),
    supabaseAdmin
      .from('rooms')
      .select('id, number, status')
      .eq('property_id', propertyId)
      .eq('date', date),
    supabaseAdmin
      .from('properties')
      .select('room_inventory')
      .eq('id', propertyId)
      .maybeSingle(),
  ]);

  if (planRes.error) throw planRes.error;
  if (existingRes.error) throw existingRes.error;
  if (propRes.error) throw propRes.error;

  const csvRooms = ((planRes.data?.rooms ?? []) as PlanRoom[]);
  const csvAvailable = !!planRes.data && csvRooms.length > 0;
  const inventory = (propRes.data?.room_inventory as string[] | null) ?? [];

  const existingByNumber = new Map<string, { id: string; status: string | null }>();
  for (const r of (existingRes.data ?? [])) {
    if (r.number) {
      existingByNumber.set(r.number as string, {
        id: r.id as string,
        status: (r.status as string | null) ?? null,
      });
    }
  }

  let created = 0;
  let updated = 0;
  let phantomCreated = 0;

  // ─── CSV branch: insert OR update each CSV row ──────────────────────────
  const toInsert: Array<Record<string, unknown>> = [];
  const updates: PromiseLike<unknown>[] = [];

  for (const csv of csvRooms) {
    const num = csv.number;
    if (!num) continue;

    const type = mapRoomType(csv.stayType, csv.status);
    const status = mapRoomStatus(csv.condition);

    const row = existingByNumber.get(num);
    if (row) {
      // Preserve assigned_to / is_dnd. Preserve started_at/completed_at
      // when room is mid-clean (the PMS doesn't know our Start tap).
      const patch: Record<string, unknown> = {
        type,
        status,
        issue_note: null,
        help_requested: false,
      };
      const isMidClean = row.status === 'in_progress';
      if (status === 'dirty' && !isMidClean) {
        patch.started_at = null;
        patch.completed_at = null;
      }
      if (isMidClean) {
        patch.status = 'in_progress';
      }
      patch.stayover_day = csv.stayoverDay ?? null;
      patch.stayover_minutes = csv.stayoverMinutes ?? null;
      patch.arrival = csv.arrival ?? null;

      updates.push(
        supabaseAdmin
          .from('rooms')
          .update(patch)
          .eq('id', row.id)
          .then(({ error }) => { if (error) throw error; }),
      );
      updated++;
    } else {
      const payload: Record<string, unknown> = {
        property_id: propertyId,
        number: num,
        date,
        type,
        status,
        priority: 'standard',
      };
      if (csv.stayoverDay !== null && csv.stayoverDay !== undefined) {
        payload.stayover_day = csv.stayoverDay;
      }
      if (csv.stayoverMinutes !== null && csv.stayoverMinutes !== undefined) {
        payload.stayover_minutes = csv.stayoverMinutes;
      }
      if (csv.arrival) {
        payload.arrival = csv.arrival;
      }
      toInsert.push(payload);
      created++;
    }
  }

  if (toInsert.length > 0) {
    const { error: insErr } = await supabaseAdmin
      .from('rooms')
      .upsert(toInsert, { onConflict: 'property_id,date,number' });
    if (insErr) throw insErr;
  }

  if (updates.length > 0) {
    await Promise.all(updates);
  }

  // ─── Phantom-seed: inventory rooms not in CSV and not in DB ─────────────
  if (inventory.length > 0) {
    const csvNumbers = new Set(
      csvRooms.map((r) => r.number).filter((n): n is string => !!n),
    );
    const phantomRows: Array<Record<string, unknown>> = [];
    for (const num of inventory) {
      if (csvNumbers.has(num)) continue;
      if (existingByNumber.has(num)) continue;
      phantomRows.push({
        property_id: propertyId,
        number: num,
        date,
        type: 'vacant',
        status: 'clean',
        priority: 'standard',
      });
    }
    if (phantomRows.length > 0) {
      const { error: phantomErr } = await supabaseAdmin
        .from('rooms')
        .upsert(phantomRows, { onConflict: 'property_id,date,number' });
      if (phantomErr) throw phantomErr;
      phantomCreated = phantomRows.length;
      created += phantomCreated;
    }
  }

  return {
    created,
    updated,
    phantomCreated,
    csvPulledAt: planRes.data?.pulled_at ? String(planRes.data.pulled_at) : null,
    csvAvailable,
    inventoryLength: inventory.length,
  };
}
