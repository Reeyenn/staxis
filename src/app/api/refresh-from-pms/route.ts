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
  let body: { pid?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const pid = body.pid;
  // Default to today (UTC) if not provided. Caller (RoomsTab) passes
  // the active date so historical-tab refreshes stay in scope.
  const date = body.date || new Date().toISOString().slice(0, 10);
  if (!pid) {
    return NextResponse.json({ ok: false, error: 'missing_pid' }, { status: 400 });
  }

  // ─── 1. Call the Railway scraper ─────────────────────────────────────
  const scraperUrl = process.env.RAILWAY_SCRAPER_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!scraperUrl) {
    return NextResponse.json({
      ok: false,
      error: 'RAILWAY_SCRAPER_URL not configured on Vercel. Set it in Project Settings → Environment Variables and redeploy.',
    }, { status: 503 });
  }
  if (!cronSecret) {
    return NextResponse.json({
      ok: false,
      error: 'CRON_SECRET not configured on Vercel.',
    }, { status: 503 });
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
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Could not reach Railway scraper: ${errToString(err)}`,
    }, { status: 502 });
  }

  let scraperBody: ScraperResponse;
  try {
    scraperBody = await scraperRes.json();
  } catch {
    return NextResponse.json({
      ok: false,
      error: `Railway returned non-JSON (status ${scraperRes.status})`,
    }, { status: 502 });
  }
  if (!scraperRes.ok || !scraperBody.ok || !Array.isArray(scraperBody.rooms)) {
    return NextResponse.json({
      ok: false,
      error: scraperBody.error || `Railway returned status ${scraperRes.status}`,
      code: scraperBody.code,
    }, { status: 502 });
  }

  const rooms = scraperBody.rooms;
  if (rooms.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'Railway returned zero rooms — CA HK Center page may be down or layout changed',
    }, { status: 502 });
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
    return NextResponse.json({
      ok: false,
      error: `rooms read failed: ${errToString(readErr)}`,
    }, { status: 500 });
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
    const existingRoom = existingByNumber.get(room.number);
    let newStatus: string = room.condition; // 'clean' | 'dirty'
    if (existingRoom) {
      if (existingRoom.status === 'inspected' && room.condition === 'clean') {
        newStatus = 'inspected';
      } else if (existingRoom.status === 'in_progress' && room.condition === 'dirty') {
        // Mid-clean and PMS still says dirty — preserve in_progress so
        // we don't kick the housekeeper's tap state.
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
      return NextResponse.json({
        ok: false,
        error: `rooms insert failed: ${errToString(insertErr)}`,
        partial: { createdCount: 0, updatedCount, totalFromHkCenter: rooms.length },
      }, { status: 500 });
    }
  }

  // Apply updates in parallel — each is a different row.
  if (updates.length > 0) {
    const results = await Promise.allSettled(updates);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      return NextResponse.json({
        ok: false,
        error: `${failures.length} rooms updates failed`,
        partial: { createdCount, updatedCount: updatedCount - failures.length, totalFromHkCenter: rooms.length },
      }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    pulledAt: scraperBody.pulledAt,
    elapsedMs: scraperBody.elapsedMs,
    totalFromHkCenter: rooms.length,
    createdCount,
    updatedCount,
  });
}
