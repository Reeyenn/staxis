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

// The type/status derivation moved into the RPC
// (staxis_refresh_rooms_from_pms) so it happens inside the same
// transaction as the writes. Rules are unchanged: service "Stay Over"
// → 'stayover'; else condition 'dirty' → 'checkout'; else 'vacant'.
// Existing 'inspected' / 'in_progress' states are preserved as before.

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
    return err('Could not reach Railway scraper', {
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

  // ─── 2. Atomic refresh via RPC ────────────────────────────────────────
  // Audit P0.2 + P1.4 (2026-05-17): previously this route did the CA-rooms
  // insert, N parallel per-row UPDATEs, and the phantom-seed upsert as
  // three separate phases. `Promise.allSettled` tolerated partial UPDATE
  // failures, and the phantom-seed only ran when all updates succeeded —
  // so a single failed UPDATE skipped phantom-seeding entirely (board
  // showed a hole). All three writes now go through one RPC:
  // staxis_refresh_rooms_from_pms wraps everything in a transaction and
  // does the per-row UPDATEs as a single bulk UPDATE … FROM (VALUES …)
  // (one round-trip instead of N). See
  // supabase/migrations/0133_rpc_refresh_rooms_from_pms.sql.
  //
  // We still pre-fetch `properties.room_inventory` (the master room list)
  // because the RPC needs it as input for the phantom-seed step — that
  // way the RPC stays a pure function of its inputs and doesn't have to
  // re-derive it from yet another table.
  const { data: propRow, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('room_inventory')
    .eq('id', pid)
    .maybeSingle();
  if (propErr) {
    log.error('refresh-from-pms: property read failed', { requestId, route: 'refresh-from-pms', pid, err: propErr });
    return err('property read failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
  const inventory = (propRow?.room_inventory as string[] | null) ?? [];

  // Reshape the scraper output for the RPC. The RPC takes snake_case
  // is_dnd and the raw 'service' / 'condition' fields so it can do the
  // type/status derivation in SQL.
  const rpcRooms = rooms
    .filter(r => !!r.number)
    .map(r => ({
      number: r.number,
      condition: r.condition,
      service: r.service,
      is_dnd: r.isDnd,
    }));

  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('staxis_refresh_rooms_from_pms', {
    p_property: pid,
    p_date: date,
    p_rooms: rpcRooms,
    p_inventory: inventory,
  });
  if (rpcErr) {
    log.error('refresh-from-pms: rpc failed', { requestId, route: 'refresh-from-pms', pid, err: rpcErr });
    return err('rooms refresh failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
      // Whole transaction rolled back — nothing partial to report.
      details: {
        partiallySucceeded: false,
        partial: { createdCount: 0, updatedCount: 0, totalFromHkCenter: rooms.length, phantomCreated: 0 },
      },
    });
  }

  const result = (rpcData ?? {}) as { created_count?: number; updated_count?: number; phantom_created?: number };
  let createdCount = Number(result.created_count ?? 0);
  const updatedCount = Number(result.updated_count ?? 0);
  const phantomCreated = Number(result.phantom_created ?? 0);
  createdCount += phantomCreated;

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
