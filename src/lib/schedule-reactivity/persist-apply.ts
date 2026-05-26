/**
 * Supabase-backed writer for the apply-alert flow. Kept separate from the
 * pure module so __tests__ doesn't need Supabase env vars.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AlertDepartment } from './types';
import type { ApplyAlertWriter } from './apply-alert';

const PUBLISHED_STATUSES = new Set(['published', 'sent', 'confirmed']);

export function makeSupabaseApplyWriter(): ApplyAlertWriter {
  return {
    async loadAlert(alertId) {
      const { data, error } = await supabaseAdmin
        .from('schedule_alerts')
        .select(
          'id, property_id, alert_date, department, suggested_action, ' +
            'dismissed_at, applied_at',
        )
        .eq('id', alertId)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as unknown as Record<string, unknown>;
      return {
        id: String(row.id),
        propertyId: String(row.property_id),
        alertDate: String(row.alert_date),
        department: row.department as AlertDepartment,
        suggestedAction: row.suggested_action as 'add_shift' | 'release_shift',
        dismissedAt: (row.dismissed_at as string | null) ?? null,
        appliedAt: (row.applied_at as string | null) ?? null,
      };
    },

    // Atomic pre-claim guard. The manager can double-click the "Apply"
    // button faster than loadAlert→action→markApplied takes to round-trip.
    // Without this, two concurrent applies both pass the appliedAt=null
    // check and both insert the open shift (or both try to delete the same
    // shift). Pre-claim returns 1 ONLY for the request that "won" the race;
    // the loser short-circuits to outcome='already_applied' without
    // touching scheduled_shifts.
    //
    // Side effect: if the action fails after a successful pre-claim, the
    // alert ends up applied with no on-the-ground effect. The next
    // recompute pass creates a fresh alert (unique partial index keys on
    // applied_at IS NULL), so the manager sees the gap again within ~30s.
    async preclaimApply(alertId, accountId) {
      const { data, error } = await supabaseAdmin
        .from('schedule_alerts')
        .update({
          applied_at: new Date().toISOString(),
          applied_by_account_id: accountId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', alertId)
        .is('applied_at', null)
        .is('dismissed_at', null)
        .select('id');
      if (error) {
        log.warn('[apply-alert] preclaimApply failed', {
          alertId, err: error.message,
        });
        return { claimed: false };
      }
      return { claimed: (data ?? []).length > 0 };
    },

    async setAppliedPayload(alertId, outcome, affectedShiftId) {
      const { error } = await supabaseAdmin
        .from('schedule_alerts')
        .update({
          applied_payload: { outcome, affectedShiftId },
          updated_at: new Date().toISOString(),
        })
        .eq('id', alertId);
      if (error) {
        log.warn('[apply-alert] setAppliedPayload failed', {
          alertId, err: error.message,
        });
      }
    },

    async lookupFirstPreset(propertyId, dept) {
      const { data, error } = await supabaseAdmin
        .from('property_shift_presets')
        .select('start_time, end_time')
        .eq('property_id', propertyId)
        .eq('department', dept)
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return {
        startTime: String(data.start_time).slice(0, 5),
        endTime: String(data.end_time).slice(0, 5),
      };
    },

    async insertOpenShift(input) {
      const { data, error } = await supabaseAdmin
        .from('scheduled_shifts')
        .insert({
          property_id: input.propertyId,
          staff_id: null,
          department: input.department,
          shift_date: input.alertDate,
          start_time: input.startTime,
          end_time: input.endTime,
          kind: 'open',
          status: 'draft',
          reason: input.reason,
        })
        .select('id')
        .single();
      if (error || !data) {
        log.error('[apply-alert] insertOpenShift failed', {
          propertyId: input.propertyId,
          dept: input.department,
          err: error?.message ?? 'unknown',
        });
        throw error ?? new Error('insert failed');
      }
      return { id: String(data.id) };
    },

    async pickShiftToRelease(input) {
      // Load all candidates for this (property, date, dept) — kind='shift'
      // (skip 'open' since releasing an unfilled slot doesn't save labor)
      // and pick one according to strategy.
      const { data, error } = await supabaseAdmin
        .from('scheduled_shifts')
        .select('id, staff_id, status, created_at')
        .eq('property_id', input.propertyId)
        .eq('shift_date', input.alertDate)
        .eq('department', input.department)
        .eq('kind', 'shift')
        .order('created_at', { ascending: false }); // latest-added first
      if (error) {
        log.warn('[apply-alert] pickShiftToRelease query failed', {
          propertyId: input.propertyId, dept: input.department,
          err: error.message,
        });
        return null;
      }
      const candidates = (data ?? []) as Array<{
        id: string; staff_id: string | null;
        status: string; created_at: string;
      }>;
      if (candidates.length === 0) return null;

      // Find the first un-published candidate per strategy.
      const ordered = input.strategy === 'lowest_seniority'
        ? await seniorityOrder(input.propertyId, candidates)
        : candidates; // latest_added — already sorted desc by created_at

      for (const c of ordered) {
        if (PUBLISHED_STATUSES.has(c.status)) {
          // We're walking in strategy order; the first published candidate
          // means everyone further down the list is also unsuitable for
          // silent release. Surface the published case.
          return {
            id: String(c.id),
            staffId: (c.staff_id as string | null) ?? null,
            published: true,
            status: c.status,
          };
        }
        // Draft — safe to release.
        return {
          id: String(c.id),
          staffId: (c.staff_id as string | null) ?? null,
          published: false,
        };
      }
      return null;
    },

    async deleteShift(shiftId) {
      const { error } = await supabaseAdmin
        .from('scheduled_shifts')
        .delete()
        .eq('id', shiftId);
      if (error) {
        log.error('[apply-alert] deleteShift failed', {
          shiftId, err: error.message,
        });
        return { ok: false };
      }
      return { ok: true };
    },

    async markApplied(input) {
      const { error } = await supabaseAdmin
        .from('schedule_alerts')
        .update({
          applied_at: new Date().toISOString(),
          applied_by_account_id: input.accountId,
          applied_payload: {
            outcome: input.outcome,
            affectedShiftId: input.affectedShiftId,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.alertId)
        // Idempotency guard — don't stomp an existing applied/dismissed row
        // if a concurrent caller raced us.
        .is('applied_at', null)
        .is('dismissed_at', null);
      if (error) {
        log.warn('[apply-alert] markApplied update failed', {
          alertId: input.alertId, err: error.message,
        });
        return { ok: false };
      }
      return { ok: true };
    },
  };
}

/**
 * Sort candidates by seniority — lowest first. Seniority proxy:
 *   1) staff.weekly_hours (lower = less tenure / less of a heavy hitter)
 *   2) tie-break by staff.created_at (older = more senior, so we put
 *      newer first when releasing)
 *
 * Open shifts (staff_id NULL) sort last in either order — they shouldn't
 * be picked here anyway because the SELECT filtered kind='shift'.
 */
async function seniorityOrder(
  propertyId: string,
  rows: Array<{ id: string; staff_id: string | null; status: string; created_at: string }>,
): Promise<typeof rows> {
  const staffIds = rows
    .map((r) => r.staff_id)
    .filter((s): s is string => Boolean(s));
  if (staffIds.length === 0) return rows;
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, weekly_hours, created_at')
    .eq('property_id', propertyId)
    .in('id', staffIds);
  const byId = new Map<string, { weeklyHours: number; createdAt: string }>();
  for (const s of (data ?? []) as Array<{
    id: string; weekly_hours: number | null; created_at: string;
  }>) {
    byId.set(String(s.id), {
      weeklyHours: Number(s.weekly_hours ?? 0),
      createdAt: String(s.created_at ?? ''),
    });
  }
  return [...rows].sort((a, b) => {
    if (!a.staff_id) return 1;
    if (!b.staff_id) return -1;
    const sa = byId.get(a.staff_id);
    const sb = byId.get(b.staff_id);
    const ha = sa?.weeklyHours ?? Infinity;
    const hb = sb?.weeklyHours ?? Infinity;
    if (ha !== hb) return ha - hb;
    // Tie-break: newer staff first (release them before veterans).
    return (sb?.createdAt ?? '').localeCompare(sa?.createdAt ?? '');
  });
}
