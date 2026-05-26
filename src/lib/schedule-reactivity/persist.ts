/**
 * Supabase-backed readers + writers wiring the pure modules to the DB.
 *
 * Kept in a separate file from the pure logic so unit tests in
 * src/lib/schedule-reactivity/__tests__ can import compute-gap +
 * suggest-action without Supabase env vars at all.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { ComputeGapReader } from './compute-gap';
import type { AlertDepartment, PropertyConfig } from './types';
import type { ScheduleAlertWriter, AlertWritePayload } from './create-alert';

interface RawScheduledShiftRow {
  start_time: string;
  end_time: string;
  status: string;
}

interface RawPropertyConfigRow {
  front_desk_coverage_hours: number | null;
  maintenance_shifts_per_day: number | null;
  houseman_shifts_per_day: number | null;
  breakfast_window_start: string | null;
  breakfast_window_end: string | null;
  shift_minutes: number | null;
  gap_alert_threshold_minutes: number | null;
  gap_alert_red_pct: number | null;
  release_shift_strategy: string | null;
}

function parseHmsToMinutes(t: string | null | undefined): number {
  if (!t) return 0;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return 0;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return 0;
  return h * 60 + mi;
}

/** Compute scheduled minutes for one shift row. Treats overnight (end<start)
 *  as a same-day wraparound; this matches the manager UI's
 *  hoursBetween() helper in ManagerSchedule.tsx. */
function shiftMinutes(row: RawScheduledShiftRow): number {
  const s = parseHmsToMinutes(row.start_time);
  const e = parseHmsToMinutes(row.end_time);
  let mins = e - s;
  if (mins < 0) mins += 24 * 60;
  return Math.max(0, mins);
}

export function makeSupabaseReader(): ComputeGapReader {
  return {
    async housekeepingRoomMinutes(propertyId, date) {
      // today_room_work_v1 returns rows per assignable room. Demand
      // = sum of estimated room-minutes. Approximation: use the
      // property's checkout_minutes/stayover_minutes defaults to weight
      // C/O vs Stay. If properties.* defaults aren't loaded we fall back
      // to a flat 25 min/room.
      const { data: workRows, error } = await supabaseAdmin
        .rpc('today_room_work_v1', {
          p_property_id: propertyId,
          p_date: date,
        });
      if (error) {
        log.warn('[schedule-reactivity] today_room_work_v1 failed', {
          propertyId, date, err: error.message,
        });
        return null;
      }
      if (!Array.isArray(workRows) || workRows.length === 0) return null;

      // Pull minute defaults from properties for a better-than-flat estimate.
      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('checkout_minutes, stayover_minutes')
        .eq('id', propertyId)
        .maybeSingle();
      const checkoutMin = (prop?.checkout_minutes as number | null) ?? 30;
      const stayoverMin = (prop?.stayover_minutes as number | null) ?? 20;

      let total = 0;
      for (const r of workRows as Array<{ stay_type?: string | null }>) {
        if (r.stay_type === 'C/O') total += checkoutMin;
        else if (r.stay_type === 'Stay') total += stayoverMin;
      }
      return total;
    },

    async housekeepingMlMinutes(propertyId, date) {
      // supply_predictions writes predicted minutes per (property, date).
      // Schema varies across the ML iteration history — read defensively:
      // accept any column named `predicted_minutes` or
      // `predicted_total_minutes`. Returns null when no fresh row exists.
      try {
        const { data, error } = await supabaseAdmin
          .from('supply_predictions')
          .select('*')
          .eq('property_id', propertyId)
          .eq('prediction_date', date)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error || !data) return null;
        const row = data as Record<string, unknown>;
        const candidates = ['predicted_minutes', 'predicted_total_minutes', 'minutes'];
        for (const k of candidates) {
          const v = row[k];
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
        }
        return null;
      } catch {
        return null;
      }
    },

    async scheduledMinutes(propertyId, date, dept) {
      const { data, error } = await supabaseAdmin
        .from('scheduled_shifts')
        .select('start_time, end_time, status')
        .eq('property_id', propertyId)
        .eq('shift_date', date)
        .eq('department', dept)
        .eq('kind', 'shift');
      if (error) {
        log.warn('[schedule-reactivity] scheduledMinutes query failed', {
          propertyId, date, dept, err: error.message,
        });
        return 0;
      }
      let total = 0;
      for (const row of (data ?? []) as RawScheduledShiftRow[]) {
        if (row.status === 'declined') continue;
        total += shiftMinutes(row);
      }
      return total;
    },

    async propertyConfig(propertyId) {
      const { data, error } = await supabaseAdmin
        .from('properties')
        .select(
          'front_desk_coverage_hours, maintenance_shifts_per_day, ' +
            'houseman_shifts_per_day, breakfast_window_start, ' +
            'breakfast_window_end, shift_minutes',
        )
        .eq('id', propertyId)
        .maybeSingle();
      if (error || !data) {
        return {
          frontDeskCoverageHours: null,
          maintenanceShiftsPerDay: null,
          housemanShiftsPerDay: null,
          breakfastWindowStart: null,
          breakfastWindowEnd: null,
          shiftMinutes: null,
        };
      }
      const r = data as unknown as RawPropertyConfigRow;
      return {
        frontDeskCoverageHours: r.front_desk_coverage_hours ?? null,
        maintenanceShiftsPerDay: r.maintenance_shifts_per_day ?? null,
        housemanShiftsPerDay: r.houseman_shifts_per_day ?? null,
        breakfastWindowStart: r.breakfast_window_start ?? null,
        breakfastWindowEnd: r.breakfast_window_end ?? null,
        shiftMinutes: r.shift_minutes ?? null,
      };
    },
  };
}

/** Load the full PropertyConfig (with alert thresholds + strategy) for the
 *  suggest-action layer. */
export async function loadPropertyConfig(propertyId: string): Promise<PropertyConfig> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select(
      'front_desk_coverage_hours, maintenance_shifts_per_day, ' +
        'houseman_shifts_per_day, breakfast_window_start, ' +
        'breakfast_window_end, shift_minutes, ' +
        'gap_alert_threshold_minutes, gap_alert_red_pct, release_shift_strategy',
    )
    .eq('id', propertyId)
    .maybeSingle();
  if (error || !data) {
    return {
      gapAlertThresholdMinutes: 60,
      gapAlertRedPct: 0.20,
      releaseShiftStrategy: 'latest_added',
      frontDeskCoverageHours: null,
      maintenanceShiftsPerDay: null,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    };
  }
  const r = data as unknown as RawPropertyConfigRow;
  return {
    gapAlertThresholdMinutes: r.gap_alert_threshold_minutes ?? 60,
    gapAlertRedPct: r.gap_alert_red_pct ?? 0.20,
    releaseShiftStrategy:
      r.release_shift_strategy === 'lowest_seniority' ? 'lowest_seniority' : 'latest_added',
    frontDeskCoverageHours: r.front_desk_coverage_hours ?? null,
    maintenanceShiftsPerDay: r.maintenance_shifts_per_day ?? null,
    housemanShiftsPerDay: r.houseman_shifts_per_day ?? null,
    breakfastWindowStart: r.breakfast_window_start ?? null,
    breakfastWindowEnd: r.breakfast_window_end ?? null,
    shiftMinutes: r.shift_minutes ?? null,
  };
}

export function makeSupabaseWriter(): ScheduleAlertWriter {
  return {
    async upsertOpenAlert(p: AlertWritePayload) {
      // Look for an existing open row matching the unique index. If found,
      // UPDATE it in place; otherwise INSERT a fresh row. Done in two calls
      // (no race-safe upsert because the unique index is partial, and
      // PostgREST's on_conflict needs a full unique constraint).
      const { data: existing, error: selErr } = await supabaseAdmin
        .from('schedule_alerts')
        .select('id')
        .eq('property_id', p.propertyId)
        .eq('alert_date', p.alertDate)
        .eq('department', p.department)
        .eq('suggested_action', p.suggestedAction)
        .is('dismissed_at', null)
        .is('applied_at', null)
        .maybeSingle();
      if (selErr) {
        log.warn('[schedule-reactivity] upsertOpenAlert select failed', {
          propertyId: p.propertyId, alertDate: p.alertDate,
          dept: p.department, err: selErr.message,
        });
      }
      if (existing?.id) {
        const { error: updErr } = await supabaseAdmin
          .from('schedule_alerts')
          .update({
            severity: p.severity,
            gap_minutes: p.gapMinutes,
            demand_minutes: p.demandMinutes,
            scheduled_minutes: p.scheduledMinutes,
            suggested_savings_cents: p.suggestedSavingsCents,
            trigger_kind: p.triggerKind,
            context: p.context,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        if (updErr) {
          log.warn('[schedule-reactivity] upsertOpenAlert update failed', {
            id: existing.id, err: updErr.message,
          });
        }
        return { id: String(existing.id), created: false };
      }
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('schedule_alerts')
        .insert({
          property_id: p.propertyId,
          alert_date: p.alertDate,
          department: p.department,
          severity: p.severity,
          suggested_action: p.suggestedAction,
          gap_minutes: p.gapMinutes,
          demand_minutes: p.demandMinutes,
          scheduled_minutes: p.scheduledMinutes,
          suggested_savings_cents: p.suggestedSavingsCents,
          trigger_kind: p.triggerKind,
          context: p.context,
        })
        .select('id')
        .single();
      if (insErr || !inserted) {
        // 23505 = unique violation. The partial unique index could fire
        // here if two recompute paths raced past our select. Treat that
        // as "another writer beat us — leave their row alone."
        if ((insErr as { code?: string } | undefined)?.code === '23505') {
          return { id: '', created: false };
        }
        log.error('[schedule-reactivity] upsertOpenAlert insert failed', {
          propertyId: p.propertyId, alertDate: p.alertDate,
          dept: p.department, err: insErr?.message ?? 'unknown',
        });
        throw insErr ?? new Error('insert failed');
      }
      return { id: String(inserted.id), created: true };
    },
  };
}

/**
 * Average wage cents/hour across the housekeeping staff at a property.
 * Used by the release_shift estimator. Reads `hourly_wage_cents` (post-
 * 0229) with a fallback to `hourly_wage` (legacy dollar column, present
 * since 0001).
 */
export async function avgPropertyWageCentsPerHour(
  propertyId: string,
  dept: AlertDepartment,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('hourly_wage_cents, hourly_wage')
    .eq('property_id', propertyId)
    .eq('department', dept);
  if (error || !data || data.length === 0) return null;
  let total = 0;
  let count = 0;
  for (const r of data as Array<{ hourly_wage_cents: number | null; hourly_wage: number | null }>) {
    if (typeof r.hourly_wage_cents === 'number' && r.hourly_wage_cents > 0) {
      total += r.hourly_wage_cents;
      count++;
    } else if (typeof r.hourly_wage === 'number' && r.hourly_wage > 0) {
      total += Math.round(r.hourly_wage * 100);
      count++;
    }
  }
  if (count === 0) return null;
  return Math.round(total / count);
}
