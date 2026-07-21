// ═══════════════════════════════════════════════════════════════════════════
// Staff schedule (migration 0147). Powers the /staff manager-side week grid
// and the staff-side My Shifts view. Two-layer model:
//
//   property_shift_presets — named shift templates ("Morning HK: 8a–4p").
//     Manager defines these once in Settings; week-grid cells use them as
//     one-click picks.
//
//   scheduled_shifts — one row per assigned cell (kind='shift') or open
//     slot (kind='open', staff_id=null) for the week. Status flows:
//     draft → published → sent (SMS out) → confirmed / declined. Open
//     shifts go straight from draft to published when the manager
//     publishes the week; "auto-open from decline" inserts directly at
//     published so eligible staff see it immediately.
//
//   time_off_requests — staff submits, manager approves/denies in-app.
//     No SMS; product call 2026-05-17.
//
//   week_publications — bookkeeping for "is this week published?"
//     Latest row per (property, week_start) wins.
//
// All writes go through API routes that use supabaseAdmin (RLS blocks
// anon/authenticated writes by design). Reads are RLS-gated to the
// property's authenticated users.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  ShiftPreset, ScheduledShift, TimeOffRequest, WeekPublication,
} from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import {
  fromShiftPresetRow, fromScheduledShiftRow, fromTimeOffRequestRow,
  fromWeekPublicationRow,
} from '../db-mappers';

// ─── Shift presets ─────────────────────────────────────────────────────────

export function subscribeToShiftPresets(
  _uid: string, pid: string,
  callback: (presets: ShiftPreset[]) => void,
  onFetchError?: (error: unknown) => void,
): () => void {
  return subscribeTable<ShiftPreset>(
    `property_shift_presets:${pid}`,
    'property_shift_presets',
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('property_shift_presets')
        .select('*')
        .eq('property_id', pid)
        .order('department', { ascending: true })
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(fromShiftPresetRow);
    },
    callback,
    undefined,
    undefined,
    onFetchError,
  );
}

// ─── Scheduled shifts ──────────────────────────────────────────────────────

/**
 * Subscribe to all scheduled_shifts rows in the [weekStart, weekStart+6d]
 * window for `pid`. Used by both the manager week grid (sees all rows)
 * and the staff My Shifts view (filters client-side to their own staffId
 * + status='published'/'sent'/'confirmed').
 */
export function subscribeToScheduledShifts(
  _uid: string, pid: string, weekStart: string, weekEnd: string,
  callback: (shifts: ScheduledShift[]) => void,
  onFetchError?: (error: unknown) => void,
): () => void {
  return subscribeTable<ScheduledShift>(
    `scheduled_shifts:${pid}:${weekStart}`,
    'scheduled_shifts',
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('scheduled_shifts').select('*')
        .eq('property_id', pid)
        .gte('shift_date', weekStart)
        .lte('shift_date', weekEnd);
      if (error) throw error;
      return (data ?? []).map(fromScheduledShiftRow);
    },
    callback,
    // Realtime filter only covers property_id; scope by date window too.
    (payload) => {
      const newDate = (payload.new as { shift_date?: string } | null)?.shift_date;
      const oldDate = (payload.old as { shift_date?: string } | null)?.shift_date;
      const inWindow = (d: string | undefined) =>
        !!d && d >= weekStart && d <= weekEnd;
      return inWindow(newDate) || inWindow(oldDate);
    },
    undefined,
    onFetchError,
  );
}

// ─── Time-off requests ─────────────────────────────────────────────────────

export function subscribeToTimeOffRequests(
  _uid: string, pid: string,
  callback: (requests: TimeOffRequest[]) => void,
  // Optional viewer scope. `undefined` (manager callers) → whole property.
  // An explicit staff id → only that staffer's rows (keeps colleagues'
  // free-text reasons off the wire). Explicit `null` (staff view with no
  // linked staff record) → empty list. The realtime channel filter stays
  // property-wide; events for other staff just trigger a cheap refetch.
  staffId?: string | null,
  onFetchError?: (error: unknown) => void,
): () => void {
  return subscribeTable<TimeOffRequest>(
    `time_off_requests:${pid}`,
    'time_off_requests',
    `property_id=eq.${pid}`,
    async () => {
      if (staffId === null) return [];
      let query = supabase
        .from('time_off_requests').select('*')
        .eq('property_id', pid);
      if (staffId) query = query.eq('staff_id', staffId);
      const { data, error } = await query
        .order('submitted_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromTimeOffRequestRow);
    },
    callback,
    undefined,
    undefined,
    onFetchError,
  );
}

// ─── Week publications ─────────────────────────────────────────────────────

/**
 * Returns latest publication record per week_start for this property. The
 * staff My Shifts view uses it to decide whether to show a future week
 * (only if published) or hide it as "draft".
 */
export function subscribeToWeekPublications(
  _uid: string, pid: string,
  callback: (publications: WeekPublication[]) => void,
  onFetchError?: (error: unknown) => void,
): () => void {
  return subscribeTable<WeekPublication>(
    `week_publications:${pid}`,
    'week_publications',
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('week_publications').select('*')
        .eq('property_id', pid)
        .order('week_start', { ascending: false })
        .order('published_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromWeekPublicationRow);
    },
    callback,
    undefined,
    undefined,
    onFetchError,
  );
}
