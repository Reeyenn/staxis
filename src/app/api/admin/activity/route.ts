/**
 * GET /api/admin/activity
 *
 * Aggregated per-hotel activity for the engagement panel on the Live
 * hotels tab. Filters out admin-role events so Reeyen's clicks don't
 * pollute the customer-facing view.
 *
 * Returns one row per property that had any non-admin activity in the
 * window:
 *   - lastActiveTs        — timestamp of newest event
 *   - viewsToday          — page_view count last 24h
 *   - viewsWeek           — page_view count last 7d
 *   - distinctUsersToday  — unique user_id count last 24h
 *   - topFeatures         — top 5 (path, count) from page_view metadata
 *
 * Properties with zero non-admin activity in the window are omitted.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

interface ActivityRow {
  propertyId: string;
  propertyName: string | null;
  lastActiveTs: string;
  viewsToday: number;
  viewsWeek: number;
  distinctUsersToday: number;
  topFeatures: { path: string; count: number }[];
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const weekAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch the last 7 days of non-admin events. Bucketed in JS.
  const { data, error } = await supabaseAdmin
    .from('app_events')
    .select('property_id, user_id, event_type, metadata, ts, user_role')
    .gte('ts', weekAgoIso)
    .neq('user_role', 'admin')
    .not('property_id', 'is', null)
    .order('ts', { ascending: false })
    .limit(20000);

  if (error) {
    return err(`activity query failed: ${error.message}`, { requestId, status: 500 });
  }

  type Bucket = {
    lastActiveTs: string;
    viewsToday: number;
    viewsWeek: number;
    distinctUsersToday: Set<string>;
    pathCountsToday: Map<string, number>;
  };

  const byProperty = new Map<string, Bucket>();

  for (const row of (data ?? [])) {
    const r = row as { property_id: string; user_id: string | null; event_type: string; metadata: Record<string, unknown> | null; ts: string };
    const isToday = r.ts >= dayAgoIso;

    let b = byProperty.get(r.property_id);
    if (!b) {
      b = {
        lastActiveTs: r.ts,
        viewsToday: 0,
        viewsWeek: 0,
        distinctUsersToday: new Set<string>(),
        pathCountsToday: new Map<string, number>(),
      };
      byProperty.set(r.property_id, b);
    }
    if (r.ts > b.lastActiveTs) b.lastActiveTs = r.ts;

    if (r.event_type === 'page_view') {
      b.viewsWeek += 1;
      if (isToday) {
        b.viewsToday += 1;
        if (r.user_id) b.distinctUsersToday.add(r.user_id);
        const path = (r.metadata?.path as string | undefined) ?? '(unknown)';
        b.pathCountsToday.set(path, (b.pathCountsToday.get(path) ?? 0) + 1);
      }
    }
  }

  // Resolve property names
  const propertyIds = Array.from(byProperty.keys());
  let nameById = new Map<string, string | null>();
  if (propertyIds.length > 0) {
    const { data: nameRows, error: nameErr } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propertyIds);
    if (nameErr) {
      return err(`activity name lookup failed: ${nameErr.message}`, { requestId, status: 500 });
    }
    nameById = new Map((nameRows ?? []).map((r) => [(r as { id: string; name: string | null }).id, (r as { id: string; name: string | null }).name]));
  }

  const rows: ActivityRow[] = Array.from(byProperty.entries()).map(([propertyId, b]) => ({
    propertyId,
    propertyName: nameById.get(propertyId) ?? null,
    lastActiveTs: b.lastActiveTs,
    viewsToday: b.viewsToday,
    viewsWeek: b.viewsWeek,
    distinctUsersToday: b.distinctUsersToday.size,
    topFeatures: Array.from(b.pathCountsToday.entries())
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  }));

  // Most recent activity first.
  rows.sort((a, b) => Date.parse(b.lastActiveTs) - Date.parse(a.lastActiveTs));

  return ok({ rows }, { requestId });
}
