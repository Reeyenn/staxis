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
import { supabase, logErr, subscribeTable, asRecordRows } from './_common';
import { toStaffRow, fromStaffRow } from '../db-mappers';

/** Default upper bound on staff rows returned by listing helpers. */
export const DEFAULT_STAFF_LIMIT = 500;
/** Hard ceiling — even with explicit opts, never return more than this. */
export const MAX_STAFF_LIMIT = 1000;

// Explicit column list, in lock-step with fromStaffRow() in db-mappers.ts.
// Replaces `.select('*')` per cost-hotpaths audit recommendation #5/#13
// — the previous wide select returned every staff column on every fetch,
// including server-internal admin fields and any new columns added later
// that the UI doesn't read. Update both this constant and fromStaffRow
// when adding a column the UI needs.
//
// PRIVACY — phone and hourly_wage are intentionally ABSENT. These helpers run on the
// anon Supabase client, and `staff` RLS is row-level only ("owner rw
// staff", migration 0001) — Postgres RLS cannot restrict a single column,
// so listing either field here would ship every colleague's contact/payroll
// data to any
// authenticated property user (front_desk, housekeeping, …) whose browser
// subscribes to the property roster. Phone numbers and wages are read ONLY
// through the management-gated service-role routes GET /api/staff/contacts
// and GET /api/staff/wages. NEVER add phone or hourly_wage back here.
export const STAFF_COLS =
  'id, name, language, is_senior, department, ' +
  'scheduled_today, weekly_hours, max_weekly_hours, max_days_per_week, ' +
  'days_worked_this_week, vacation_dates, is_active, schedule_priority, ' +
  'last_paired_at';

// Defense for the WRITE side of the same leak. The mapper faithfully maps
// phone/hourlyWage to database columns, but the anon client must never carry
// either write — RLS is row-level only, so any authenticated property user
// could otherwise overwrite a colleague's contact/payroll data. Both fields
// are persisted through management-gated service-role routes instead.
function stripPrivateWrites(row: Record<string, unknown>): Record<string, unknown> {
  delete row.phone;
  delete row.hourly_wage;
  return row;
}

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

export async function getStaff(
  _uid: string, pid: string, opts?: StaffListOpts,
): Promise<StaffMember[]> {
  const { from, to } = clampedRange(opts);
  const { data, error } = await supabase
    .from('staff').select(STAFF_COLS)
    .eq('property_id', pid)
    .order('name', { ascending: true })
    .range(from, to);
  if (error) { logErr('getStaff', error); throw error; }
  return asRecordRows(data).map(fromStaffRow);
}

export function subscribeToStaff(
  _uid: string, pid: string,
  callback: (staff: StaffMember[]) => void,
  opts?: StaffListOpts,
  onFetchError?: (error: unknown) => void,
): () => void {
  const { from, to } = clampedRange(opts);
  return subscribeTable<StaffMember>(
    `staff:${pid}`, 'staff', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('staff').select(STAFF_COLS)
        .eq('property_id', pid)
        .order('name', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return asRecordRows(data).map(fromStaffRow);
    },
    callback,
    undefined,
    undefined,
    onFetchError,
  );
}

export async function addStaffMember(_uid: string, pid: string, data: Omit<StaffMember, 'id'>): Promise<string> {
  try {
    const row = { ...stripPrivateWrites(toStaffRow(data)), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('staff').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addStaffMember', err); throw err; }
}

export async function updateStaffMember(_uid: string, _pid: string, sid: string, data: Partial<StaffMember>): Promise<void> {
  try {
    const { error } = await supabase.from('staff').update(stripPrivateWrites(toStaffRow(data))).eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('updateStaffMember', err); throw err; }
}

export async function deleteStaffMember(_uid: string, _pid: string, sid: string): Promise<void> {
  try {
    const { error } = await supabase.from('staff').delete().eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('deleteStaffMember', err); throw err; }
}
