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
import { requireAdminOrCron } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { runWithConcurrency } from '@/lib/parallel';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { countsTrusted, isDataPending } from '@/lib/pms/feed-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

// We only seal yesterday's data when local time has crossed past 01:00 in
// the property's tz — gives stragglers (late checkouts, late cleans) an
// hour to land before we freeze the labels.
const SEAL_AFTER_HOUR_LOCAL = 1;

// How recent a CUA snapshot must be to count as "positive evidence the robot
// is actually delivering data for this hotel." A dead robot leaves the last
// snapshot stale; without this gate the trusted-flags path defaulted to
// trusted on a lookup miss and sealed fabricated 0s (the incident this fix
// closes — Comfort Suites had 14 fake-0 days with zero snapshot rows).
const PMS_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Minimal shape of a pms_in_house_snapshot row for the freshness gate.
export type PmsSnapshotEvidence = {
  has_error: boolean | null;
  last_good_at: string | null;
  captured_at: string | null;
};

/**
 * Positive-evidence gate: does this property have a CUA snapshot that proves
 * the robot is live and healthy right now? True only when the snapshot exists,
 * is not in an error state, and its last-good time (fallback capture time) is
 * within the last 24h.
 *
 * Pure + exported for unit testing (matches the localDatesForProjection
 * pattern). `now` is injectable so tests don't depend on wall-clock time.
 *
 * A missing snapshot (snap === null) → no evidence → false: the exact
 * dead-robot / manual-no-PMS case that must NOT seal fake 0s.
 */
export function hasFreshPmsEvidence(
  snap: PmsSnapshotEvidence | null,
  now: Date = new Date(),
): boolean {
  if (!snap) return false;
  if (snap.has_error === true) return false;
  const ts = snap.last_good_at ?? snap.captured_at;
  if (!ts) return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= PMS_EVIDENCE_MAX_AGE_MS;
}

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
  // How many plan_snapshots rows we projected for this property this run
  // (today + tomorrow = 0, 1, or 2). 0 when the property has no live CUA
  // data — we deliberately don't write fake 0-occupancy rows (see
  // projectPlanSnapshots).
  plan_snapshots_written: number;
  skipped_reason?: string;
  error?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  // Admin OR cron — production cron uses CRON_SECRET; one-shot backfill
  // from an admin's browser session uses the admin path (the route is
  // idempotent and the worst case is "admin re-runs an already-sealed
  // date" which is a no-op via the upserts).
  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;

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
    log.error('seal-daily: properties query failed', { requestId, err: propErr });
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
          plan_snapshots_written: 0,
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
      plan_snapshots_written: 0,
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
  const planSnapshotsWritten = sealOutcomes.reduce((acc, o) => acc + (o.plan_snapshots_written || 0), 0);

  // Heartbeat on full success only. Doctor's cron_heartbeats_fresh check
  // reads back: a heartbeat older than 2× the cadence (hourly → > 2h
  // stale) flags as broken.
  if (!anyError) {
    await writeCronHeartbeat('seal-daily', {
      requestId,
      notes: {
        sealed: sealedCount,
        skipped: skippedCount,
        errored: erroredCount,
        plan_snapshots_written: planSnapshotsWritten,
      },
    });
  }

  return NextResponse.json({
    ok: !anyError,
    requestId,
    sealed: sealedCount,
    skipped: skippedCount,
    errored: erroredCount,
    plan_snapshots_written: planSnapshotsWritten,
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
      plan_snapshots_written: 0,
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

  // Pull this date's cleaning_events ONCE — we use it for both the
  // attended-yes/no signal AND (if no schedule_assignments row exists)
  // as the source for the implicit crew set. See fallback below.
  const { data: events, error: evErr } = await supabaseAdmin
    .from('cleaning_events')
    .select('staff_id')
    .eq('property_id', p.id)
    .eq('date', targetDate)
    .not('completed_at', 'is', null);
  if (evErr) throw evErr;
  const staffWithEvents = new Set(
    ((events ?? []) as { staff_id: string }[])
      .map((e) => e.staff_id)
      .filter((s): s is string => !!s),
  );

  // ── Implicit-crew fallback (May 2026 audit pass-5) ─────────────────
  // Previously: if schedule_assignments.crew was empty (hotel hasn't
  // adopted the schedule feature yet, or PMS schedule pull hasn't
  // landed), zero attendance marks were written, labels_complete
  // stayed false forever, and demand training reported insufficient_
  // data permanently. Now: if a real schedule exists, use it; if not,
  // derive the crew from staff who actually completed cleanings.
  // Their attended=true is implicit (they did the work; they showed
  // up). This unblocks training for paper-schedule hotels.
  const effectiveCrew = crew.length > 0 ? crew : Array.from(staffWithEvents);

  // For each crew member without an existing mark, infer attended.
  const toMark = effectiveCrew.filter((staffId) => !alreadyMarked.has(staffId));
  let attendedCount = 0;
  let noShowCount = 0;
  if (toMark.length > 0) {
    const rowsToInsert = toMark.map((staffId) => ({
      property_id: p.id,
      date: targetDate,
      staff_id: staffId,
      attended: staffWithEvents.has(staffId),
      marked_by: null,
      notes: crew.length > 0
        ? 'auto-marked by seal-daily cron'
        : 'auto-marked by seal-daily cron (no schedule — crew derived from cleaning_events)',
    }));
    rowsToInsert.forEach((r) => {
      if (r.attended) attendedCount++;
      else noShowCount++;
    });

    const { error: insErr } = await supabaseAdmin
      .from('attendance_marks')
      .insert(rowsToInsert);
    if (insErr) throw insErr;
  }

  // ─── 2. Seal daily_logs ──────────────────────────────────────────────
  // Aggregate day totals from the Plan v4 bridge RPC
  // (today_property_counts_v1) instead of the dropped plan_snapshots.
  // Same numbers: checkouts, stayovers, vacant_clean, vacant_dirty, ooo,
  // in_house, total_rooms — derived live from pms_in_house_snapshot +
  // pms_reservations + pms_rooms_inventory.
  const { data: counts } = await supabaseAdmin
    .rpc('today_property_counts_v1', { p_property_id: p.id, p_date: targetDate });
  const planRow = Array.isArray(counts) && counts.length > 0
    ? (counts[0] as {
        checkouts: number; stayovers: number; vacant_clean: number;
        vacant_dirty: number; ooo: number; total_rooms: number; in_house: number;
      })
    : null;

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

  // feat/cua-partial-promotion — daily_logs is HISTORY; a value sealed from
  // a feed with no source poisons every later trend/report and no banner
  // can retro-fix it. Review-pass hardening (fake-empty hunter #1 + Codex
  // P0): ALL of in_house / vacant_clean / vacant_dirty / ooo come
  // exclusively from pms_in_house_snapshot (today_property_counts_v1
  // COALESCEs them to 0) — so when the counts feed is anything but live
  // ('learning', OR the permanent 'unavailable' on every newly-learned PMS
  // family), the fallback math total−0−0−0 would seal FAKE-FULL occupancy
  // every night. Same for a 'pending' connection (never synced — every
  // table empty). Gate on trusted-ness, not just 'learning'.
  // Fail-safe: lookup error → flags default to trusted → exact pre-existing
  // behavior (incl. for manual no-PMS hotels, whose mode is no_pms).
  let reservationsUntrusted = false;
  let sealCountsTrusted = true;
  try {
    const fs = await getPropertyFeedStatus(p.id);
    if (fs.mode === 'live') {
      const pending = isDataPending(fs);
      reservationsUntrusted = pending ||
        fs.feeds.arrivals === 'learning' || fs.feeds.departures === 'learning';
      sealCountsTrusted = countsTrusted(fs);
    }
  } catch { /* non-fatal */ }

  // 2026-07 data-hygiene fix — POSITIVE-EVIDENCE gate. The trusted-flags above
  // default to trusted on a feed-status lookup miss and never check whether the
  // CUA has EVER delivered data. That's how 14 days of fabricated 0-occupancy
  // sealed for a hotel with a dead robot (no pms_in_house_snapshot row at all).
  // Require an actual, healthy, recent snapshot before writing ANY PMS-derived
  // field non-null. Additional condition, not a replacement for the flags.
  // Lookup error → no evidence → NULL (fail CLOSED here: the poison this closes
  // is worse than a NULL day, and a genuinely-live hotel re-seals next tick).
  let pmsEvidenceFresh = false;
  try {
    const { data: snap } = await supabaseAdmin
      .from('pms_in_house_snapshot')
      .select('has_error, last_good_at, captured_at')
      .eq('property_id', p.id)
      .maybeSingle();
    pmsEvidenceFresh = hasFreshPmsEvidence(snap as PmsSnapshotEvidence | null);
  } catch { /* no evidence → fields stay NULL */ }

  // Prefer the CUA's actual in_house count over the derived total_rooms
  // minus vacancies. Both paths read snapshot-sourced columns, so both are
  // gated on the counts feed being trusted AND on fresh CUA evidence.
  const occupied = planRow && sealCountsTrusted && pmsEvidenceFresh
    ? planRow.in_house > 0
      ? planRow.in_house
      : Math.max(0, (planRow.total_rooms || 0) - (planRow.vacant_clean || 0) - (planRow.vacant_dirty || 0) - (planRow.ooo || 0))
    : null;

  // Cleaning minutes per category: read from properties.config.cleaningMinutes
  // (same source plan-snapshots.ts uses to compute recommendedHKs).
  const { data: propRow } = await supabaseAdmin
    .from('properties').select('config').eq('id', p.id).maybeSingle();
  const cm = ((propRow?.config as Record<string, unknown>)?.cleaningMinutes ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const checkoutMin = num(cm.checkout, 30);
  const stayDay1Min = num(cm.stayoverDay1, 15);
  const stayDay2Min = num(cm.stayoverDay2, 20);
  const vacantDirtyMin = num(cm.vacantDirty, 30);
  const shiftMin = num(cm.shift, 420);
  const totalCleaningMinutes = planRow
    ? (planRow.checkouts * checkoutMin)
      + (planRow.stayovers * stayDay1Min)  // day1 used as average across stayover bucket
      + (planRow.vacant_dirty * vacantDirtyMin)
    : 0;
  // Silence the unused-warning on stayDay2 — it's reserved for the
  // per-day split when ScheduleTab feeds us back richer data.
  void stayDay2Min;
  const recommendedHKs = shiftMin > 0 ? Math.max(0, Math.ceil(totalCleaningMinutes / shiftMin)) : 0;

  const row: Record<string, unknown> = {
    property_id: p.id,
    date: targetDate,
    occupied: occupied !== null ? Math.round(occupied) : null,
    // checkouts/stayovers derive from pms_reservations — NULL (not 0) while
    // the reservation feeds are learning, the first sync hasn't landed, or the
    // CUA has no fresh healthy snapshot (dead robot / never-connected hotel).
    checkouts: planRow && !reservationsUntrusted && pmsEvidenceFresh ? Math.round(planRow.checkouts) : null,
    stayovers: planRow && !reservationsUntrusted && pmsEvidenceFresh ? Math.round(planRow.stayovers) : null,
    rooms_completed: Math.round(roomsCompleted),
    avg_turnaround_minutes: avgTurnaround,
    total_minutes: totalMinutes > 0 ? Math.round(totalMinutes) : null,
    // Derived from checkouts/stayovers (reservations) + vacant_dirty
    // (snapshot) — meaningless unless BOTH sources are trusted AND the CUA
    // has fresh evidence.
    recommended_staff: planRow && !reservationsUntrusted && sealCountsTrusted && pmsEvidenceFresh ? recommendedHKs : null,
  };

  const { error: upErr } = await supabaseAdmin
    .from('daily_logs')
    .upsert(row, { onConflict: 'property_id,date' });
  if (upErr) throw upErr;

  // ─── 3. Project plan_snapshots for today + tomorrow ──────────────────
  // The Python ML inventory model reads TOMORROW'S projected occupancy from
  // plan_snapshots (ml-service/src/inference/inventory_rate.py). That table
  // has been an empty stub since Plan v4 deleted the scraper that wrote it,
  // so ML silently fell back to a 14-day historic mean. We refill it here
  // from the live CUA data via project_property_counts_v1 (migration 0292)
  // — one projection per (property, date), keyed on property-local today +
  // tomorrow. Gated on the property having live CUA data (see helper) so we
  // never write a fake 0-occupancy row that would poison the model.
  const planSnapshotsWritten = await projectPlanSnapshots({
    property: p,
    tz,
    reservationsUntrusted,
    pmsEvidenceFresh,
    requestId,
  });

  log.info('seal-daily: sealed', {
    requestId, property_id: p.id, target_date: targetDate,
    marks_inserted: toMark.length, attended: attendedCount, no_show: noShowCount,
    rooms_completed: roomsCompleted, plan_snapshots_written: planSnapshotsWritten,
  });

  return {
    property_id: p.id,
    property_name: p.name,
    target_date: targetDate,
    marks_inserted: toMark.length,
    attended_count: attendedCount,
    no_show_count: noShowCount,
    daily_log_written: true,
    plan_snapshots_written: planSnapshotsWritten,
  };
}

/**
 * Compute "today" and "tomorrow" as YYYY-MM-DD in the property's local
 * timezone. Uses the same Intl.DateTimeFormat approach as
 * targetDateForProperty so all three (yesterday/today/tomorrow) key off one
 * consistent notion of the property's local calendar day.
 *
 * Exported for unit testing (cron-seal-daily-projection.test.ts) — the
 * date-arithmetic is the piece most prone to a DST/off-by-one bug.
 */
export function localDatesForProjection(tz: string): { today: string; tomorrow: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((pp) => pp.type === t)?.value ?? '';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  // Add one day via a noon-UTC anchor to dodge DST edge cases.
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  const tomorrow = t.toISOString().slice(0, 10);
  return { today, tomorrow };
}

// Shape returned by the project_property_counts_v1 RPC (migration 0292).
type ProjectedCounts = {
  total_rooms: number;
  arrivals: number;
  stayovers: number;
  checkouts: number;
  vacant_clean: number;
  vacant_dirty: number;
  ooo: number;
  stayover_day1: number;
  stayover_day2: number;
  stayover_arrival_day: number;
  stayover_unknown: number;
  arrival_room_numbers: string[] | null;
  stayover_day1_room_numbers: string[] | null;
  checkout_room_numbers: string[] | null;
};

/**
 * Project + upsert plan_snapshots rows for the property's local today and
 * tomorrow, so the ML inventory/demand/supply inference paths read real
 * PMS-projected occupancy instead of the 14-day-mean fallback.
 *
 * NO-CUA-DATA GUARD (why we don't just always write):
 *   plan_snapshots is HISTORY-adjacent — a fake 0-occupancy row for a
 *   property with no live feed would train the inventory model at
 *   occupancy=0 (predicting ~0 usage / never reorder). We therefore only
 *   write when BOTH hold:
 *     1. The property has a HEALTHY, FRESH pms_in_house_snapshot row
 *        (pmsEvidenceFresh) — proof the CUA is actually connected and polling
 *        for this hotel right now. Row-existence alone is not enough: a dead
 *        robot leaves a stale snapshot, and a snapshot in an error state is
 *        untrustworthy. Same positive-evidence gate the daily_logs seal uses.
 *     2. The reservation feeds are trusted (reservationsUntrusted === false)
 *        — arrivals/departures aren't 'learning' and the first sync landed.
 *        This is the SAME signal the daily_logs seal above uses to decide
 *        whether checkouts/stayovers are real; occupancy is derived from the
 *        same reservation counts, so the same gate applies.
 *   Manual no-PMS hotels (no snapshot row), dead-robot hotels (stale/errored
 *   snapshot), and still-learning connections are skipped — they keep using
 *   the historic-mean fallback, which is the correct behavior for a hotel with
 *   no projected-occupancy source.
 *
 * Returns the number of rows written (0, 1, or 2). Best-effort: a failure to
 * project does NOT fail the whole seal (the daily_logs write already
 * succeeded); it's logged and reported as 0 written so the counter is honest.
 */
async function projectPlanSnapshots(args: {
  property: PropertyRow;
  tz: string;
  reservationsUntrusted: boolean;
  pmsEvidenceFresh: boolean;
  requestId: string;
}): Promise<number> {
  const { property: p, tz, reservationsUntrusted, pmsEvidenceFresh, requestId } = args;

  // Gate 2: reservations must be trusted (same signal daily_logs uses).
  if (reservationsUntrusted) {
    return 0;
  }

  // Gate 1: property must have a HEALTHY, FRESH CUA snapshot — not merely a
  // row (a dead robot leaves a stale snapshot; an errored one is untrusted).
  // Uses the same positive-evidence signal the daily_logs seal computed, so a
  // dead-robot hotel skips projection instead of writing a fake 0-occupancy
  // row that would train the inventory model to never reorder.
  if (!pmsEvidenceFresh) {
    return 0;
  }

  const { today, tomorrow } = localDatesForProjection(tz);
  let written = 0;
  for (const projDate of [today, tomorrow]) {
    const { data: counts, error: rpcErr } = await supabaseAdmin
      .rpc('project_property_counts_v1', { p_property_id: p.id, p_target_date: projDate });
    if (rpcErr) {
      log.warn('seal-daily: project_property_counts_v1 failed', {
        requestId, property_id: p.id, date: projDate, err: rpcErr,
      });
      continue;
    }
    const c = Array.isArray(counts) && counts.length > 0 ? (counts[0] as ProjectedCounts) : null;
    if (!c) continue;

    // Match the plan_snapshots stub columns the ML code reads (migration
    // 0205). total_cleaning_minutes / recommended_hks are left at their
    // column defaults (0) — supply/demand COALESCE them and don't rely on a
    // projected value. pull_type tags the row's provenance for debugging.
    const snapshotRow: Record<string, unknown> = {
      property_id: p.id,
      date: projDate,
      pulled_at: new Date().toISOString(),
      pull_type: 'projection',
      total_rooms: c.total_rooms,
      arrivals: c.arrivals,
      stayovers: c.stayovers,
      checkouts: c.checkouts,
      vacant_clean: c.vacant_clean,
      vacant_dirty: c.vacant_dirty,
      ooo: c.ooo,
      stayover_day1: c.stayover_day1,
      stayover_day2: c.stayover_day2,
      stayover_arrival_day: c.stayover_arrival_day,
      stayover_unknown: c.stayover_unknown,
      arrival_room_numbers: c.arrival_room_numbers ?? [],
      stayover_day1_room_numbers: c.stayover_day1_room_numbers ?? [],
      checkout_room_numbers: c.checkout_room_numbers ?? [],
    };

    const { error: upErr } = await supabaseAdmin
      .from('plan_snapshots')
      .upsert(snapshotRow, { onConflict: 'property_id,date' });
    if (upErr) {
      log.warn('seal-daily: plan_snapshots upsert failed', {
        requestId, property_id: p.id, date: projDate, err: upErr,
      });
      continue;
    }
    written += 1;
  }
  return written;
}
