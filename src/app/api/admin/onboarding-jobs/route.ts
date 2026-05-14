/**
 * GET /api/admin/onboarding-jobs
 *
 * Returns recent onboarding_jobs rows (most-recent first) joined with
 * the property name and current pms_type. Powers the Onboarding tab on
 * /admin/properties — Reeyen's "where do hotels get stuck" view.
 *
 * Per-row fields:
 *   - jobId, propertyId, propertyName
 *   - pmsType, status (queued/running/mapping/extracting/complete/failed)
 *   - step (current human-readable step) + progressPct
 *   - error (set on failed)
 *   - timing: createdAt, startedAt, completedAt
 *   - durationMs (computed: completedAt - startedAt, or now - startedAt
 *                 if still running)
 *
 * Default: last 50 jobs. ?status=failed to filter for failures only.
 * ?live=1 to show only currently-running jobs (for monitoring an active
 * onboarding).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface JobRow {
  id: string;
  propertyId: string;
  propertyName: string | null;
  pmsType: string;
  status: string;
  step: string | null;
  progressPct: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  forceRemap: boolean;
}

const RUNNING_STATES = new Set(['queued', 'running', 'mapping', 'extracting']);

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const filter = url.searchParams.get('status');
  const liveOnly = url.searchParams.get('live') === '1';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

  let query = supabaseAdmin
    .from('onboarding_jobs')
    .select(`
      id, property_id, pms_type, status, step, progress_pct, error,
      created_at, started_at, completed_at, force_remap
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filter === 'failed') query = query.eq('status', 'failed');
  if (filter === 'complete') query = query.eq('status', 'complete');
  if (liveOnly) query = query.in('status', Array.from(RUNNING_STATES));

  const { data: jobs, error: jobsErr } = await query;
  if (jobsErr) {
    return err(`Could not load jobs: ${jobsErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Look up property names for display in one round-trip.
  const propIds = Array.from(new Set((jobs ?? []).map((j) => j.property_id))).filter(Boolean);
  const nameByPid = new Map<string, string>();
  if (propIds.length > 0) {
    const { data: props } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propIds);
    for (const p of props ?? []) nameByPid.set(p.id, p.name ?? '(unnamed)');
  }

  const now = Date.now();
  const rows: JobRow[] = (jobs ?? []).map((j) => {
    const startedMs = j.started_at ? new Date(j.started_at).getTime() : null;
    const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : null;
    let durationMs: number | null = null;
    if (startedMs && completedMs) durationMs = completedMs - startedMs;
    else if (startedMs && RUNNING_STATES.has(j.status)) durationMs = now - startedMs;

    return {
      id: j.id,
      propertyId: j.property_id,
      propertyName: nameByPid.get(j.property_id) ?? null,
      pmsType: j.pms_type,
      status: j.status,
      step: j.step,
      progressPct: j.progress_pct,
      error: j.error,
      createdAt: j.created_at,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      durationMs,
      forceRemap: j.force_remap ?? false,
    };
  });

  // Summary counts (compute over the un-filtered last N for context).
  const summary = {
    total: rows.length,
    running: rows.filter((r) => RUNNING_STATES.has(r.status)).length,
    failed: rows.filter((r) => r.status === 'failed').length,
    complete: rows.filter((r) => r.status === 'complete').length,
  };

  return ok({ jobs: rows, summary }, { requestId });
}
