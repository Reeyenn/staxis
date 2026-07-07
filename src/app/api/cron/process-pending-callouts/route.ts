/**
 * GET /api/cron/process-pending-callouts
 *
 * Vercel cron tick (every 5 minutes). Two responsibilities:
 *
 *   1. Fire redistribute for any callout whose redistribute_at has passed
 *      and that hasn't been redistributed yet. Covers the 'in_15_min'
 *      leave-timing case and acts as a safety net for callouts where the
 *      inline redistribute (in the report routes) failed transiently.
 *
 *   2. For 'after_current_room' callouts (redistribute_at sentinel set
 *      24h in the future), check whether the sick HK still has any
 *      in-progress tasks. If not, fire the redistribute now.
 *
 * Auth: CRON_SECRET bearer, same as every other cron in this codebase.
 *
 * Each callout is processed in its own try/catch — one bad row doesn't
 * stop the rest. Notifications fire after each successful redistribute.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';
import {
  runRedistributionForCallout,
  sendCalloutNotifications,
} from '@/lib/sick-callout';
import type { CalloutEvent, CalloutLeaveTiming } from '@/lib/sick-callout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TICK_LIMIT = 50;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const startedAt = Date.now();

  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    const nowIso = new Date().toISOString();

    // Pull callouts that need processing. The partial index on
    // (redistribute_at) WHERE status='active' AND redistributed_at IS NULL
    // makes this cheap.
    const pendingLookup = await supabaseAdmin
      .from('callout_events')
      .select('id, property_id, staff_id, business_date, leave_timing, redistribute_at')
      .eq('status', 'active')
      .is('redistributed_at', null)
      .order('redistribute_at', { ascending: true })
      .limit(TICK_LIMIT);

    if (pendingLookup.error) {
      log.error('[cron/process-pending-callouts] read failed', {
        requestId, err: errToString(pendingLookup.error),
      });
      return err('callout read failed', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }

    const pending = (pendingLookup.data ?? []) as Array<{
      id: string;
      property_id: string;
      staff_id: string;
      business_date: string;
      leave_timing: CalloutLeaveTiming | null;
      redistribute_at: string | null;
    }>;

    // Section gate (WP6): callout redistribution straddles Housekeeping + Staff,
    // so it only pauses when BOTH are off. One batched read (not a per-callout
    // round-trip) maps each property to its enabled_sections. Fail-open — a read
    // error or missing/null value leaves the property's callouts processing.
    const bothSectionsOff = new Set<string>();
    const calloutPropertyIds = Array.from(new Set(pending.map((r) => r.property_id)));
    if (calloutPropertyIds.length) {
      const { data: propRows, error: propErr } = await supabaseAdmin
        .from('properties')
        .select('id, enabled_sections')
        .in('id', calloutPropertyIds);
      if (propErr) {
        log.warn('[cron/process-pending-callouts] enabled_sections read failed — processing all', {
          requestId, err: errToString(propErr),
        });
      } else {
        for (const r of propRows ?? []) {
          const flags = (r as { enabled_sections?: EnabledSections }).enabled_sections ?? null;
          if (
            !isSectionEnabled(flags, 'housekeeping') &&
            !isSectionEnabled(flags, 'staff')
          ) {
            bothSectionsOff.add(String((r as { id: string }).id));
          }
        }
      }
    }

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let waitingOnTask = 0;

    for (const row of pending) {
      if (bothSectionsOff.has(row.property_id)) {
        skipped += 1;
        continue;
      }
      try {
        // 'after_current_room' — gated on "no in-progress task for this
        // sick HK." If they still have one running, leave the callout
        // pending and skip it; next tick will check again.
        if (row.leave_timing === 'after_current_room') {
          const stillBusy = await sickStaffStillHasInProgressTask(
            row.property_id, row.staff_id, row.business_date,
          );
          if (stillBusy) {
            waitingOnTask += 1;
            continue;
          }
        } else {
          // For everything else (now / in_15_min), check the scheduled time.
          if (row.redistribute_at && row.redistribute_at > nowIso) {
            skipped += 1;
            continue;
          }
        }

        await runRedistributionForCallout(supabaseAdmin, row.id);
        processed += 1;

        // Fire notifications best-effort.
        try {
          const fresh = await supabaseAdmin
            .from('callout_events')
            .select('*')
            .eq('id', row.id)
            .maybeSingle();
          if (fresh.data) {
            await sendCalloutNotifications(supabaseAdmin, fresh.data as CalloutEvent);
          }
        } catch (notifyErr) {
          log.warn('[cron/process-pending-callouts] notification fanout failed', {
            requestId, calloutId: row.id, err: errToString(notifyErr),
          });
        }
      } catch (rowErr) {
        failed += 1;
        log.warn('[cron/process-pending-callouts] callout failed', {
          requestId, calloutId: row.id, err: errToString(rowErr),
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    log.info('[cron/process-pending-callouts] tick', {
      requestId, candidates: pending.length, processed, skipped, failed, waitingOnTask, durationMs,
    });

    try {
      await writeCronHeartbeat('process-pending-callouts', {
        requestId,
        notes: { candidates: pending.length, processed, skipped, failed, waitingOnTask },
      });
    } catch {
      // Heartbeat failures are non-fatal.
    }

    return ok(
      { candidates: pending.length, processed, skipped, failed, waitingOnTask, durationMs },
      { requestId },
    );
  } catch (caughtErr) {
    log.error('[cron/process-pending-callouts] unexpected', {
      requestId, err: errToString(caughtErr),
    });
    return err('internal error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function sickStaffStillHasInProgressTask(
  propertyId: string,
  staffId: string,
  businessDate: string,
): Promise<boolean> {
  // Statuses that count as "actively cleaning a room right now" — the
  // policy is "wait until they finish what they're doing before
  // redistributing." Pause counts because they're mid-clean and may resume.
  const ACTIVE_STATUSES = ['in_progress', 'paused'];
  const lookup = await supabaseAdmin
    .from('cleaning_tasks')
    .select('id')
    .eq('property_id', propertyId)
    .eq('assignee_id', staffId)
    .eq('business_date', businessDate)
    .in('status', ACTIVE_STATUSES)
    .limit(1)
    .maybeSingle();
  if (lookup.error) {
    // If the cleaning_tasks table doesn't exist yet, there's nothing to
    // wait on — fire immediately.
    const missing = /relation .*cleaning_tasks.* does not exist/i.test(
      lookup.error.message ?? '',
    );
    if (missing) return false;
    // Other DB errors → fail safe and wait. The next tick will retry.
    return true;
  }
  return !!lookup.data;
}
