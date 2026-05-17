// ═══════════════════════════════════════════════════════════════════════════
// Staff — housekeeping crew + front desk. One row per staff member, scoped
// by property_id.
//
// All listing functions accept an optional `opts` for pagination. The
// default page size is generous (DEFAULT_STAFF_LIMIT) — covers any
// realistic single-property staff count without surprising existing
// callers — but it's bounded so a runaway data-quality issue can't return
// a 50,000-row payload to a React state update.
// ═══════════════════════════════════════════════════════════════════════════

import type { StaffMember } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toStaffRow, fromStaffRow } from '../db-mappers';

/** Default upper bound on staff rows returned by listing helpers. */
export const DEFAULT_STAFF_LIMIT = 500;
/** Hard ceiling — even with explicit opts, never return more than this. */
export const MAX_STAFF_LIMIT = 1000;

// Explicit field list — matches what fromStaffRow consumes
// (src/lib/db-mappers.ts). Audit P1.1 (2026-05-17): previously SELECT *
// pulled wide rows including phone, phone_lookup, hourly_wage on every
// realtime tick; this list keeps payloads small and bandwidth predictable.
// Keep in sync with fromStaffRow whenever a new field lands.
const STAFF_FIELDS =
  'id, name, phone, language, is_senior, department, hourly_wage, ' +
  'scheduled_today, weekly_hours, max_weekly_hours, max_days_per_week, ' +
  'days_worked_this_week, vacation_dates, is_active, schedule_priority, ' +
  'is_scheduling_manager, last_paired_at';

export interface StaffListOpts {
  /** 1-based page size cap. Clamped to [1, MAX_STAFF_LIMIT]. */
  limit?: number;
  /** Number of rows to skip (0-indexed). Default 0. */
  offset?: number;
}

function clampedRange(opts?: StaffListOpts): { from: number; to: number } {
  const rawLimit = opts?.limit ?? DEFAULT_STAFF_LIMIT;
  const limit = Math.max(1, Math.min(MAX_STAFF_LIMIT, rawLimit));
  const offset = Math.max(0, opts?.offset ?? 0);
  return { from: offset, to: offset + limit - 1 };
}

type StaffRow = Record<string, unknown>;

export async function getStaff(
  _uid: string, pid: string, opts?: StaffListOpts,
): Promise<StaffMember[]> {
  const { from, to } = clampedRange(opts);
  const { data, error } = await supabase
    .from('staff').select(STAFF_FIELDS)
    .eq('property_id', pid)
    .order('name', { ascending: true })
    .range(from, to)
    .returns<StaffRow[]>();
  if (error) { logErr('getStaff', error); throw error; }
  return (data ?? []).map(fromStaffRow);
}

/**
 * Fetch the next page of staff plus the exact total count. Use this when
 * the UI needs "Showing X of Y" — `count: 'exact'` is more expensive than
 * a plain select, so plain `getStaff` skips it.
 */
export async function getStaffPage(
  _uid: string, pid: string, opts?: StaffListOpts,
): Promise<{ rows: StaffMember[]; total: number }> {
  const { from, to } = clampedRange(opts);
  const { data, error, count } = await supabase
    .from('staff').select(STAFF_FIELDS, { count: 'exact' })
    .eq('property_id', pid)
    .order('name', { ascending: true })
    .range(from, to)
    .returns<StaffRow[]>();
  if (error) { logErr('getStaffPage', error); throw error; }
  return { rows: (data ?? []).map(fromStaffRow), total: count ?? 0 };
}

export function subscribeToStaff(
  _uid: string, pid: string,
  callback: (staff: StaffMember[]) => void,
  opts?: StaffListOpts,
): () => void {
  const { from, to } = clampedRange(opts);
  return subscribeTable<StaffMember>(
    `staff:${pid}`, 'staff', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('staff').select(STAFF_FIELDS)
        .eq('property_id', pid)
        .order('name', { ascending: true })
        .range(from, to)
        .returns<StaffRow[]>();
      if (error) throw error;
      return (data ?? []).map(fromStaffRow);
    },
    callback,
  );
}

export async function addStaffMember(_uid: string, pid: string, data: Omit<StaffMember, 'id'>): Promise<string> {
  try {
    const row = { ...toStaffRow(data), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('staff').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addStaffMember', err); throw err; }
}

export async function updateStaffMember(_uid: string, _pid: string, sid: string, data: Partial<StaffMember>): Promise<void> {
  try {
    const { error } = await supabase.from('staff').update(toStaffRow(data)).eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('updateStaffMember', err); throw err; }
}

export async function deleteStaffMember(_uid: string, _pid: string, sid: string): Promise<void> {
  try {
    const { error } = await supabase.from('staff').delete().eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('deleteStaffMember', err); throw err; }
}
