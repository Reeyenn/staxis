/**
 * Refresh rooms table from live PMS state.
 *
 * Mario clicks "Load Rooms from CSV" on the Rooms tab → this endpoint
 * calls the Railway scraper's /scrape/hk-center HTTP endpoint, which
 * navigates to Choice Advantage's Housekeeping Center page and reads
 * each room's CLEAN/DIRTY condition + service mode + DND flag in real
 * time. We then upsert the result into our rooms table for today's
 * date.
 *
 * Different from /api/populate-rooms-from-plan:
 *   - populate-rooms-from-plan reads from plan_snapshots (the morning
 *     CSV), which is hourly-cached arrivals/departures plan data. Good
 *     for the initial day setup.
 *   - this route reads from the live HK Center page, which reflects
 *     what's been marked clean/dirty in PMS *right now*. Good for mid-
 *     day refresh after housekeepers update PMS directly.
 *
 * Architecture:
 *   - Vercel can't run Playwright on demand (no Chrome runtime, 30s
 *     function cap, no persistent CA login). Railway has the scraper
 *     with a persistent CA session, so we delegate the actual scrape
 *     to Railway via HTTP.
 *   - Auth between Vercel and Railway is Bearer ${CRON_SECRET} — same
 *     secret already used by GitHub Actions cron and the watchdog, so
 *     credential drift surfaces in one place (the doctor's
 *     cron_secret_cross_platform check).
 *
 * Env vars required (Vercel):
 *   - CRON_SECRET                      shared with Railway
 *   - RAILWAY_SCRAPER_URL              e.g. https://hotelops-scraper-prod.up.railway.app
 *   - SUPABASE_SERVICE_ROLE_KEY        for the rooms upsert
 *   - NEXT_PUBLIC_SUPABASE_URL         standard
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface HkCenterRoom {
  number: string;
  type: string;          // CA internal code (SNQQ, SNK, …) — not used for our type field
  roomStatus: string;    // 'Occupied' | 'Vacant'
  condition: 'clean' | 'dirty';
  service: string;       // 'Stay Over' | 'None' | …
  assignedTo: string;    // initials, e.g. 'M. C.' (PMS-side, not our staff_id)
  isDnd: boolean;
}

interface ScraperResponse {
  ok: boolean;
  pulledAt?: string;
  elapsedMs?: number;
  rooms?: HkCenterRoom[];
  error?: string;
  code?: string;
}

/**
 * Map HK Center fields → our rooms.type. The CSV-driven plan_snapshot is
 * authoritative for the morning plan, but mid-day a room can drift —
 * a guest checks out early and goes from stayover→checkout, an arrival
 * gets pre-cleaned, etc. The HK Center page reflects PMS truth at the
 * moment of pull, so we re-derive type from service + condition.
 *
 *   service "Stay Over" anywhere      → 'stayover'
 *   else, condition 'dirty'           → 'checkout' (anything dirty needs full clean)
 *   else, condition 'clean'           → 'vacant'
 *
 * This is a deliberate simplification — we don't try to distinguish
 * "vacant clean carryover" from "fresh checkout that's already been
 * cleaned." Mario's UI doesn't surface that difference and our
 * housekeeper flow doesn't care. If it ever matters, plan_snapshots
 * has the true checkout/arrival flags.
 */
function deriveRoomType(room: HkCenterRoom): 'checkout' | 'stayover' | 'vacant' {
  if (/stay\s*over/i.test(room.service)) return 'stayover';
  if (room.condition === 'dirty') return 'checkout';
  return 'vacant';
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Request id rides through the whole chain: Vercel route → Railway
  // /scrape/hk-center (via x-request-id header) → Vercel logs again on
  // the response. Lets us pluck a single user's "Load Rooms" round trip
  // out of either log stream by id.
  const requestId = getOrMintRequestId(req);
  const t0 = Date.now();

  let body: { pid?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    log.warn('refresh-from-pms: invalid json body', { requestId, route: 'refresh-from-pms' });
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: { 'x-request-id': requestId } });
  }

  const pid = body.pid;
  // Default to today (UTC) if not provided. Caller (RoomsTab) passes
  // the active date so historical-tab refreshes stay in scope.
  const date = body.date || new Date().toISOString().slice(0, 10);
  if (!pid) {
    log.warn('refresh-from-pms: missing pid', { requestId, route: 'refresh-from-pms' });
    return NextResponse.json({ ok: false, error: 'missing_pid' }, { status: 400, headers: { 'x-request-id': requestId } });
  }

  // ─── 1. Call the Railway scraper ─────────────────────────────────────
  const scraperUrl = process.env.RAILWAY_SCRAPER_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!scraperUrl) {
    log.error('refresh-from-pms: RAILWAY_SCRAPER_URL not configured', { requestId, route: 'refresh-from-pms' });
    return NextResponse.json({
      ok: false,
      error: 'RAILWAY_SCRAPER_URL not configured on Vercel. Set it in Project Settings → Environment Variables and redeploy.',
    }, { status: 503, headers: { 'x-request-id': requestId } });
  }
  if (!cronSecret) {
    log.error('refresh-from-pms: CRON_SECRET not configured', { requestId, route: 'refresh-from-pms' });
    return NextResponse.json({
      ok: false,
      error: 'CRON_SECRET not configured on Vercel.',
    }, { status: 503, headers: { 'x-request-id': requestId } });
  }

  let scraperRes: Response;
  try {
    // 25s timeout — Railway side is configured for ~30s typical pull
    // (login session reuse means most calls are 5-10s, but a stale
    // session triggers re-login + retry which can take 25s+).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);
    try {
      scraperRes = await fetch(`${scraperUrl.replace(/\/$/, '')}/scrape/hk-center`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          'Content-Type': 'application/json',
          // Request-id propagation: Railway echoes this back in its own
          // logs so a single user click can be correlated across both
          // log streams without time-aligning timestamps by hand.
          'x-request-id': requestId,
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    log.error('refresh-from-pms: railway fetch failed', { requestId, route: 'refresh-from-pms', pid, err: err as Error });
    return NextResponse.json({
      ok: false,
      error: `Could not reach Railway scraper: ${errToString(err)}`,
    }, { status: 502, headers: { 'x-request-id': requestId } });
  }

  let scraperBody: ScraperResponse;
  try {
    scraperBody = await scraperRes.json();
  } catch {
    log.error('refresh-from-pms: railway returned non-json', { requestId, route: 'refresh-from-pms', pid, status: scraperRes.status });
    return NextResponse.json({
      ok: false,
      error: `Railway returned non-JSON (status ${scraperRes.status})`,
    }, { status: 502, headers: { 'x-request-id': requestId } });
  }
  if (!scraperRes.ok || !scraperBody.ok || !Array.isArray(scraperBody.rooms)) {
    log.error('refresh-from-pms: railway error response', { requestId, route: 'refresh-from-pms', pid, status: scraperRes.status, errorCode: scraperBody.code, scraperError: scraperBody.error });
    return NextResponse.json({
      ok: false,
      error: scraperBody.error || `Railway returned status ${scraperRes.status}`,
      code: scraperBody.code,
    }, { status: 502, headers: { 'x-request-id': requestId } });
  }

  const rooms = scraperBody.rooms;
  if (rooms.length === 0) {
    log.error('refresh-from-pms: railway returned zero rooms', { requestId, route: 'refresh-from-pms', pid });
    return NextResponse.json({
      ok: false,
      error: 'Railway returned zero rooms — CA HK Center page may be down or layout changed',
    }, { status: 502, headers: { 'x-request-id': requestId } });
  }

  // ─── 2. Upsert into rooms table ──────────────────────────────────────
  // For each room from HK Center, find or create the (property, date,
  // number) row and update its status + type + is_dnd. We preserve
  // assigned_to / assigned_name / started_at / completed_at / issue_note
  // because those fields are owned by Mario's UI or the housekeeper app —
  // not PMS.

  // Pull existing rooms for this property+date so we know which to
  // INSERT vs UPDATE. Same pattern as populate-rooms-from-plan.
  const { data: existing, error: readErr } = await supabaseAdmin
    .from('rooms')
    .select('id, number, status, started_at, completed_at')
    .eq('property_id', pid)
    .eq('date', date);
  if (readErr) {
    log.error('refresh-from-pms: rooms read failed', { requestId, route: 'refresh-from-pms', pid, err: readErr as unknown as Error });
    return NextResponse.json({
      ok: false,
      error: `rooms read failed: ${errToString(readErr)}`,
    }, { status: 500, headers: { 'x-request-id': requestId } });
  }
  const existingByNumber = new Map<string, { id: string; status: string; started_at: string | null; completed_at: string | null }>();
  for (const r of existing ?? []) {
    existingByNumber.set(String(r.number), {
      id: String(r.id),
      status: String(r.status),
      started_at: r.started_at as string | null,
      completed_at: r.completed_at as string | null,
    });
  }

  const toInsert: Array<Record<string, unknown>> = [];
  const updates: PromiseLike<unknown>[] = [];
  let createdCount = 0;
  let updatedCount = 0;

  for (const room of rooms) {
    if (!room.number) continue;
    const newType = deriveRoomType(room);

    // For status: HK Center says CLEAN or DIRTY. We map to our
    // 'clean' / 'dirty' enum. We DELIBERATELY don't downgrade an
    // 'inspected' room back to 'clean' — Maria's supervisor sign-off
    // sticks until the next dirty state. Same protection for
    // 'in_progress' (housekeeper started but not done).
    //
    // CRITICAL: 'in_progress' must be preserved regardless of what PMS
    // reports. Mid-clean state is owned by the housekeeper app — PMS
    // doesn't know about it. If the housekeeper marks the room "Done"
    // in PMS before tapping Finish in our app, PMS flips clean while we
    // still want the in_progress state to live until they tap Finish
    // (which writes a cleaning_event row). Without this guard, a refresh
    // mid-clean would downgrade them to 'clean' and we'd lose the audit
    // event entirely.
    const existingRoom = existingByNumber.get(room.number);
    let newStatus: string = room.condition; // 'clean' | 'dirty'
    if (existingRoom) {
      if (existingRoom.status === 'inspected' && room.condition === 'clean') {
        newStatus = 'inspected';
      } else if (existingRoom.status === 'in_progress') {
        // Housekeeper is mid-clean — only THEY can move this state via
        // /api/housekeeper/room-action (Finish/Reset/Stop). PMS state is
        // not authoritative here. Preserve regardless of clean/dirty.
        newStatus = 'in_progress';
      }
    }

    if (existingRoom) {
      const patch: Record<string, unknown> = {
        type: newType,
        status: newStatus,
        is_dnd: room.isDnd,
      };
      // If the new status is 'dirty' AND we're transitioning out of a
      // completed state, clear the completion timestamps so the next
      // clean records a fresh duration. Same rule the populate-rooms-
      // from-plan route uses.
      if (newStatus === 'dirty' && (existingRoom.status === 'clean' || existingRoom.status === 'inspected')) {
        patch.started_at = null;
        patch.completed_at = null;
      }
      updates.push(
        supabaseAdmin
          .from('rooms')
          .update(patch)
          .eq('id', existingRoom.id)
          .then(({ error }) => { if (error) throw error; }),
      );
      updatedCount++;
    } else {
      toInsert.push({
        property_id: pid,
        number: room.number,
        date,
        type: newType,
        status: newStatus,
        priority: 'standard',
        is_dnd: room.isDnd,
      });
      createdCount++;
    }
  }

  // Apply inserts first so concurrent updates don't conflict (they
  // shouldn't — different rows — but defensive).
  if (toInsert.length > 0) {
    const { error: insertErr } = await supabaseAdmin.from('rooms').insert(toInsert);
    if (insertErr) {
      log.error('refresh-from-pms: rooms insert failed', { requestId, route: 'refresh-from-pms', pid, err: insertErr as unknown as Error, attemptedInserts: toInsert.length });
      return NextResponse.json({
        ok: false,
        error: `rooms insert failed: ${errToString(insertErr)}`,
        // Be honest about what stuck and what didn't, so the UI can warn
        // Maria that the dataset is partially fresh / partially stale
        // rather than treating it as a clean refresh.
        partiallySucceeded: true,
        partial: { createdCount: 0, updatedCount, totalFromHkCenter: rooms.length },
      }, { status: 500, headers: { 'x-request-id': requestId } });
    }
  }

  // Apply updates in parallel — each is a different row.
  let updateFailures = 0;
  if (updates.length > 0) {
    const results = await Promise.allSettled(updates);
    updateFailures = results.filter(r => r.status === 'rejected').length;
    if (updateFailures > 0) {
      log.error('refresh-from-pms: rooms update partial failure', { requestId, route: 'refresh-from-pms', pid, updateFailures, totalUpdates: updates.length });
      return NextResponse.json({
        ok: false,
        error: `${updateFailures} rooms updates failed`,
        // partiallySucceeded: tells the toast layer "some rooms WERE
        // refreshed; a subset failed." UI can decide whether to show a
        // warning toast (yellow) instead of an error toast (red).
        partiallySucceeded: true,
        partial: { createdCount, updatedCount: updatedCount - updateFailures, totalFromHkCenter: rooms.length },
      }, { status: 500, headers: { 'x-request-id': requestId } });
    }
  }

  log.info('refresh-from-pms: ok', {
    requestId,
    route: 'refresh-from-pms',
    pid,
    durationMs: Date.now() - t0,
    totalFromHkCenter: rooms.length,
    createdCount,
    updatedCount,
    scraperElapsedMs: scraperBody.elapsedMs,
  });
  return NextResponse.json({
    ok: true,
    pulledAt: scraperBody.pulledAt,
    elapsedMs: scraperBody.elapsedMs,
    totalFromHkCenter: rooms.length,
    createdCount,
    updatedCount,
  }, { headers: { 'x-request-id': requestId } });
}
