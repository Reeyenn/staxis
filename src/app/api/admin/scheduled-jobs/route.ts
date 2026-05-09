/**
 * GET /api/admin/scheduled-jobs
 *
 * Per-property pull_jobs status. Surfaces stuck or never-run schedules
 * so a hotel that's silently failed sync doesn't disappear.
 *
 * Returns one row per property that has any pull_jobs history:
 *   - lastSuccessAt  — timestamp of newest status='complete'
 *   - lastFailedAt   — timestamp of newest status='failed'
 *   - stuckCount     — currently queued/running rows older than 30 min
 *   - latestStatus   — status of the most recent row
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

interface ScheduledRow {
  propertyId: string;
  propertyName: string | null;
  lastSuccessAt: string | null;
  lastFailedAt: string | null;
  stuckCount: number;
  latestStatus: string | null;
  latestError: string | null;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('pull_jobs')
    .select('id, property_id, status, error, created_at, completed_at, started_at')
    .order('created_at', { ascending: false })
    .limit(2000);

  if (error) return err(`scheduled-jobs query failed: ${error.message}`, { requestId, status: 500 });

  type Bucket = {
    lastSuccessAt: string | null;
    lastFailedAt: string | null;
    stuckCount: number;
    latestStatus: string | null;
    latestError: string | null;
    latestTs: string;
  };

  const byProperty = new Map<string, Bucket>();
  const now = Date.now();

  for (const row of (data ?? [])) {
    const r = row as { property_id: string; status: string; error: string | null; created_at: string; completed_at: string | null; started_at: string | null };
    let b = byProperty.get(r.property_id);
    if (!b) {
      b = { lastSuccessAt: null, lastFailedAt: null, stuckCount: 0, latestStatus: r.status, latestError: r.error, latestTs: r.created_at };
      byProperty.set(r.property_id, b);
    }
    if (r.status === 'complete' && r.completed_at && (!b.lastSuccessAt || r.completed_at > b.lastSuccessAt)) {
      b.lastSuccessAt = r.completed_at;
    }
    if (r.status === 'failed' && (!b.lastFailedAt || r.created_at > b.lastFailedAt)) {
      b.lastFailedAt = r.created_at;
    }
    if ((r.status === 'queued' || r.status === 'running') && (now - Date.parse(r.created_at)) > STUCK_THRESHOLD_MS) {
      b.stuckCount += 1;
    }
    if (r.created_at > b.latestTs) {
      b.latestTs = r.created_at;
      b.latestStatus = r.status;
      b.latestError = r.error;
    }
  }

  const propertyIds = Array.from(byProperty.keys());
  let nameById = new Map<string, string | null>();
  if (propertyIds.length > 0) {
    const { data: nameRows } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propertyIds);
    nameById = new Map((nameRows ?? []).map((r) => [(r as { id: string; name: string | null }).id, (r as { id: string; name: string | null }).name]));
  }

  const rows: ScheduledRow[] = Array.from(byProperty.entries()).map(([propertyId, b]) => ({
    propertyId,
    propertyName: nameById.get(propertyId) ?? null,
    lastSuccessAt: b.lastSuccessAt,
    lastFailedAt: b.lastFailedAt,
    stuckCount: b.stuckCount,
    latestStatus: b.latestStatus,
    latestError: b.latestError,
  }));

  // Sort: stuck first, then by oldest-success (most concerning first)
  rows.sort((a, b) => {
    if ((a.stuckCount > 0) !== (b.stuckCount > 0)) return a.stuckCount > 0 ? -1 : 1;
    if (a.lastSuccessAt && b.lastSuccessAt) return a.lastSuccessAt.localeCompare(b.lastSuccessAt);
    if (!a.lastSuccessAt) return -1;
    if (!b.lastSuccessAt) return 1;
    return 0;
  });

  return ok({ rows }, { requestId });
}
