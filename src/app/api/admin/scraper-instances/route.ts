/**
 * GET /api/admin/scraper-instances
 *
 * Fleet-ops visibility for the distributed scraper.
 *
 * Background: we run ONE Railway scraper service today (Comfort Suites,
 * single property). The plan for hotels #2…#50 is "spin up additional
 * Railway services as needed, each pinned to a `SCRAPER_INSTANCE_ID`
 * env var, with hotels assigned to instances via
 * scraper_credentials.scraper_instance" — see migration 0018 and
 * scraper/properties-loader.js. The schema and loader are in place;
 * this endpoint is the admin-facing view that makes the fleet legible
 * ("which Railway service polls which hotels, and is each one alive?").
 *
 * Response shape:
 *   instances:    grouped by scraper_instance, with a property roster
 *                 and a "healthy" flag (true if any property was polled
 *                 within HEALTHY_WINDOW_MIN minutes).
 *   unassigned:   properties that exist in `properties` but have no row
 *                 in `scraper_credentials` (likely a brand-new hotel
 *                 mid-onboarding, or a misconfiguration).
 *   summary:      top-line counts for the admin overview.
 *
 * The "last seen" signal is derived from plan_snapshots.pulled_at —
 * the scraper writes a row there on every successful CSV pull. If a
 * Railway instance dies, its hotels stop refreshing within ~5 minutes
 * (Choice Advantage scraper tick cadence). We don't need a dedicated
 * heartbeat table — the existing data flow already encodes liveness.
 *
 * Auth: admin role required (requireAdmin). Reads service-role tables.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// 15 min is generous — the scraper ticks every 5 min, so a healthy
// instance should never go 15 min without a write. Anything older is
// stale enough that Mario would notice as "data is old" before we
// would. We could tighten to 8-10 min later.
const HEALTHY_WINDOW_MIN = 15;

interface PropertySummary {
  property_id: string;
  property_name: string | null;
  is_active: boolean;
  pms_type: string;
  last_pull_at: string | null;
  minutes_since_pull: number | null;
}

interface InstanceSummary {
  scraper_instance: string;
  property_count: number;
  active_property_count: number;
  last_seen_at: string | null;
  healthy: boolean;
  properties: PropertySummary[];
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  // Admin OR cron-secret — fleet topology is sensitive and shouldn't be
  // readable by every signed-in staff member. Earlier draft used
  // requireSessionOrCron (any session); fixed to requireAdminOrCron to
  // match the POST sibling /api/admin/scraper-assign.
  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;

  try {
    // 1. All scraper_credentials rows (instance assignment).
    const { data: creds, error: credsErr } = await supabaseAdmin
      .from('scraper_credentials')
      .select('property_id, scraper_instance, is_active, pms_type');
    if (credsErr) {
      log.error('scraper-instances: creds query failed', { requestId, err: credsErr as unknown as Error });
      return err('failed to load scraper_credentials', { requestId, status: 500 });
    }

    // 2. All properties (so we can label, AND detect "unassigned" ones).
    const { data: properties, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('id, name');
    if (propErr) {
      log.error('scraper-instances: properties query failed', { requestId, err: propErr as unknown as Error });
      return err('failed to load properties', { requestId, status: 500 });
    }
    const nameByPid = new Map<string, string | null>(
      (properties ?? []).map((p) => [p.id as string, (p.name as string | null) ?? null]),
    );

    // 3. Latest plan_snapshots.pulled_at per property — the scraper
    //    writes this on every successful CSV upsert, so it's our liveness
    //    signal.
    //
    //    Earlier draft pulled all rows from the last 24h and reduced
    //    in-memory with a 5000-row limit. That breaks at fleet scale:
    //    50 hotels × 12 ticks/hour × 24h = 14,400 rows — half the data
    //    would be truncated and hotels polled less recently would falsely
    //    appear stale. Now we push the aggregation to Postgres so we
    //    fetch at most one row per property regardless of fleet size.
    //
    //    Uses the exec_sql RPC (migration 0071 / hardened in 0072 to
    //    SELECT/WITH only) because PostgREST's aggregate-via-select
    //    syntax has quirks across supabase-js versions. exec_sql is a
    //    stable contract.
    //
    //    Note: the column is plan_snapshots.pulled_at (not fetched_at —
    //    an earlier draft had the wrong name; csv-scraper.js writes
    //    `pulled_at` via supabase-helpers).
    const lastSeenSql = `
      select property_id::text as property_id,
             max(pulled_at)::text as last_seen
      from plan_snapshots
      where pulled_at > now() - interval '24 hours'
      group by property_id
    `;
    const { data: lastSeenRows, error: snapsErr } =
      await supabaseAdmin.rpc('exec_sql', { sql: lastSeenSql });
    if (snapsErr) {
      log.error('scraper-instances: last-seen aggregation failed', {
        requestId, err: snapsErr as unknown as Error,
      });
      return err('failed to aggregate plan_snapshots', { requestId, status: 500 });
    }
    const latestByPid = new Map<string, string>();
    for (const r of (lastSeenRows ?? []) as Array<{ property_id: string; last_seen: string }>) {
      latestByPid.set(r.property_id, r.last_seen);
    }

    const now = Date.now();
    const healthyCutoff = now - HEALTHY_WINDOW_MIN * 60 * 1000;

    // 4. Group by scraper_instance.
    const byInstance = new Map<string, InstanceSummary>();
    for (const c of (creds ?? [])) {
      const inst = (c.scraper_instance as string) ?? 'default';
      const pid = c.property_id as string;
      const lastIso = latestByPid.get(pid) ?? null;
      const lastMs = lastIso ? new Date(lastIso).getTime() : null;
      const minutes_since_pull =
        lastMs !== null ? Math.round((now - lastMs) / 60_000) : null;
      const ps: PropertySummary = {
        property_id: pid,
        property_name: nameByPid.get(pid) ?? null,
        is_active: Boolean(c.is_active),
        pms_type: (c.pms_type as string) ?? 'unknown',
        last_pull_at: lastIso,
        minutes_since_pull,
      };

      if (!byInstance.has(inst)) {
        byInstance.set(inst, {
          scraper_instance: inst,
          property_count: 0,
          active_property_count: 0,
          last_seen_at: null,
          healthy: false,
          properties: [],
        });
      }
      const slot = byInstance.get(inst)!;
      slot.properties.push(ps);
      slot.property_count += 1;
      if (ps.is_active) slot.active_property_count += 1;
      if (lastIso) {
        if (!slot.last_seen_at || lastIso > slot.last_seen_at) {
          slot.last_seen_at = lastIso;
        }
        if (lastMs !== null && lastMs >= healthyCutoff) slot.healthy = true;
      }
    }

    const instances = Array.from(byInstance.values()).sort((a, b) =>
      a.scraper_instance.localeCompare(b.scraper_instance),
    );

    // 5. Properties without ANY scraper_credentials row — possibly mid-
    //    onboarding, possibly a misconfiguration. Worth surfacing.
    const assigned = new Set((creds ?? []).map((c) => c.property_id as string));
    const unassigned_properties = (properties ?? [])
      .filter((p) => !assigned.has(p.id as string))
      .map((p) => ({
        property_id: p.id as string,
        property_name: (p.name as string | null) ?? null,
      }));

    const summary = {
      instance_count: instances.length,
      property_count_total: (creds ?? []).length,
      active_property_count: instances.reduce(
        (n, i) => n + i.active_property_count,
        0,
      ),
      healthy_instance_count: instances.filter((i) => i.healthy).length,
      unassigned_property_count: unassigned_properties.length,
      healthy_window_min: HEALTHY_WINDOW_MIN,
    };

    return ok(
      {
        instances,
        unassigned_properties,
        summary,
      },
      { requestId },
    );
  } catch (e) {
    log.error('scraper-instances: handler crashed', { requestId, err: e as Error });
    return err(errToString(e), { requestId, status: 500 });
  }
}
