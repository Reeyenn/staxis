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
export function mapRoomType(
  stayType: string | null | undefined,
  status: string | null | undefined,
): 'checkout' | 'stayover' | 'vacant' {
  if (stayType === 'C/O') return 'checkout';
  if (status === 'OCC') return 'stayover';
  return 'vacant';
}

// CSV `condition` → rooms.status. Anything not literal "Clean" is dirty.
export function mapRoomStatus(condition: string | null | undefined): 'clean' | 'dirty' {
  return condition === 'Clean' ? 'clean' : 'dirty';
}

/**
 * Decide the merge for a single existing room when the CSV mentions it.
 *
 * Pure function — takes the CSV row and the existing row's read-time state,
 * returns the patch to apply and the precondition status to attach to the
 * UPDATE's WHERE clause. The precondition is what closes the seeder race
 * (Round 15, Codex finding B): if the live status changed between read
 * and write, the UPDATE will affect 0 rows and the next seeder pass will
 * pick up the new state.
 *
 * Exported for unit testing.
 */
export interface RoomPatchPlan {
  patch: Record<string, unknown>;
  /** WHERE-clause precondition. UPDATE only lands if rooms.status equals
   *  this value at write time. Matches the snapshot status we read. */
  preconditionStatus: string;
}

export function planRoomPatch(csv: PlanRoom, existingStatus: string | null): RoomPatchPlan {
  const type = mapRoomType(csv.stayType, csv.status);
  const csvStatus = mapRoomStatus(csv.condition);
  const isMidClean = existingStatus === 'in_progress';
  const preconditionStatus = existingStatus ?? 'dirty';

  const patch: Record<string, unknown> = {
    type,
    status: csvStatus,
    issue_note: null,
    help_requested: false,
  };
  if (csvStatus === 'dirty' && !isMidClean) {
    patch.started_at = null;
    patch.completed_at = null;
  }
  if (isMidClean) {
    patch.status = 'in_progress';
  }
  patch.stayover_day = csv.stayoverDay ?? null;
  patch.stayover_minutes = csv.stayoverMinutes ?? null;
  patch.arrival = csv.arrival ?? null;

  return { patch, preconditionStatus };
}

/**
 * Decide the payload for a brand-new room (CSV mentions it, no existing
 * DB row). Pure function — exported for unit testing.
 */
export function planNewRoomInsert(csv: PlanRoom, propertyId: string, date: string): Record<string, unknown> {
  const type = mapRoomType(csv.stayType, csv.status);
  const status = mapRoomStatus(csv.condition);
  const payload: Record<string, unknown> = {
    property_id: propertyId,
    number: csv.number,
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
  return payload;
}

/**
 * Decide which inventory rooms get phantom-seeded as vacant + clean.
 * Pure function — takes the inventory + CSV-mentioned set + existing-rows
 * set, returns the list of room numbers to seed.
 */
export function planPhantomSeed(
  inventory: ReadonlyArray<string>,
  csvNumbers: ReadonlySet<string>,
  existingNumbers: ReadonlySet<string>,
): string[] {
  const phantoms: string[] = [];
  for (const num of inventory) {
    if (csvNumbers.has(num)) continue;
    if (existingNumbers.has(num)) continue;
    phantoms.push(num);
  }
  return phantoms;
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

  // Note on seeder-vs-seeder concurrency (Round 15 follow-up):
  // We do NOT take an advisory lock here. Two simultaneous seeders for
  // the same (property, date) would read identical state and compute
  // identical patches; the conditional UPDATEs below (.eq('status', ...))
  // make both writes idempotent — second one matches the same precondition
  // and writes the same payload. Adding a Postgres advisory lock would
  // add complexity (requires either a wrapping function or a lock table
  // with crash-recovery) without closing any new race. Seeder-vs-
  // housekeeper IS race-prone and IS closed by the conditional UPDATE.

  // ─── CSV branch: insert OR update each CSV row ──────────────────────────
  const toInsert: Array<Record<string, unknown>> = [];
  const updates: PromiseLike<unknown>[] = [];

  for (const csv of csvRooms) {
    const num = csv.number;
    if (!num) continue;

    const row = existingByNumber.get(num);
    if (row) {
      // Pure planning logic — see planRoomPatch for the merge semantics.
      // Round 15 (Codex finding B): the precondition closes the
      // 95a90a3 "started_at wiped to null" race.
      const { patch, preconditionStatus } = planRoomPatch(csv, row.status);
      updates.push(
        supabaseAdmin
          .from('rooms')
          .update(patch)
          .eq('id', row.id)
          .eq('status', preconditionStatus)
          .then(({ error }) => { if (error) throw error; }),
      );
      updated++;
    } else {
      toInsert.push(planNewRoomInsert(csv, propertyId, date));
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
    const existingNumbers = new Set(existingByNumber.keys());
    const phantomNumbers = planPhantomSeed(inventory, csvNumbers, existingNumbers);
    if (phantomNumbers.length > 0) {
      const phantomRows = phantomNumbers.map((num) => ({
        property_id: propertyId,
        number: num,
        date,
        type: 'vacant',
        status: 'clean',
        priority: 'standard',
      }));
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
