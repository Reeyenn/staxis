/**
 * GET /api/cron/seal-daily
 *
 * Hourly cron that "seals" yesterday's data for each active property — the
 * step that turns operational reality into ML training labels. Two writes
 * per (property, date) cycle:
 *
 *   1. attendance_marks: for each scheduled crew member with no existing
 *      mark, infer attended=true if they completed ≥1 cleaning_event that
 *      day, else attended=false. This unblocks demand/supply training,
 *      which filters on `labels_complete = true` (every scheduled staff
 *      member has an attendance mark). Without this, the demand model
 *      reports "insufficient data" forever — the failure mode that hid
 *      itself behind a green cron for the first 30+ days of operation.
 *
 *   2. daily_logs: idempotent upsert of the day's aggregates (occupied,
 *      checkouts, stayovers, room minutes, rooms completed). Used by the
 *      inventory ML's occupancy feature, the analytics views, and end-of-
 *      day reports.
 *
 * Why hourly: the cron iterates every active property and seals each one
 * for which "yesterday in their local timezone" has fully landed. Running
 * hourly catches every timezone band (CST hotels at 06:00 UTC, EST at
 * 05:00 UTC, PST at 09:00 UTC, etc.) without per-property scheduling.
 * The upserts are idempotent so a property gets sealed exactly once even
 * across 24 hourly ticks.
 *
 * Manual user marks ALWAYS win: we only insert attendance_marks rows
 * where the (property, date, staff) tuple has no row. If Mario marked
 * someone present or no-show via the UI, the auto-mark step skips them.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { runWithConcurrency } from '@/lib/parallel';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

// We only seal yesterday's data when local time has crossed past 01:00 in
// the property's tz — gives stragglers (late checkouts, late cleans) an
// hour to land before we freeze the labels.
const SEAL_AFTER_HOUR_LOCAL = 1;

type PropertyRow = {
  id: string;
  name: string;
  timezone: string | null;
};

interface SealOutcome {
  property_id: string;
  property_name: string;
  target_date: string | null;
  marks_inserted: number;
  attended_count: number;
  no_show_count: number;
  daily_log_written: boolean;
  skipped_reason?: string;
  error?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  // Optional ?date=YYYY-MM-DD param for backfill. When present, we seal
  // that exact date for every property (skipping the local-time gate)
  // instead of computing "yesterday in property tz". Used by the
  // scripts/backfill-seal-daily.js one-shot. Reject malformed input.
  const url = new URL(req.url);
  const overrideDate = url.searchParams.get('date');
  if (overrideDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
    return NextResponse.json(
      { ok: false, error: 'date must be YYYY-MM-DD', requestId },
      { status: 400 },
    );
  }

  // Pull every property with its timezone — timezone is what determines
  // which 24h window we're sealing.
  const { data: properties, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone');
  if (propErr) {
    log.error('seal-daily: properties query failed', { requestId, err: propErr as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(propErr), requestId }, { status: 500 });
  }

  // Parallel fan-out — each property is independent and the work per
  // property is short (~3 queries). Cap 5 to keep Vercel function memory
  // bounded.
  const outcomes = await runWithConcurrency(
    (properties ?? []) as PropertyRow[],
    async (p): Promise<SealOutcome> => {
      try {
        return await sealOne(p, requestId, overrideDate);
      } catch (e) {
        log.error('seal-daily: property seal failed', {
          requestId, property_id: p.id, property_name: p.name, err: e as Error,
        });
        return {
          property_id: p.id,
          property_name: p.name,
          target_date: null,
          marks_inserted: 0,
          attended_count: 0,
          no_show_count: 0,
          daily_log_written: false,
          error: errToString(e),
        };
      }
    },
    5,
  );

  const sealOutcomes: SealOutcome[] = outcomes.map((o) =>
    o.ok ? o.value : {
      property_id: o.input.id,
      property_name: o.input.name,
      target_date: null,
      marks_inserted: 0,
      attended_count: 0,
      no_show_count: 0,
      daily_log_written: false,
      error: errToString(o.error),
    },
  );

  // Top-level ok is true only if NO per-property error fired. This is the
  // pattern we want every ml cron to adopt (see also `jq` check in
  // .github/workflows/ml-cron.yml which guards against the silent-success
  // bug class — outer ok:true masking inner errors).
  const anyError = sealOutcomes.some((o) => o.error);
  const sealedCount = sealOutcomes.filter((o) => o.daily_log_written).length;
  const skippedCount = sealOutcomes.filter((o) => o.skipped_reason).length;
  const erroredCount = sealOutcomes.filter((o) => o.error).length;

  // Heartbeat on full success only. Doctor's cron_heartbeats_fresh check
  // reads back: a heartbeat older than 2× the cadence (hourly → > 2h
  // stale) flags as broken.
  if (!anyError) {
    await writeCronHeartbeat('seal-daily', {
      requestId,
      notes: { sealed: sealedCount, skipped: skippedCount, errored: erroredCount },
    });
  }

  return NextResponse.json({
    ok: !anyError,
    requestId,
    sealed: sealedCount,
    skipped: skippedCount,
    errored: erroredCount,
    results: sealOutcomes,
  });
}

/**
 * Compute the YYYY-MM-DD of "yesterday in this tz" — but only if the
 * current local hour is past SEAL_AFTER_HOUR_LOCAL. Otherwise returns
 * null (too early to seal today's previous day yet).
 *
 * Why "yesterday": at 01:00 local on May 12, "yesterday" = May 11. We
 * seal May 11's data once across the entire run-window of May 12 by
 * keying the writes on the date (idempotent).
 */
function targetDateForProperty(tz: string): string | null {
  // Intl.DateTimeFormat with the property's tz gives us a deterministic
  // "what local time/date is it right now in this hotel's zone".
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const localHour = parseInt(get('hour'), 10);
  if (Number.isNaN(localHour) || localHour < SEAL_AFTER_HOUR_LOCAL) {
    return null;
  }
  const todayLocal = `${get('year')}-${get('month')}-${get('day')}`;
  // Subtract one day → yesterday in YYYY-MM-DD form.
  const yesterday = new Date(`${todayLocal}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

async function sealOne(
  p: PropertyRow,
  requestId: string,
  overrideDate: string | null,
): Promise<SealOutcome> {
  const tz = p.timezone || 'America/Chicago';
  // Backfill mode bypasses the local-time gate — caller is asserting "I
  // know this date is fully past, seal it." Production cron uses the
  // computed-yesterday path.
  const targetDate = overrideDate ?? targetDateForProperty(tz);
  if (!targetDate) {
    return {
      property_id: p.id,
      property_name: p.name,
      target_date: null,
      marks_inserted: 0,
      attended_count: 0,
      no_show_count: 0,
      daily_log_written: false,
      skipped_reason: 'before_seal_window',
    };
  }

  // ─── 1. Seal attendance ──────────────────────────────────────────────
  // Read the day's schedule_assignment crew.
  const { data: sched, error: schedErr } = await supabaseAdmin
    .from('schedule_assignments')
    .select('crew')
    .eq('property_id', p.id)
    .eq('date', targetDate)
    .maybeSingle();
  if (schedErr) throw schedErr;
  const crew: string[] = (sched?.crew as string[] | null) ?? [];

  // Read existing attendance marks for that day to avoid clobbering
  // anything Mario set manually via the UI.
  const { data: existingMarks, error: marksErr } = await supabaseAdmin
    .from('attendance_marks')
    .select('staff_id')
    .eq('property_id', p.id)
    .eq('date', targetDate);
  if (marksErr) throw marksErr;
  const alreadyMarked = new Set(((existingMarks ?? []) as { staff_id: string }[]).map((m) => m.staff_id));

  // For each crew member without a mark, count their cleaning_events that
  // day. attended=true if ≥1 completed_at fell on the local date; else
  // false. We use the property's tz for the date boundary so a hotel in
  // EST doesn't accidentally pull events from the wrong UTC day.
  const toMark = crew.filter((staffId) => !alreadyMarked.has(staffId));
  let attendedCount = 0;
  let noShowCount = 0;
  if (toMark.length > 0) {
    // Query cleaning_events for this property on this date. We use the
    // event's own `date` column (which is already the local operational
    // date stored by the housekeeper write path).
    const { data: events, error: evErr } = await supabaseAdmin
      .from('cleaning_events')
      .select('staff_id')
      .eq('property_id', p.id)
      .eq('date', targetDate)
      .not('completed_at', 'is', null);
    if (evErr) throw evErr;
    const staffWithEvents = new Set(((events ?? []) as { staff_id: string }[]).map((e) => e.staff_id));

    const rowsToInsert = toMark.map((staffId) => ({
      property_id: p.id,
      date: targetDate,
      staff_id: staffId,
      attended: staffWithEvents.has(staffId),
      marked_by: null,
      notes: 'auto-marked by seal-daily cron',
    }));
    rowsToInsert.forEach((r) => {
      if (r.attended) attendedCount++;
      else noShowCount++;
    });

    if (rowsToInsert.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from('attendance_marks')
        .insert(rowsToInsert);
      if (insErr) throw insErr;
    }
  }

  // ─── 2. Seal daily_logs ──────────────────────────────────────────────
  // Aggregate the day's plan_snapshot (latest pulled_at row for this date)
  // and cleaning_events totals.
  const { data: plan } = await supabaseAdmin
    .from('plan_snapshots')
    .select('checkouts, stayovers, vacant_clean, vacant_dirty, ooo, total_rooms, recommended_hks, total_cleaning_minutes')
    .eq('property_id', p.id)
    .eq('date', targetDate)
    .order('pulled_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: completedEvents } = await supabaseAdmin
    .from('cleaning_events')
    .select('duration_minutes')
    .eq('property_id', p.id)
    .eq('date', targetDate)
    .not('completed_at', 'is', null);
  const roomsCompleted = (completedEvents ?? []).length;
  const totalMinutes = (completedEvents ?? []).reduce(
    (acc, e) => acc + (typeof e.duration_minutes === 'number' ? e.duration_minutes : 0),
    0,
  );
  const avgTurnaround = roomsCompleted > 0 ? Math.round(totalMinutes / roomsCompleted) : null;

  // Derive "occupied" from plan_snapshots:
  // total_rooms − vacant_clean − vacant_dirty − ooo = occupied. Same
  // formula the demand training's view uses; we mirror it so downstream
  // analytics agree.
  const occupied = plan
    ? Math.max(
        0,
        (Number(plan.total_rooms) || 0) -
          (Number(plan.vacant_clean) || 0) -
          (Number(plan.vacant_dirty) || 0) -
          (Number(plan.ooo) || 0),
      )
    : null;

  // actual_staff is intentionally NOT written here. headcount_actuals_view
  // derives the canonical actual_headcount from attendance_marks directly,
  // and that's what demand training reads. Computing it twice would risk
  // drift (e.g. a row deleted from attendance_marks would update the view
  // but not the daily_log copy). Leave daily_logs.actual_staff null; UIs
  // that want it read the view.
  const row: Record<string, unknown> = {
    property_id: p.id,
    date: targetDate,
    occupied,
    checkouts: plan ? Number(plan.checkouts) || 0 : null,
    stayovers: plan ? Number(plan.stayovers) || 0 : null,
    rooms_completed: roomsCompleted,
    avg_turnaround_minutes: avgTurnaround,
    total_minutes: totalMinutes || null,
    recommended_staff: plan ? plan.recommended_hks : null,
  };

  const { error: upErr } = await supabaseAdmin
    .from('daily_logs')
    .upsert(row, { onConflict: 'property_id,date' });
  if (upErr) throw upErr;

  log.info('seal-daily: sealed', {
    requestId, property_id: p.id, target_date: targetDate,
    marks_inserted: toMark.length, attended: attendedCount, no_show: noShowCount,
    rooms_completed: roomsCompleted,
  });

  return {
    property_id: p.id,
    property_name: p.name,
    target_date: targetDate,
    marks_inserted: toMark.length,
    attended_count: attendedCount,
    no_show_count: noShowCount,
    daily_log_written: true,
  };
}
