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
import { requireSessionOrCron, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { env } from '@/lib/env';

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

  // ─── Auth ──────────────────────────────────────────────────────────────
  // Mario's button calls this via fetchWithAuth which sends his Supabase
  // session token. Cron / smoke-test paths send Bearer CRON_SECRET. Either
  // is acceptable. Property-access check is below, after we parse pid.
  const auth = await requireSessionOrCron(req);
  if (!auth.ok) {
    log.warn('refresh-from-pms: unauthenticated', { requestId, route: 'refresh-from-pms' });
    return auth.response;
  }

  // Echo requestId back to the client via header — keeps the Vercel ↔
  // Railway log-correlation chain working even when callers don't read
  // the body (e.g. background watchdog).
  const headers = { 'x-request-id': requestId };

  let body: { pid?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    log.warn('refresh-from-pms: invalid json body', { requestId, route: 'refresh-from-pms' });
    return err('invalid_json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  const pid = body.pid;
  // Default to today (UTC) if not provided. Caller (RoomsTab) passes
  // the active date so historical-tab refreshes stay in scope.
  const date = body.date || new Date().toISOString().slice(0, 10);
  if (!pid) {
    log.warn('refresh-from-pms: missing pid', { requestId, route: 'refresh-from-pms' });
    return err('missing_pid', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  // Session callers must have access to the property they're refreshing.
  // Cron callers (CRON_SECRET) bypass this — cron is implicitly trusted
  // for any pid by virtue of holding the secret.
  if (auth.kind === 'session') {
    const hasAccess = await userHasPropertyAccess(auth.userId, pid);
    if (!hasAccess) {
      log.warn('refresh-from-pms: forbidden — user lacks property access', {
        requestId, route: 'refresh-from-pms', userId: auth.userId, pid,
      });
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
      });
    }
  }

  // ─── 1. Call the Railway scraper ─────────────────────────────────────
  const scraperUrl = env.RAILWAY_SCRAPER_URL;
  const cronSecret = env.CRON_SECRET;
  if (!scraperUrl) {
    log.error('refresh-from-pms: RAILWAY_SCRAPER_URL not configured', { requestId, route: 'refresh-from-pms' });
    return err(
      'RAILWAY_SCRAPER_URL not configured on Vercel. Set it in Project Settings → Environment Variables and redeploy.',
      { requestId, status: 503, code: ApiErrorCode.UpstreamFailure, headers },
    );
  }
  if (!cronSecret) {
    log.error('refresh-from-pms: CRON_SECRET not configured', { requestId, route: 'refresh-from-pms' });
    return err('CRON_SECRET not configured on Vercel.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure, headers,
    });
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
        // Pass property_id so the scraper can multi-tenant correctly
        // when more than one property is configured. Today the Railway
        // scraper validates this matches its env-configured PROPERTY_ID
        // and rejects mismatches (defensive — prevents accidental
        // cross-tenant pulls during the multi-property rollout).
        body: JSON.stringify({ property_id: pid }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (fetchErr) {
    log.error('refresh-from-pms: railway fetch failed', { requestId, route: 'refresh-from-pms', pid, err: fetchErr as Error });
    return err(`Could not reach Railway scraper: ${errToString(fetchErr)}`, {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure, headers,
    });
  }

  let scraperBody: ScraperResponse;
  try {
    scraperBody = await scraperRes.json();
  } catch {
    log.error('refresh-from-pms: railway returned non-json', { requestId, route: 'refresh-from-pms', pid, status: scraperRes.status });
    return err(`Railway returned non-JSON (status ${scraperRes.status})`, {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure, headers,
    });
  }
  if (!scraperRes.ok || !scraperBody.ok || !Array.isArray(scraperBody.rooms)) {
    log.error('refresh-from-pms: railway error response', { requestId, route: 'refresh-from-pms', pid, status: scraperRes.status, errorCode: scraperBody.code, scraperError: scraperBody.error });
    return err(scraperBody.error || `Railway returned status ${scraperRes.status}`, {
      requestId, status: 502,
      code: scraperBody.code ?? ApiErrorCode.UpstreamFailure,
      headers,
    });
  }

  const rooms = scraperBody.rooms;
  if (rooms.length === 0) {
    log.error('refresh-from-pms: railway returned zero rooms', { requestId, route: 'refresh-from-pms', pid });
    return err('Railway returned zero rooms — CA HK Center page may be down or layout changed', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure, headers,
    });
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
    return err(`rooms read failed: ${errToString(readErr)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }

  // Pull the property's master room inventory (migration 0025). Same
  // motivation as in /api/populate-rooms-from-plan: Choice Advantage's
  // Housekeeping Center page only returns rooms that need attention
  // today (dirty / occupied / checkout / arrival). Vacant-clean rooms
  // get omitted entirely. Without phantom-seeding the missing ones, the
  // Rooms tab would only show ~20 of 74 every time Mario hits "Load
  // Rooms from CSV." The phantom-seed loop after the upsert below adds
  // any inventory member that's neither in the HK Center pull nor
  // already in the DB as vacant + clean. Empty inventory (the schema
  // default for un-onboarded properties) skips the union, preserving
  // the old CA-only behavior.
  const { data: propRow, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('room_inventory')
    .eq('id', pid)
    .maybeSingle();
  if (propErr) {
    log.error('refresh-from-pms: property read failed', { requestId, route: 'refresh-from-pms', pid, err: propErr as unknown as Error });
    return err(`property read failed: ${errToString(propErr)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
  const inventory = (propRow?.room_inventory as string[] | null) ?? [];
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
      // Use err() with `details` carrying the partial-success info — the
      // UI's toast layer reads details.partiallySucceeded to switch from
      // "all-failed red" to "partial yellow."
      return err(`rooms insert failed: ${errToString(insertErr)}`, {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers,
        details: {
          partiallySucceeded: true,
          partial: { createdCount: 0, updatedCount, totalFromHkCenter: rooms.length },
        },
      });
    }
  }

  // Apply updates in parallel — each is a different row.
  let updateFailures = 0;
  if (updates.length > 0) {
    const results = await Promise.allSettled(updates);
    updateFailures = results.filter(r => r.status === 'rejected').length;
    if (updateFailures > 0) {
      log.error('refresh-from-pms: rooms update partial failure', { requestId, route: 'refresh-from-pms', pid, updateFailures, totalUpdates: updates.length });
      return err(`${updateFailures} rooms updates failed`, {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers,
        details: {
          // partiallySucceeded: tells the toast layer "some rooms WERE
          // refreshed; a subset failed." UI can decide whether to show
          // a warning toast (yellow) instead of an error toast (red).
          partiallySucceeded: true,
          partial: { createdCount, updatedCount: updatedCount - updateFailures, totalFromHkCenter: rooms.length },
        },
      });
    }
  }

  // ─── 3. Phantom-seed missing inventory rooms ─────────────────────────
  // Anything in `properties.room_inventory` that the HK Center pull
  // didn't mention and that doesn't already have a row for this date
  // gets seeded as vacant + clean. This is what makes the "Load Rooms
  // from CSV" button result in all 74 rooms on the board, not just the
  // ~20 dirty/occupied/checkout subset CA bothers to return.
  //
  // Reasoning is identical to populate-rooms-from-plan's phantom-seed
  // step (lines ~281-325). Kept in lockstep so a Mario click here and
  // the morning seeder both produce a complete board.
  //
  // Safety:
  //   • upsert with onConflict='property_id,date,number' silently no-ops
  //     if a parallel request raced us to the row.
  //   • We diff against `existingByNumber` (rows already in the table at
  //     the start of the request) AND against the HK Center pull (just
  //     inserted). Together they cover every row that should NOT be
  //     phantom-seeded.
  let phantomCreated = 0;
  if (inventory.length > 0) {
    const hkCenterNumbers = new Set(rooms.map((r) => r.number).filter(Boolean));
    const phantomRows: Array<Record<string, unknown>> = [];
    for (const num of inventory) {
      if (!num) continue;
      if (hkCenterNumbers.has(num)) continue;       // CA already covered it (insert OR update path above)
      if (existingByNumber.has(num)) continue;      // row pre-existed — leave it alone (could be in_progress, etc.)
      phantomRows.push({
        property_id: pid,
        number: num,
        date,
        type: 'vacant',
        status: 'clean',
        priority: 'standard',
        is_dnd: false,
      });
    }
    if (phantomRows.length > 0) {
      const { error: phantomErr } = await supabaseAdmin
        .from('rooms')
        .upsert(phantomRows, { onConflict: 'property_id,date,number' });
      if (phantomErr) {
        // Phantom-seed failure is degraded but not fatal — the CA-side
        // updates already landed. Log and surface a partial success so the
        // UI toast can warn rather than scream.
        log.error('refresh-from-pms: phantom-seed insert failed', { requestId, route: 'refresh-from-pms', pid, err: phantomErr as unknown as Error, attempted: phantomRows.length });
        return err(`phantom-seed insert failed: ${errToString(phantomErr)}`, {
          requestId, status: 500, code: ApiErrorCode.InternalError, headers,
          details: {
            partiallySucceeded: true,
            partial: { createdCount, updatedCount, totalFromHkCenter: rooms.length, phantomCreated: 0 },
          },
        });
      }
      phantomCreated = phantomRows.length;
      createdCount += phantomCreated;
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
    phantomCreated,
    scraperElapsedMs: scraperBody.elapsedMs,
  });
  return ok({
    pulledAt: scraperBody.pulledAt,
    elapsedMs: scraperBody.elapsedMs,
    totalFromHkCenter: rooms.length,
    createdCount,
    updatedCount,
    phantomCreated,
  }, { requestId, headers });
}
