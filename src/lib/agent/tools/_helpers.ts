// Shared helpers for tool handlers. Each tool wants to look up a room by
// number, find a staff member by name, etc. — centralized so the lookups
// are consistent across the catalog.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { parseStringField, parseBoolField } from '@/lib/db-mappers';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { todayStr } from '@/lib/utils';
import type { AppRole } from '@/lib/roles';
import type { ToolContext } from '../tools';

export interface RoomRow {
  id: string;
  property_id: string;
  number: string;
  status: string;
  date: string | null;
  assigned_to: string | null;
  is_dnd: boolean;
  dnd_note: string | null;
  issue_note: string | null;
  help_requested: boolean;
  started_at: string | null;
  completed_at: string | null;
  type: 'checkout' | 'stayover' | 'vacant' | null;
}

/**
 * Compute an occupancy summary from three signals about hotel size and
 * the seeded rooms-for-today rows.
 *
 * Round 14 (2026-05-14) read total from `properties.room_inventory.length`.
 * Round 15 (2026-05-14, Codex finding A) added `configuredTotalRooms` —
 * `properties.total_rooms` — as a second authoritative signal. The schema
 * has both columns and nothing forces them to agree; INV-24 enforces the
 * invariant via the doctor check, but the agent must still produce a
 * safe answer during a transient drift.
 *
 * `total = max(inventoryLength, configuredTotalRooms, seededRowCount)`.
 * Whichever source claims the LARGEST hotel wins. The reasoning:
 *   • under-reporting (saying "we have 70" when really 74) is a silent
 *     lie that the user can't audit
 *   • over-reporting (saying "we have 74" when one source says 70) makes
 *     the missing rooms appear as "vacant" — visibly checkable, and the
 *     doctor check pages SMS on the disagreement so it gets fixed fast
 *
 * Missing rooms (in the chosen total but not in the seeded set) count
 * as vacant — the safe default, since absence of data means no guest.
 *
 * Exported for unit testing — the agent tools call this and mutate nothing.
 */
export interface OccupancySummary {
  total: number;
  occupied: number;
  vacant: number;
  occupancyPercent: number;
  seedingGap: number;
}

/** Three-signal total derivation. Shared between buildHotelSnapshot,
 *  get_today_summary, and computeOccupancySummary so the agent's "total
 *  rooms" answer is consistent across surfaces (INV-23 + INV-24). */
export interface RoomTotal {
  total: number;
  seedingGap: number;
}

export function computeRoomTotal(
  inventoryLength: number,
  configuredTotalRooms: number,
  seededRowCount: number,
): RoomTotal {
  const total = Math.max(
    Math.max(0, inventoryLength),
    Math.max(0, configuredTotalRooms),
    seededRowCount,
  );
  const seedingGap = Math.max(0, total - seededRowCount);
  return { total, seedingGap };
}

export function computeOccupancySummary(
  inventoryLength: number,
  configuredTotalRooms: number,
  seededRoomTypes: ReadonlyArray<'checkout' | 'stayover' | 'vacant' | null | undefined | string>,
): OccupancySummary {
  const seededRowCount = seededRoomTypes.length;
  const occupied = seededRoomTypes.filter(t => t === 'checkout' || t === 'stayover').length;
  const { total, seedingGap } = computeRoomTotal(inventoryLength, configuredTotalRooms, seededRowCount);
  const vacant = Math.max(0, total - occupied);
  const occupancyPercent = total > 0 ? Math.round((occupied / total) * 1000) / 10 : 0;
  return { total, occupied, vacant, occupancyPercent, seedingGap };
}

/**
 * Pick the property's "current" operational date in the pms_* schema.
 *
 * pms_housekeeping_assignments is composite-keyed on (property_id, date,
 * room_number) — one row per room per day. Any agent-facing query that wants
 * "today's room state" MUST filter by a single date or it would sum every
 * historical day together.
 *
 * We use "most recent date that has an assignment row" rather than UTC today
 * because (a) the CUA may not have written today's plan yet, and (b) UTC
 * today disagrees with the property's local date for ~5 hours every evening
 * in CST/CDT. Falls back to the property-local today (`todayStr`) so room
 * lookups still resolve against today's inventory before any assignment
 * exists — the legacy `null`-when-empty contract had no remaining callers
 * (findRoomByNumber is the only consumer, and it tolerates the fallback).
 */
export async function getCurrentRoomsDate(propertyId: string): Promise<string> {
  // Bound to ON OR BEFORE today: a pre-loaded FUTURE assignment (tomorrow's
  // plan) must never become the default mutation date, or agent/voice commands
  // (mark clean, reset, DND, flag, assign) would silently write tomorrow's row.
  const today = todayStr();
  const { data } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .select('date')
    .eq('property_id', propertyId)
    .lte('date', today)
    .order('date', { ascending: false })
    .limit(1);
  const d = data?.[0]?.date;
  return typeof d === 'string' ? d : today;
}

/**
 * Find the canonical room for a given (property, room number) on the current
 * operational date, sourced from the pms_* merge layer (single source of
 * truth). Returns a RoomRow whose `id` is the composite "${date}:${number}"
 * the write tools re-key on via parseRoomId.
 *
 * Returns null when no room matches — the tool surfaces "I don't see room X
 * in this property" to the user.
 */
export async function findRoomByNumber(
  propertyId: string,
  roomNumber: string | number,
): Promise<RoomRow | null> {
  // Claude usually emits roomNumber as a string per our JSON Schema, but
  // occasionally returns a JSON number (e.g., `302` instead of `"302"`).
  // Coerce defensively so a string-only method like .trim() doesn't blow up.
  const normalized = String(roomNumber ?? '').trim();
  if (!normalized) return null;
  const date = await getCurrentRoomsDate(propertyId);
  let rooms;
  try {
    rooms = await mergePmsRoomsForDate(propertyId, date);
  } catch {
    return null;
  }
  const room = rooms.find((r) => String(r.number) === normalized);
  if (!room) return null;
  return {
    id: room.id,
    property_id: room.propertyId,
    number: room.number,
    status: room.status,
    date: room.date ?? null,
    assigned_to: room.assignedTo ?? null,
    is_dnd: room.isDnd ?? false,
    dnd_note: room.dndNote ?? null,
    issue_note: room.issueNote ?? null,
    help_requested: room.helpRequested ?? false,
    started_at: room.startedAt ? new Date(room.startedAt).toISOString() : null,
    completed_at: room.completedAt ? new Date(room.completedAt).toISOString() : null,
    type: room.type,
  };
}

/**
 * Gate room mutations by housekeeper-style scoping. Returns null when the
 * caller is allowed to mutate the room, an error message string when not.
 *
 * Floor roles (housekeeping / maintenance) MUST have a resolved staffId
 * AND the room must either be unassigned or assigned to that staffId.
 * Manager-tier roles (admin / owner / general_manager / front_desk) get a
 * free pass — operational override.
 *
 * Codex review fix C2 (2026-05-13): every housekeeping-allowed mutation
 * tool MUST call this. Previously only mark_room_clean checked scope, so a
 * housekeeper could reset/DND/flag any room in the property.
 */
export function assertFloorRoleCanMutateRoom(
  room: RoomRow,
  ctx: ToolContext,
): string | null {
  if (ctx.user.role !== 'housekeeping' && ctx.user.role !== 'maintenance') {
    return null; // manager-tier — allowed
  }
  if (!ctx.staffId) {
    return 'Your account isn\'t linked to a staff record on this property. Ask the manager to link it before using the chat.';
  }
  if (room.assigned_to && room.assigned_to !== ctx.staffId) {
    return `Room ${room.number} is assigned to a different housekeeper.`;
  }
  return null;
}

export interface StaffRow {
  id: string;
  property_id: string;
  name: string;
  phone: string | null;
  department: string | null;
  is_active: boolean;
}

/** Shape-validation gate for a raw staff row from Supabase. Audit finding H2. */
function parseStaffRow(raw: unknown): StaffRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = parseStringField(r.id);
  const property_id = parseStringField(r.property_id);
  const name = parseStringField(r.name);
  if (!id || !property_id || !name) return null;
  return {
    id,
    property_id,
    name,
    phone: parseStringField(r.phone) ?? null,
    department: parseStringField(r.department) ?? null,
    is_active: parseBoolField(r.is_active) ?? false,
  };
}

/**
 * Resolve a staff member by name OR staff-id, with AMBIGUITY as a first-class
 * outcome. This is THE canonical staff-name matcher for the agent layer — the
 * comms tools (send_message, create_todo) and the room tools (assign_room via
 * findStaffByName) all funnel through it so name-matching behaves identically
 * everywhere.
 *
 * Resolution rules:
 *   - a UUID query does a direct id lookup (the model can pass an id it saw in a
 *     prior tool result); an inactive/absent id resolves to 'none'.
 *   - otherwise: prefer EXACT case-insensitive name matches; fall back to
 *     partial (substring) matches. 0 → 'none', 1 → 'ok', >1 → 'ambiguous' with
 *     the candidate list (so the caller can ask the user which one).
 */
export type StaffResolution =
  | { kind: 'ok'; staff: StaffRow }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: StaffRow[] };

const STAFF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveStaffByName(
  propertyId: string,
  query: string,
): Promise<StaffResolution> {
  const raw = String(query ?? '').trim();
  if (!raw) return { kind: 'none' };

  // Direct staff-id lookup.
  // NOTE: the staff table has NO `role` column — selecting one makes PostgREST
  // 400 and the swallowed error read as "no such person" (live bug caught by
  // e2e 2026-07-06; the phantom column dated back to findStaffByName on main).
  // Keep these select lists to real columns only.
  if (STAFF_UUID_RE.test(raw)) {
    const { data } = await supabaseAdmin
      .from('staff')
      .select('id, property_id, name, phone, department, is_active')
      .eq('property_id', propertyId)
      .eq('id', raw)
      .maybeSingle();
    const parsed = data ? parseStaffRow(data) : null;
    if (parsed && parsed.is_active) return { kind: 'ok', staff: parsed };
    return { kind: 'none' };
  }

  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, property_id, name, phone, department, is_active')
    .eq('property_id', propertyId)
    .eq('is_active', true);
  if (error || !data) {
    // A query/schema error here would otherwise read as "person not found" —
    // which is exactly how the phantom-column bug hid. Log loudly, fail closed.
    if (error) console.error('[agent/_helpers] resolveStaffByName query failed', { propertyId, err: error.message });
    return { kind: 'none' };
  }

  const rows = data.map(parseStaffRow).filter((r): r is StaffRow => !!r);
  const q = raw.toLowerCase();
  const exact = rows.filter(r => r.name.toLowerCase() === q);
  const matches = exact.length > 0 ? exact : rows.filter(r => r.name.toLowerCase().includes(q));

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.slice(0, 8) };
  return { kind: 'ok', staff: matches[0] };
}

/**
 * Find a staff member by name (case-insensitive). Used by tools like
 * assign_room("302", "Maria"). Returns the single match, or the FIRST candidate
 * when several match (legacy "pick the first" behaviour — assign_room isn't
 * ambiguity-aware). Returns null when none match. Thin wrapper over the
 * canonical resolveStaffByName so all name-matching shares one implementation.
 */
export async function findStaffByName(
  propertyId: string,
  nameQuery: string,
): Promise<StaffRow | null> {
  const res = await resolveStaffByName(propertyId, nameQuery);
  if (res.kind === 'ok') return res.staff;
  if (res.kind === 'ambiguous') return res.candidates[0] ?? null;
  return null;
}

/** Returns true if the role is allowed to perform manager-only actions. */
export function isManagerOrAbove(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

/** Returns true if the role is allowed to see financial data. */
export function canSeeFinancials(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}
