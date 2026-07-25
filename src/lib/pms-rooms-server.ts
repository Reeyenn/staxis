// ═══════════════════════════════════════════════════════════════════════════
// pms-rooms-server — server-only merge: pms_* tables → legacy Room shape.
//
// Why this exists:
//   Plan v4 (migration 0204) dropped the legacy `rooms` table. Live room
//   status now flows into 15 service-role-only `pms_*` tables written by
//   the persistent CUA browser per hotel. The housekeeping page (and
//   dashboard, front-desk, etc.) still consume the camel-cased `Room`
//   shape from `src/types`. This module bridges the two without changing
//   the UI: pull the four relevant pms_* feeds, dedupe to "current per
//   room", and emit Room[] in the legacy shape.
//
// Server-only:
//   pms_* tables are RLS deny-all-browser (migration 0202). The browser
//   anon/authenticated clients cannot read them. This module imports
//   `supabaseAdmin` and MUST never be imported from a client-side file —
//   doing so would crash at module load (supabase-admin.ts throws when
//   env vars are missing on the browser side). The data path is:
//
//     browser  →  /api/housekeeping/rooms  →  mergePmsRoomsForDate()
//                                            (this file, supabaseAdmin)
//
// Mapping notes (legacy Room field ← new pms_* source):
//   number          ← pms_rooms_inventory.room_number
//   type            ← derived from cleaning_type, merged as
//                     coalesce(room_work, pms_housekeeping_assignments) — 0346
//                     ('departure'→'checkout', 'stayover'→'stayover',
//                     else 'vacant')
//   priority        ← always 'standard' (no clean source in new schema)
//   status          ← room_work-first derivation (the mirror has no status):
//                       assignment.completed_at set                → 'clean'
//                       assignment.started_at + !completed_at      → 'in_progress'
//                       assignment present + not started           → 'dirty'
//                       no assignment + status='inspected'         → 'inspected'
//                       no assignment + status ends with '_clean'  → 'clean'
//                       no assignment + status='occupied'          → 'clean'
//                       no assignment + everything else            → 'dirty'
//                     Rationale: today's HK assignment is the authoritative
//                     "needs cleaning" signal. PMS status only matters when
//                     no assignment exists (room not on today's HK plan).
//                     Out-of-order rooms ride the work-order badge layer
//                     in the UI, not a separate status — RoomsTab's openWoRooms
//                     set picks them up via pms_work_orders_v2.
//   assignedTo      ← room_work.assigned_staff_id (an identity), falling back
//                     to an NFC-normalized space-collapsed name match against
//                     the mirror's housekeeper_name. Diacritic-safe. — 0346
//   assignedName    ← staff.name of assigned_staff_id, else the mirror's
//                     housekeeper_name (trimmed)
//   startedAt       ← room_work.started_at
//   completedAt     ← room_work.completed_at
//   isDnd           ← coalesce(room_work.dnd_active, mirror.dnd_active)
//   arrival         ← if pms_reservations.arrival_date == date AND
//                     status IN ('booked','checked_in'): formatted M/D/YY
//   stayoverDay     ← if reservation overlaps date (arrival < date <
//                     departure), date - arrival_date in nights
//   stayoverMinutes ← undefined (Optii-style time classification not in
//                     the new schema)
//   issueNote, dndNote, helpRequested, managerNotes, housekeeperNote,
//   isRush, rushDueBy, markedForInspectionAt, inspectedBy, inspectedAt
//                   ← room_work (0346; formerly the workflow columns added to
//                     pms_housekeeping_assignments by 0269 + 0270). These were
//                     Maria-set fields on the legacy `rooms` table; they now
//                     live on the Staxis-owned half of the split, where the PMS
//                     ingest physically cannot reach them, and round-trip
//                     through workflowStateFields().
//   checklist, photoUrl
//                   ← undefined (legacy unused; no source in new schema)
//
// "Current status" dedupe:
//   pms_room_status_log is append-only. We fetch the last 90 days of rows
//   for the property (no row limit — Supabase default page size is bumped
//   via range), ordered by changed_at DESC, then take the first
//   occurrence per room_number — that's the latest status. The 90-day
//   window is generous: a limited-service hotel turns every room many
//   times a month, so genuine 90+ day gaps essentially don't happen.
//   Status is also a fallback signal — the authoritative "needs cleaning
//   today" signal is the assignments table.
//
// Resilience (M8):
//   Inventory is the only hard requirement — without rooms, there's
//   nothing to render. The other four queries (status_log, assignments,
//   reservations, staff) run via Promise.allSettled. Any individual
//   query failure degrades gracefully (the corresponding map is empty,
//   the merge proceeds). The whole endpoint does NOT 500 because one
//   secondary feed had a transient error.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import type { Room, RoomStatus, RoomType } from '@/types';
import { log } from './log';

// ── Status mapping ─────────────────────────────────────────────────────────
// Assignment-first derivation. Today's HK assignment row is the canonical
// "what's the room's housekeeping state right now?" signal. PMS status_log
// is only a fallback when no assignment exists. M1 + M2 fix.
function deriveStatus(
  assignment: AssignmentRow | undefined,
  rawStatus: string | null,
): RoomStatus {
  if (assignment) {
    // Assignment status enum (pms_housekeeping_assignments.status):
    // 'not_started' | 'in_progress' | 'completed' | 'refused' | 'skipped'.
    // Plus the started_at / completed_at timestamps which can be set
    // independently by the CUA.
    // Inspection sign-off (migration 0270 gives inspected_at a pms_* home)
    // wins over plain 'clean' so the board shows the distinct 'inspected'
    // state — but only while the room is still in a completed state, so a
    // re-dirtied room with a stale inspected_at doesn't read as inspected.
    if (assignment.inspected_at && (assignment.status === 'completed' || assignment.completed_at)) {
      return 'inspected';
    }
    if (assignment.status === 'completed' || assignment.completed_at) {
      return 'clean';
    }
    if (assignment.started_at && !assignment.completed_at) {
      return 'in_progress';
    }
    // not_started / refused / skipped / null → needs attention from staff.
    return 'dirty';
  }
  // No assignment today — fall back to PMS status_log.
  if (rawStatus === 'inspected') return 'inspected';
  if (rawStatus && rawStatus.endsWith('_clean')) return 'clean';
  // 'occupied' (steady-state, no clean needed today) → 'clean'. The room
  // isn't on today's HK plan AND the PMS says a guest is in it; the
  // housekeeping board has no work to do here.
  if (rawStatus === 'occupied') return 'clean';
  // Everything else (vacant_dirty, occupied_dirty, out_of_order,
  // out_of_inventory, unknown, null) defaults to 'dirty'. Out-of-order
  // rooms get a separate visual treatment via pms_work_orders_v2 / the
  // openWoRooms badge layer in RoomsTab.
  //
  // NOTE: deriveStatus stays purely status_log-based for back-compat with
  // its callers and tests. Out-of-service rooms are split out at the Room
  // composition layer below (isOutOfServiceStatus), where the full row
  // context is available — so 'dirty' here is a safe default; it gets
  // overridden for OOO/OOS rooms before the Room is emitted.
  return 'dirty';
}

// feat/cua-partial-promotion — provenance for Room.status. The UI needs to
// tell a REAL dirty (assignment says not_started; PMS says vacant_dirty)
// from the catch-all default that fires when there is NO signal at all —
// because when the roomStatus feed is still learning, the default branch is
// exactly the fake-"all rooms dirty" shape that must render neutral instead.
// 'unknown' counts as no-signal: it's the enum's "PMS said something
// unmappable" bucket, not a trustworthy state.
function deriveStatusSource(
  assignment: AssignmentRow | undefined,
  rawStatus: string | null,
): NonNullable<Room['statusSource']> {
  if (assignment) return 'assignment';
  if (rawStatus && rawStatus !== 'unknown') return 'pms';
  return 'default';
}

// PMS status_log values that mean the room is blocked / out of service —
// not a housekeeping turn. A guest can't be placed in it and HK won't
// clean it, so it must NOT land in the 'dirty' ("needs turning") bucket
// that the dashboard / laundry counts read. RoomsTab has a work-order
// badge overlay that catches OOO rooms with an open WO, but the dashboard
// and laundry have no such overlay — they read Room.status directly and
// would otherwise count these as dirty. We tag them with isOutOfService so
// those surfaces can bucket them separately. Mirrors BLOCKED_ROOM_STATUSES
// in rules-engine/context.ts.
const OUT_OF_SERVICE_STATUSES = new Set<string>([
  'out_of_order',
  'out_of_inventory',
]);

export function isOutOfServiceStatus(
  rawStatus: string | null | undefined,
): boolean {
  return !!rawStatus && OUT_OF_SERVICE_STATUSES.has(rawStatus);
}

// cleaning_type → legacy RoomType. Limited-service hotels only really see
// departure / stayover; deep/refresh/inspection/arrival aren't in the
// legacy union so default to 'checkout' for rendering purposes.
export function mapType(cleaningType: string | null | undefined): RoomType {
  if (cleaningType === 'stayover') return 'stayover';
  if (cleaningType === 'departure') return 'checkout';
  return 'vacant';
}

// "M/D/YY" — what the legacy CSV scraper wrote into Room.arrival, kept
// identical so the existing UI badge renders unchanged.
export function formatArrivalMDY(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(-2)}`;
}

// Difference in whole days between two YYYY-MM-DD strings. arrivalDate
// must be strictly before targetDate for stayoverDay to be >= 1.
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

// Normalize a name for cross-source matching:
//   NFD decompose → strip combining diacritics → NFC recompose →
//   lower-case + trim + collapse internal whitespace.
//
// "María" and "Maria" both → "maria". "Maria  Smith  " → "maria smith".
// Diacritics ARE stripped (not just NFC-normalized) — PMS entry rarely
// preserves accents while Staxis-side staff records often do, so this
// gives the most reliable cross-source match.
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks (U+0300–U+036F)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Re-export for tests + readability where the assignment-first rule is
// referenced. mapStatus is the entry point for status derivation.
export const mapStatus = deriveStatus;

// Reverse: legacy RoomType → cleaning_type, for the write path that lands
// a tile-cycle into pms_housekeeping_assignments.cleaning_type.
export function reverseMapType(
  type: RoomType | null | undefined,
): string | null {
  if (type === 'stayover') return 'stayover';
  if (type === 'checkout') return 'departure';
  return null;
}

// ── Cross-date Room.id format ──────────────────────────────────────────────
// The housekeeper SMS link page (mergePmsRoomsForStaff below) returns rooms
// across multiple dates. Room.id needs to be unique per (date, room_number);
// the inventory UUID alone doesn't carry the date. Compose / parse helpers
// keep the format consistent and parseable on the write side.

export function composeRoomId(date: string, roomNumber: string): string {
  return `${date}:${roomNumber}`;
}

export function parseRoomId(
  rid: string,
): { date: string; roomNumber: string } | null {
  if (!rid || !rid.includes(':')) return null;
  const idx = rid.indexOf(':');
  const date = rid.slice(0, idx);
  const roomNumber = rid.slice(idx + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !roomNumber) return null;
  return { date, roomNumber };
}

// ── Staff lookup (collision-aware first-name fallback) ─────────────────────
// Two-tier match:
//   1. Exact normalized full-name match (NFC + strip diacritics + lower +
//      collapse whitespace).
//   2. First-name fallback — ONLY when the first name is unique among
//      this property's staff. Two housekeepers named "Maria" disable the
//      first-name fallback for both, so neither gets the other's rooms.

export interface StaffLookup {
  /** Look up a staff id by housekeeper name string. Returns undefined on no match. */
  resolve(name: string | null | undefined): string | undefined;
}

export function buildStaffLookup(
  rows: Array<{ id: string; name: string | null }>,
): StaffLookup {
  const byFullName = new Map<string, string>();
  const firstNameCounts = new Map<string, number>();
  const firstNameIds = new Map<string, string>();
  for (const row of rows) {
    const full = normalizeName(row.name);
    if (!full) continue;
    if (!byFullName.has(full)) byFullName.set(full, row.id);
    const firstName = full.split(' ')[0];
    if (firstName) {
      firstNameCounts.set(firstName, (firstNameCounts.get(firstName) ?? 0) + 1);
      if (!firstNameIds.has(firstName)) firstNameIds.set(firstName, row.id);
    }
  }
  return {
    resolve(rawName) {
      const full = normalizeName(rawName);
      if (!full) return undefined;
      const exact = byFullName.get(full);
      if (exact) return exact;
      const firstName = full.split(' ')[0];
      if (!firstName) return undefined;
      // Collision-aware: only fall back when the first name is unique.
      if ((firstNameCounts.get(firstName) ?? 0) !== 1) return undefined;
      return firstNameIds.get(firstName);
    },
  };
}

interface InventoryRow {
  id: string;
  room_number: string;
  room_type: string | null;
}

interface StatusLogRow {
  room_number: string;
  status: string;
  changed_at: string;
}

// ── The 0346 mirror / state split ──────────────────────────────────────────
// pms_housekeeping_assignments is now a READ-ONLY MIRROR of what the PMS
// housekeeping report printed. Everything Staxis knows about a room's day —
// lifecycle, pause accounting, checklist, exceptions, notes, rush, inspection —
// lives in public.room_work, which the ingest physically cannot write.
//
// Nothing downstream of this file changed: both halves are merged back into the
// same `AssignmentRow` shape deriveStatus/mapType/workflowStateFields already
// consume. The merge rule is:
//
//   • app-owned columns          → room_work only (they are not on the mirror)
//   • cleaning_type, dnd_active  → coalesce(room_work, mirror)
//        The manager's explicit action beats the report; absent an action, the
//        report stands. NULL in room_work means "Staxis has no opinion", which
//        is why the write path stores false — not NULL — for "explicitly off".
//   • the housekeeper            → room_work.assigned_staff_id (identity),
//        falling back to name-matching the mirror's housekeeper_name. The
//        fallback is what keeps the PUBLIC housekeeper SMS link working before
//        any room_work assignment exists.

/** The PMS-reported half — pms_housekeeping_assignments after 0346. */
interface MirrorRow {
  room_number: string;
  housekeeper_name: string | null;
  cleaning_type: string | null;
  dnd_active: boolean | null;
}

/** The Staxis-owned half — public.room_work. */
interface RoomWorkRow {
  room_number: string;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  cleaning_type: string | null;
  dnd_active: boolean | null;
  assigned_staff_id: string | null;
  is_paused: boolean | null;
  paused_at: string | null;
  total_paused_seconds: number | null;
  exception_type: string | null;
  exception_note: string | null;
  exception_at: string | null;
  checklist_template_id: string | null;
  checklist_progress: string[] | null;
  manager_notes: string | null;
  housekeeper_note: string | null;
  is_rush: boolean | null;
  rush_due_by: string | null;
  marked_for_inspection_at: string | null;
  inspected_by: string | null;
  inspected_at: string | null;
  issue_note: string | null;
  help_requested: boolean | null;
  dnd_note: string | null;
}

/** Columns the merge needs from each half. Kept next to the row types so a
 *  column added to one and forgotten in the other is one diff, not two. */
export const MIRROR_SELECT = 'room_number, housekeeper_name, cleaning_type, dnd_active';
// Single string literal, NOT a concatenation: supabase-js infers the row type
// from the literal type of the select string, and `a + b` widens it to `string`
// which silently degrades every result to GenericStringError.
export const ROOM_WORK_SELECT = 'room_number, status, started_at, completed_at, cleaning_type, dnd_active, assigned_staff_id, is_paused, paused_at, total_paused_seconds, exception_type, exception_note, exception_at, checklist_template_id, checklist_progress, manager_notes, housekeeper_note, is_rush, rush_due_by, marked_for_inspection_at, inspected_by, inspected_at, issue_note, help_requested, dnd_note';

/**
 * Fold one room's PMS mirror row and Staxis work row into the single shape the
 * rest of this file consumes. Returns undefined only when neither half exists.
 *
 * `staffNameById` resolves an assigned_staff_id back to a display name so the
 * `housekeeper_name` field of the merged row stays the caller-visible string it
 * has always been.
 */
export function mergeAssignment(
  mirror: MirrorRow | undefined,
  work: RoomWorkRow | undefined,
  staffNameById: Map<string, string>,
): AssignmentRow | undefined {
  if (!mirror && !work) return undefined;
  const roomNumber = String(work?.room_number ?? mirror?.room_number ?? '');
  const assignedName =
    (work?.assigned_staff_id ? staffNameById.get(work.assigned_staff_id) : undefined)
    ?? mirror?.housekeeper_name
    ?? null;
  return {
    room_number: roomNumber,
    housekeeper_name: assignedName,
    assigned_staff_id: work?.assigned_staff_id ?? null,
    cleaning_type: work?.cleaning_type ?? mirror?.cleaning_type ?? null,
    dnd_active: work?.dnd_active ?? mirror?.dnd_active ?? null,
    status: work?.status ?? null,
    started_at: work?.started_at ?? null,
    completed_at: work?.completed_at ?? null,
    is_paused: work?.is_paused ?? null,
    paused_at: work?.paused_at ?? null,
    total_paused_seconds: work?.total_paused_seconds ?? null,
    exception_type: work?.exception_type ?? null,
    exception_note: work?.exception_note ?? null,
    exception_at: work?.exception_at ?? null,
    checklist_template_id: work?.checklist_template_id ?? null,
    checklist_progress: work?.checklist_progress ?? null,
    manager_notes: work?.manager_notes ?? null,
    housekeeper_note: work?.housekeeper_note ?? null,
    is_rush: work?.is_rush ?? null,
    rush_due_by: work?.rush_due_by ?? null,
    marked_for_inspection_at: work?.marked_for_inspection_at ?? null,
    inspected_by: work?.inspected_by ?? null,
    inspected_at: work?.inspected_at ?? null,
    issue_note: work?.issue_note ?? null,
    help_requested: work?.help_requested ?? null,
    dnd_note: work?.dnd_note ?? null,
  };
}

/**
 * Does this merged row belong to `staffId`?
 *
 * Precedence: an explicit room_work assignment (by id) is authoritative. Only
 * when there is none do we fall back to matching the PMS-printed name through
 * the collision-aware StaffLookup — today's rule, kept so the public
 * housekeeper page behaves identically before any id-based assignment exists.
 *
 * LOAD-BEARING for the public SMS-link page: getting this wrong renders a
 * housekeeper's shift as "no work", which is indistinguishable from a genuine
 * empty day.
 */
export function assignmentBelongsToStaff(
  assignment: Pick<AssignmentRow, 'assigned_staff_id' | 'housekeeper_name'>,
  staffId: string,
  staffLookup: StaffLookup,
): boolean {
  if (assignment.assigned_staff_id) return assignment.assigned_staff_id === staffId;
  return staffLookup.resolve(assignment.housekeeper_name) === staffId;
}

interface AssignmentRow {
  room_number: string;
  housekeeper_name: string | null;
  /** 0346: the identity-based assignment, when one exists. */
  assigned_staff_id?: string | null;
  cleaning_type: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  dnd_active: boolean | null;
  // Workflow state (migration 0269) — persisted by the housekeeper
  // start/pause/resume/complete/exception + checklist endpoints. Optional so
  // callers/tests that build a minimal assignment shape still satisfy the type.
  is_paused?: boolean | null;
  paused_at?: string | null;
  total_paused_seconds?: number | null;
  exception_type?: string | null;
  exception_note?: string | null;
  exception_at?: string | null;
  checklist_template_id?: string | null;
  checklist_progress?: string[] | null;
  // Workflow-state remainder (migration 0270) — the legacy `rooms` workflow
  // fields that previously had no pms_* home. Optional so minimal assignment
  // shapes built by callers/tests still satisfy the type.
  manager_notes?: string | null;
  housekeeper_note?: string | null;
  is_rush?: boolean | null;
  rush_due_by?: string | null;
  marked_for_inspection_at?: string | null;
  inspected_by?: string | null;
  inspected_at?: string | null;
  issue_note?: string | null;
  help_requested?: boolean | null;
  dnd_note?: string | null;
}

interface ReservationRow {
  room_number: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  status: string | null;
}

interface StaffNameRow {
  id: string;
  name: string;
}

// Type-narrowing helpers — Promise.allSettled doesn't preserve our row
// types in TypeScript without a guard. Supabase queries without
// `.single()` resolve to `{ data: T[] | null; error }` — the signature
// must reflect that or strict tsc rejects every call site.
function fulfilledData<T>(
  result: PromiseSettledResult<{ data: T[] | null; error: unknown }>,
  tag: string,
  pid: string,
  date: string,
): T[] {
  if (result.status === 'rejected') {
    log.error(`[pms-rooms-server] ${tag} query rejected`, {
      pid, date, msg: String(result.reason),
    });
    return [];
  }
  const { data, error } = result.value;
  if (error) {
    log.error(`[pms-rooms-server] ${tag} query failed`, {
      pid, date, msg: (error as { message?: string }).message ?? String(error),
    });
    return [];
  }
  return data ?? [];
}

/**
 * Merge pms_* tables into the legacy `Room[]` shape for a (property, date).
 * Used by /api/housekeeping/rooms (today's board) and any other server-
 * side caller that needs the same view.
 *
 * Strategy:
 *   1. Pull pms_rooms_inventory — every known room for the property.
 *      Hard requirement; throws on failure.
 *   2-5. Pull status_log + assignments + reservations + staff in parallel
 *      via Promise.allSettled. Each is non-fatal; a failure produces an
 *      empty map for that feed and the merge proceeds.
 *   6. Compose one Room per inventory row.
 */
export async function mergePmsRoomsForDate(
  pid: string,
  date: string,
): Promise<Room[]> {
  // 1. Inventory — the canonical list of rooms. HARD requirement.
  const { data: inventoryRows, error: invErr } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .select('id, room_number, room_type')
    .eq('property_id', pid)
    .order('room_number', { ascending: true });
  if (invErr) {
    log.error('[pms-rooms-server] inventory query failed', {
      pid, date, msg: invErr.message,
    });
    throw invErr;
  }
  const inventory = (inventoryRows ?? []) as InventoryRow[];
  if (inventory.length === 0) return [];

  // 2-5. Parallel non-fatal queries — M8 fix.
  // Status log: 90-day window, ordered newest-first, dedupe-to-latest in TS.
  // No row-cap on this query — the index (property_id, room_number,
  // changed_at desc) handles it. M2 + M3 fix replaces the original
  // 30-day-window + 10k-cap which could silently miss rooms.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [statusRes, mirrorRes, workRes, resRes, staffRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_room_status_log')
      .select('room_number, status, changed_at')
      .eq('property_id', pid)
      .gte('changed_at', ninetyDaysAgo)
      .order('changed_at', { ascending: false }),
    // 0346: two halves, merged below. The mirror is what the PMS reported;
    // room_work is what Staxis knows.
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select(MIRROR_SELECT)
      .eq('property_id', pid)
      .eq('date', date),
    supabaseAdmin
      .from('room_work')
      .select(ROOM_WORK_SELECT)
      .eq('property_id', pid)
      .eq('date', date),
    // M4 fix — deterministic order so double-bookings produce the
    // earliest-arrival reservation consistently, not Postgres page order.
    supabaseAdmin
      .from('pms_reservations')
      .select('room_number, arrival_date, departure_date, status')
      .eq('property_id', pid)
      .lte('arrival_date', date)
      // .gte (not .gt) so today's checkouts (departure_date == date) are
      // included — laundry checkout/stayover counts read 0 on a turn day
      // otherwise, before the CUA has populated assignments.
      .gte('departure_date', date)
      .in('status', ['booked', 'checked_in'])
      .order('arrival_date', { ascending: true }),
    supabaseAdmin
      .from('staff')
      .select('id, name')
      .eq('property_id', pid),
  ]);

  const statusRows = fulfilledData<StatusLogRow>(statusRes, 'status_log', pid, date);
  const mirrorRows = fulfilledData<MirrorRow>(mirrorRes, 'hk_mirror', pid, date);
  const workRows = fulfilledData<RoomWorkRow>(workRes, 'room_work', pid, date);
  const reservationRows = fulfilledData<ReservationRow>(resRes, 'reservations', pid, date);
  const staffRows = fulfilledData<StaffNameRow>(staffRes, 'staff', pid, date);

  // Dedupe status_log → latest per room_number.
  const latestStatusByRoom = new Map<string, string>();
  for (const row of statusRows) {
    const num = String(row.room_number ?? '');
    if (!num || latestStatusByRoom.has(num)) continue;
    latestStatusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  // One row per (date, room) in each half; both are keyed the same way, so the
  // merged map is 1:1. A room can legitimately appear in only one half — a
  // manager-created work row before the PMS has reported it, or a reported
  // room nobody has touched yet.
  const staffNameById = new Map<string, string>(
    staffRows.filter(s => s.name).map(s => [s.id, String(s.name)]),
  );
  const mirrorByRoom = new Map<string, MirrorRow>();
  for (const row of mirrorRows) mirrorByRoom.set(String(row.room_number ?? ''), row);
  const workByRoom = new Map<string, RoomWorkRow>();
  for (const row of workRows) workByRoom.set(String(row.room_number ?? ''), row);

  const assignmentByRoom = new Map<string, AssignmentRow>();
  for (const num of new Set([...mirrorByRoom.keys(), ...workByRoom.keys()])) {
    const merged = mergeAssignment(mirrorByRoom.get(num), workByRoom.get(num), staffNameById);
    if (merged) assignmentByRoom.set(num, merged);
  }

  // Reservation per room — deterministic first-match-wins via the
  // arrival_date order. For double-booked rooms this consistently picks
  // the reservation that started first (typically the original booking).
  const reservationByRoom = new Map<string, ReservationRow>();
  let doubleBookedCount = 0;
  for (const row of reservationRows) {
    const num = String(row.room_number ?? '');
    if (!num) continue;
    if (reservationByRoom.has(num)) {
      doubleBookedCount++;
      continue;
    }
    reservationByRoom.set(num, row);
  }
  if (doubleBookedCount > 0) {
    log.warn('[pms-rooms-server] reservations: overlapping bookings detected', {
      pid, date, doubleBookedCount,
    });
  }

  // Staff name → id lookup with collision-aware fuzzy match. Two staff
  // sharing a first name disable the first-name fallback for both, so
  // a bare "Maria" assignment doesn't get routed to the wrong Maria.
  const staffLookup = buildStaffLookup(staffRows);

  // 6. Compose Room[] — one per inventory row.
  const rooms: Room[] = [];
  for (const inv of inventory) {
    const num = String(inv.room_number);
    const assignment = assignmentByRoom.get(num);
    const reservation = reservationByRoom.get(num);
    const rawStatus = latestStatusByRoom.get(num) ?? null;

    // Out-of-service rooms (OOO / OOS in the status_log) with no active
    // HK assignment must not be counted as 'dirty'. They're blocked, not a
    // turn — force a non-dirty status and flag them so the dashboard /
    // laundry (no work-order overlay) can bucket them as out-of-service.
    const outOfService = !assignment && isOutOfServiceStatus(rawStatus);
    const status = outOfService ? 'clean' : deriveStatus(assignment, rawStatus);
    // Type: assignment wins once it exists. Before the CUA has populated
    // assignments, fall back to deriving the turn type from the reservation
    // so laundry checkout/stayover counts aren't all 0 on a real turn day.
    let reservationDerivedType: RoomType | undefined;
    if (!assignment && reservation) {
      if (reservation.departure_date === date) {
        reservationDerivedType = 'checkout';
      } else if (
        (reservation.arrival_date ?? '') < date &&
        (reservation.departure_date ?? '') > date
      ) {
        reservationDerivedType = 'stayover';
      }
    }
    const type = assignment
      ? mapType(assignment.cleaning_type)
      : (reservationDerivedType ?? 'vacant');

    const assignedNameRaw = assignment?.housekeeper_name?.trim() || undefined;
    // 0346: an id-based assignment is authoritative; the name match is the
    // fallback for rooms the PMS named but nobody has assigned in Staxis.
    const assignedTo = assignment?.assigned_staff_id ?? staffLookup.resolve(assignedNameRaw);

    let arrival: string | undefined;
    let stayoverDay: number | undefined;
    if (reservation?.arrival_date) {
      if (reservation.arrival_date === date) {
        arrival = formatArrivalMDY(reservation.arrival_date);
      } else if (
        reservation.arrival_date < date &&
        (reservation.departure_date ?? '') > date
      ) {
        stayoverDay = daysBetween(reservation.arrival_date, date);
      }
    }

    const room: Room = {
      // Composite "${date}:${room_number}" id (Codex Major #2). The previous
      // version used inv.id (a UUID with no date encoded), which made the
      // write path ambiguous when a manager edited a non-today view —
      // resolveRoomKey would default to today on a UUID rid even when the
      // tile actually belonged to yesterday. Composite ids carry the
      // viewed date through, so writes land on the right assignment row.
      id: composeRoomId(date, num),
      number: num,
      type,
      priority: 'standard',
      status,
      statusSource: deriveStatusSource(assignment, rawStatus),
      date,
      propertyId: pid,
      ...(assignedTo ? { assignedTo } : {}),
      ...(assignedNameRaw ? { assignedName: assignedNameRaw } : {}),
      ...(assignment?.started_at
        ? { startedAt: new Date(assignment.started_at) }
        : {}),
      ...(assignment?.completed_at
        ? { completedAt: new Date(assignment.completed_at) }
        : {}),
      ...(assignment?.dnd_active === true ? { isDnd: true } : {}),
      ...workflowStateFields(assignment),
      ...(arrival ? { arrival } : {}),
      ...(stayoverDay !== undefined ? { stayoverDay } : {}),
      // isOutOfService: distinct out-of-service flag so dirty/ready counts
      // can exclude OOO/OOS rooms. Cast: the `Room` type (src/types) does
      // not yet declare this optional field; producer-side cast keeps tsc
      // green here. Consumers read it as an optional boolean.
      ...(outOfService ? { isOutOfService: true } : {}),
    } as Room;
    rooms.push(room);
  }

  return rooms;
}

// Map the workflow-state columns (migration 0269) onto the Room shape. Shared
// by both the single-date and cross-date merges so the housekeeper page sees
// pause / checklist / exception state persisted by the workflow endpoints.
function workflowStateFields(assignment: AssignmentRow | undefined): Partial<Room> {
  if (!assignment) return {};
  const out: Partial<Room> = {};
  if (assignment.is_paused === true) out.isPaused = true;
  if (assignment.paused_at) out.pausedAt = new Date(assignment.paused_at);
  if (assignment.total_paused_seconds && assignment.total_paused_seconds > 0) {
    out.totalPausedSeconds = assignment.total_paused_seconds;
  }
  if (assignment.exception_type) {
    out.exceptionType = assignment.exception_type as Room['exceptionType'];
  }
  if (assignment.exception_note) out.exceptionNote = assignment.exception_note;
  if (assignment.exception_at) out.exceptionAt = new Date(assignment.exception_at);
  if (assignment.checklist_template_id) out.checklistTemplateId = assignment.checklist_template_id;
  if (assignment.checklist_progress && assignment.checklist_progress.length > 0) {
    out.checklistProgress = assignment.checklist_progress;
  }
  // Workflow-state remainder (migration 0270): the previously-orphaned legacy
  // `rooms` workflow fields now persisted on the assignment row.
  if (assignment.issue_note) out.issueNote = assignment.issue_note;
  if (assignment.dnd_note) out.dndNote = assignment.dnd_note;
  if (assignment.help_requested === true) out.helpRequested = true;
  if (assignment.manager_notes) out.managerNotes = assignment.manager_notes;
  if (assignment.housekeeper_note) out.housekeeperNote = assignment.housekeeper_note;
  if (assignment.is_rush === true) out.isRush = true;
  if (assignment.rush_due_by) out.rushDueBy = new Date(assignment.rush_due_by);
  if (assignment.marked_for_inspection_at) {
    out.markedForInspectionAt = new Date(assignment.marked_for_inspection_at);
  }
  if (assignment.inspected_by) out.inspectedBy = assignment.inspected_by;
  if (assignment.inspected_at) out.inspectedAt = new Date(assignment.inspected_at);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// mergePmsRoomsForStaff — housekeeper SMS link (cross-date)
// ═══════════════════════════════════════════════════════════════════════════
// /api/housekeeper/rooms historically returned ALL rooms ever assigned to
// one housekeeper across dates (the page picks today/next-future/last-past
// client-side via byDate.get(today)). We need the same shape here.
//
// Differences from mergePmsRoomsForDate:
//   - Cross-date: returns one Room per (assignment date, room_number)
//   - Room.id format: "${date}:${room_number}" so the React keys + the
//     page's byDate grouping stay unique across dates
//   - Window: assignments [today-30d, today+30d] — generous on both sides
//     so a HK returning to the page after a few days off still sees their
//     last-worked date, and tomorrow's prebooked work shows up too
//   - Match: staff resolved by canonical name via StaffLookup; collision-
//     aware first-name fallback means "Maria S." matches "Maria Smith"
//     only if she's the only Maria on the property
//   - Reservations: queried for the full assignment window so per-date
//     arrival/stayoverDay flags are correct on past/future cards too
//   - Assignments: hard-required (Codex Major #13 — silent empty when the
//     assignments query fails would render every shift as "no work")

export async function mergePmsRoomsForStaff(
  pid: string,
  staffId: string,
): Promise<Room[]> {
  // 1. Resolve the staff record — canonical name to filter assignments by.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[pms-rooms-server] staff lookup failed', {
      pid, staffId, msg: staffErr.message,
    });
    throw staffErr;
  }
  if (!staffRow || !staffRow.name) return [];

  // 2. Date window + assignments + full staff roster (for collision-aware
  //    fallback) in parallel.
  //
  // Codex Major #7: a 60-day window (-30/+30) returned every assignment
  // for the property — ~3,600 rows for a 60-room hotel before TS-side
  // filtering to this staff. Tightened to -14/+14 days (29-day window,
  // ~1,700 rows worst-case). The housekeeper page realistically needs
  // today + yesterday's overflow + tomorrow's pre-load; 14 days each
  // side is generous.
  const today = new Date().toISOString().slice(0, 10);
  const windowBack = new Date(Date.now() - 14 * 86_400_000)
    .toISOString().slice(0, 10);
  const windowAhead = new Date(Date.now() + 14 * 86_400_000)
    .toISOString().slice(0, 10);

  const [mirrorRes, workRes, staffListRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select(`date, ${MIRROR_SELECT}`)
      .eq('property_id', pid)
      .gte('date', windowBack)
      .lte('date', windowAhead),
    supabaseAdmin
      .from('room_work')
      .select(`date, ${ROOM_WORK_SELECT}`)
      .eq('property_id', pid)
      .gte('date', windowBack)
      .lte('date', windowAhead),
    supabaseAdmin
      .from('staff')
      .select('id, name')
      .eq('property_id', pid),
  ]);

  // BOTH halves are a hard requirement (Codex Major #13, extended for 0346).
  // This is the PUBLIC, unauthenticated housekeeper SMS-link path: a failed
  // query that degrades to an empty array renders every shift as "no work",
  // which is indistinguishable from a genuine day off. Fail loudly instead —
  // the route turns a throw into a 500 the housekeeper can report, not a
  // convincing lie.
  const requireHalf = <T,>(
    res: PromiseSettledResult<{ data: T[] | null; error: { message: string } | null }>,
    tag: string,
  ): T[] => {
    if (res.status === 'rejected') {
      log.error(`[pms-rooms-server] ${tag}-for-staff query rejected`, {
        pid, staffId, msg: String(res.reason),
      });
      throw new Error(`${tag} query failed`);
    }
    if (res.value.error) {
      log.error(`[pms-rooms-server] ${tag}-for-staff query failed`, {
        pid, staffId, msg: res.value.error.message,
      });
      throw res.value.error;
    }
    return res.value.data ?? [];
  };

  const mirrorRows = requireHalf<MirrorRow & { date: string }>(mirrorRes, 'hk_mirror');
  const workRows = requireHalf<RoomWorkRow & { date: string }>(workRes, 'room_work');
  const staffListRows = fulfilledData<StaffNameRow>(staffListRes, 'staff', pid, today);

  // 3. Merge the two halves per (date, room), then filter to THIS staff member.
  const staffNameById = new Map<string, string>(
    staffListRows.filter(s => s.name).map(s => [s.id, String(s.name)]),
  );
  const keyOf = (date: string, room: string) => `${date} ${room}`;
  const mirrorByKey = new Map<string, MirrorRow>();
  for (const r of mirrorRows) mirrorByKey.set(keyOf(r.date, String(r.room_number ?? '')), r);
  const workByKey = new Map<string, RoomWorkRow>();
  for (const r of workRows) workByKey.set(keyOf(r.date, String(r.room_number ?? '')), r);

  const staffLookup = buildStaffLookup(staffListRows);
  const matching: (AssignmentRow & { date: string })[] = [];
  for (const key of new Set([...mirrorByKey.keys(), ...workByKey.keys()])) {
    const merged = mergeAssignment(mirrorByKey.get(key), workByKey.get(key), staffNameById);
    if (!merged) continue;
    if (!assignmentBelongsToStaff(merged, staffId, staffLookup)) continue;
    matching.push({ ...merged, date: key.slice(0, key.indexOf(' ')) });
  }
  if (matching.length === 0) return [];

  // 4. Supporting feeds for the matching room-numbers / date-window.
  //    Status log: 90-day window, latest per room.
  //    Reservations: full assignment window, per-(date,room) lookup.
  const [statusRes, resRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_room_status_log')
      .select('room_number, status, changed_at')
      .eq('property_id', pid)
      .gte('changed_at', new Date(Date.now() - 90 * 86_400_000).toISOString())
      .order('changed_at', { ascending: false }),
    supabaseAdmin
      .from('pms_reservations')
      .select('room_number, arrival_date, departure_date, status')
      .eq('property_id', pid)
      .lte('arrival_date', windowAhead)
      .gt('departure_date', windowBack)
      .in('status', ['booked', 'checked_in'])
      .order('arrival_date', { ascending: true }),
  ]);

  const statusRows = fulfilledData<StatusLogRow>(statusRes, 'status_log', pid, today);
  const reservationRows = fulfilledData<ReservationRow>(resRes, 'reservations', pid, today);

  const latestStatusByRoom = new Map<string, string>();
  for (const row of statusRows) {
    const num = String(row.room_number ?? '');
    if (!num || latestStatusByRoom.has(num)) continue;
    latestStatusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  // Per-(date, room) reservation lookup so future/past assignment cards
  // get the right arrival/stayover flags.
  const reservationByDateRoom = new Map<string, Map<string, ReservationRow>>();
  for (const r of reservationRows) {
    const num = String(r.room_number ?? '');
    if (!num || !r.arrival_date || !r.departure_date) continue;
    const start = r.arrival_date > windowBack ? r.arrival_date : windowBack;
    const endExclusive = r.departure_date < windowAhead ? r.departure_date : windowAhead;
    const startMs = Date.parse(start + 'T00:00:00Z');
    const endMs = Date.parse(endExclusive + 'T00:00:00Z');
    if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) continue;
    for (let t = startMs; t < endMs; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      let perDate = reservationByDateRoom.get(d);
      if (!perDate) {
        perDate = new Map();
        reservationByDateRoom.set(d, perDate);
      }
      if (!perDate.has(num)) perDate.set(num, r);
    }
  }

  // 5. Compose one Room per assignment row.
  const out: Room[] = [];
  for (const a of matching) {
    const num = String(a.room_number);
    const assignment = a;
    const reservation = reservationByDateRoom.get(a.date)?.get(num);
    const rawStatus = latestStatusByRoom.get(num) ?? null;

    const status = deriveStatus(assignment, rawStatus);
    const type = mapType(assignment.cleaning_type);

    const assignedNameRaw = assignment.housekeeper_name?.trim() || undefined;
    const assignedTo = assignment.assigned_staff_id ?? staffLookup.resolve(assignedNameRaw);

    let arrival: string | undefined;
    let stayoverDay: number | undefined;
    if (reservation?.arrival_date) {
      if (reservation.arrival_date === a.date) {
        arrival = formatArrivalMDY(reservation.arrival_date);
      } else if (
        reservation.arrival_date < a.date &&
        (reservation.departure_date ?? '') > a.date
      ) {
        stayoverDay = daysBetween(reservation.arrival_date, a.date);
      }
    }

    out.push({
      id: composeRoomId(a.date, num),
      number: num,
      type,
      priority: 'standard',
      status,
      // Always 'assignment' here — this merge composes one Room per
      // assignment row — but derive it anyway so the two merges can't drift.
      statusSource: deriveStatusSource(assignment, rawStatus),
      date: a.date,
      propertyId: pid,
      ...(assignedTo ? { assignedTo } : {}),
      ...(assignedNameRaw ? { assignedName: assignedNameRaw } : {}),
      ...(assignment.started_at ? { startedAt: new Date(assignment.started_at) } : {}),
      ...(assignment.completed_at ? { completedAt: new Date(assignment.completed_at) } : {}),
      ...(assignment.dnd_active === true ? { isDnd: true } : {}),
      ...workflowStateFields(assignment),
      ...(arrival ? { arrival } : {}),
      ...(stayoverDay !== undefined ? { stayoverDay } : {}),
    });
  }
  return out;
}
