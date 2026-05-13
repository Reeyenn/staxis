// Shared helpers for tool handlers. Each tool wants to look up a room by
// number, find a staff member by name, etc. — centralized so the lookups
// are consistent across the catalog.

import { supabaseAdmin } from '@/lib/supabase-admin';
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
 * Find the canonical room row for a given (property, room number). If multiple
 * date-bucketed rows exist (e.g. rooms.date='2026-05-12' and '2026-05-13'),
 * prefer today's. If today's isn't there, fall back to the most recent.
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
  // Codex review fix #6, 2026-05-13.
  const normalized = String(roomNumber ?? '').trim();
  if (!normalized) return null;
  const { data, error } = await supabaseAdmin
    .from('rooms')
    .select('id, property_id, number, status, date, assigned_to, is_dnd, dnd_note, issue_note, help_requested, started_at, completed_at, type')
    .eq('property_id', propertyId)
    .eq('number', normalized)
    .order('date', { ascending: false, nullsFirst: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0] as unknown as RoomRow;
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
  role: string | null;
  phone: string | null;
  is_active: boolean;
}

/**
 * Find a staff member by name (case-insensitive partial match). Used by
 * tools like assign_room("302", "Maria") — pick the staff record. If
 * multiple match, return the first active one. If none, return null.
 */
export async function findStaffByName(
  propertyId: string,
  nameQuery: string,
): Promise<StaffRow | null> {
  const normalized = nameQuery.trim().toLowerCase();
  if (!normalized) return null;
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, property_id, name, role, phone, is_active')
    .eq('property_id', propertyId)
    .eq('is_active', true);
  if (error || !data) return null;
  // Prefer exact case-insensitive match; otherwise first partial.
  const exact = data.find(s => (s.name as string)?.toLowerCase() === normalized);
  if (exact) return exact as unknown as StaffRow;
  const partial = data.find(s => (s.name as string)?.toLowerCase().includes(normalized));
  return (partial as unknown as StaffRow) ?? null;
}

/** Returns true if the role is allowed to perform manager-only actions. */
export function isManagerOrAbove(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

/** Returns true if the role is allowed to see financial data. */
export function canSeeFinancials(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}
