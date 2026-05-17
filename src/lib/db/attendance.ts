// ═══════════════════════════════════════════════════════════════════════════
// Attendance Marks — per-housekeeper ground-truth log of who actually showed
// up and worked on a given day (Migration 0021).
//
// Maria taps a checkbox at end-of-shift for each HK. This drives the
// headcount_actuals_view, the ground-truth for Layer 1 training.
// ═══════════════════════════════════════════════════════════════════════════

// Browser-callable: this module is imported by Schedule tab UI components
// via the @/lib/db shim. MUST use the regular `supabase` client, NOT
// supabaseAdmin (server-only). The user's JWT + RLS owner_rw policy on
// attendance_marks is what enforces auth.
import { supabase, logErr } from './_common';

export interface AttendanceMark {
  propertyId: string;
  date: string;
  staffId: string;
  attended: boolean;
  markedAt: Date;
  markedBy: string | null;
  notes: string | null;
}

function fromAttendanceMarkRow(r: Record<string, unknown>): AttendanceMark {
  return {
    propertyId: String(r.property_id),
    date: String(r.date),
    staffId: String(r.staff_id),
    attended: Boolean(r.attended),
    markedAt: new Date(String(r.marked_at)),
    markedBy: r.marked_by ? String(r.marked_by) : null,
    notes: r.notes ? String(r.notes) : null,
  };
}

/**
 * Mark or update attendance for a housekeeper on a given date.
 * Upserts on (property_id, date, staff_id) — idempotent.
 *
 * Used by the Schedule tab's end-of-day UI where Maria confirms
 * who actually showed up and worked.
 */
export async function markAttendance(input: {
  propertyId: string;
  date: string;
  staffId: string;
  attended: boolean;
  notes?: string | null;
  markedBy?: string | null;
}): Promise<AttendanceMark | null> {
  try {
    const { data, error } = await supabase
      .from('attendance_marks')
      .upsert(
        {
          property_id: input.propertyId,
          date: input.date,
          staff_id: input.staffId,
          attended: input.attended,
          notes: input.notes ?? null,
          marked_by: input.markedBy ?? null,
          marked_at: new Date().toISOString(),
        },
        {
          onConflict: 'property_id,date,staff_id',
        }
      )
      .select()
      .maybeSingle();

    if (error) {
      logErr('markAttendance', error);
      return null;
    }
    return data ? fromAttendanceMarkRow(data) : null;
  } catch (err) {
    logErr('markAttendance', err);
    return null;
  }
}

/**
 * Fetch all attendance marks for a given (property, date).
 * Returns a Map keyed by staff_id for efficient lookups.
 *
 * Used by the Schedule tab UI to display the attendance checklist.
 */
export async function getAttendanceForDate(
  propertyId: string,
  date: string,
): Promise<Map<string, AttendanceMark>> {
  try {
    const { data, error } = await supabase
      .from('attendance_marks')
      .select('*')
      .eq('property_id', propertyId)
      .eq('date', date);

    if (error) {
      logErr('getAttendanceForDate', error);
      return new Map();
    }

    const map = new Map<string, AttendanceMark>();
    for (const row of data ?? []) {
      const mark = fromAttendanceMarkRow(row);
      map.set(mark.staffId, mark);
    }
    return map;
  } catch (err) {
    logErr('getAttendanceForDate', err);
    return new Map();
  }
}
