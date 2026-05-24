/**
 * GET /api/admin/onboarding-jobs
 *
 * Returns the in-flight CUA session state for every hotel, projected to
 * the legacy "onboarding job" shape so the OnboardingTab UI doesn't
 * need to be rewritten.
 *
 * Source of truth: `public.property_sessions` (one row per hotel). The
 * legacy `onboarding_jobs` table is an empty stub since Plan v4 cutover
 * (consumer cua-service/src/job-runner.ts was deleted) — this route used
 * to read it and always returned `[]`, breaking the funnel UI.
 *
 * Status mapping (property_sessions.status → legacy job shape):
 *   - starting                  → running,  step="Logging into PMS…",      progress=30
 *   - alive                     → complete, step="Connected — polling…",   progress=100
 *   - paused_mfa                → mapping,  step="Waiting for MFA…",       progress=70
 *   - paused_no_knowledge_file  → mapping,  step="Awaiting mapper…",       progress=50
 *   - paused_cost_cap           → running,  step="Cost cap — auto-resumes",progress=90
 *   - paused_circuit_breaker    → failed,   step="Repeated read failures"
 *   - failed_restart            → failed,   step="Login failing — edit creds"
 *   - stopped                   → cancelled, step="Stopped by admin"
 *
 * ?live=1 returns anything that's not 'alive' or 'stopped' (anything
 * the admin should be watching).
 * ?status=failed returns failed/paused-cb/failed_restart.
 * ?status=complete returns alive sessions.
 *
 * Per-row fields (kept compatible with OnboardingTab.tsx contract):
 *   - jobId (= property_id, since one session per hotel)
 *   - propertyId, propertyName, pmsType
 *   - status, step, progressPct, error
 *   - createdAt, startedAt, completedAt, durationMs, forceRemap (always false)
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  IN_FLIGHT_LEGACY_STATUSES,
  mapPropertySessionStatusToJobShape,
  type LegacyJobStatus,
} from '@/lib/cua-session-job-mapping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface JobRow {
  id: string;
  propertyId: string;
  propertyName: string | null;
  pmsType: string;
  status: LegacyJobStatus;
  step: string | null;
  progressPct: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  forceRemap: boolean;
  /** Optional CTA target — UI can link to /admin/mfa-resume/[hotelId] for paused_mfa. */
  resumeUrl: string | null;
}

interface SessionRow {
  property_id: string;
  pms_family: string;
  status: string;
  paused_reason: string | null;
  paused_until: string | null;
  last_alive_at: string | null;
  last_successful_read_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const filter = url.searchParams.get('status');
  const liveOnly = url.searchParams.get('live') === '1';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

  // Pull all sessions; we filter in memory after status mapping. Volume
  // is tiny (one row per hotel, capped at a few hundred for the
  // foreseeable future).
  const { data: rawSessions, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select(`
      property_id, pms_family, status, paused_reason, paused_until,
      last_alive_at, last_successful_read_at, created_at, updated_at
    `)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (sessErr) {
    return err(`Could not load sessions: ${sessErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const sessions = (rawSessions ?? []) as SessionRow[];

  // Plan v7 Phase 2c — also surface in-flight mapper.learn_pms_family
  // workflow jobs. These don't show up in property_sessions (mapper
  // runs in mapping-driver, not session-driver), but admins need to
  // see them in the Onboarding tab's live-status column so they know
  // mapping is progressing on a brand-new PMS family.
  const { data: mapperJobsRaw } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, property_id, kind, status, payload, attempts, started_at, last_attempt_at, completed_at, error, result, created_at')
    .like('kind', 'mapper.%')
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(20);

  // Look up property names for display in one round-trip (cover both
  // sessions + mapper jobs).
  const sessionPropIds = sessions.map((s) => s.property_id);
  const mapperPropIds = (mapperJobsRaw ?? []).map((j) => j.property_id as string);
  const propIds = Array.from(new Set([...sessionPropIds, ...mapperPropIds])).filter(Boolean);
  const nameByPid = new Map<string, string>();
  if (propIds.length > 0) {
    const { data: props } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propIds);
    for (const p of props ?? []) nameByPid.set(p.id, (p.name as string | null) ?? '(unnamed)');
  }

  const now = Date.now();
  const allRows: JobRow[] = sessions.map((s) => {
    const mapped = mapPropertySessionStatusToJobShape(s.status);
    const startedMs = Date.parse(s.created_at);
    const completedMs = s.status === 'alive' && s.last_alive_at
      ? Date.parse(s.last_alive_at)
      : null;
    const durationMs = completedMs
      ? completedMs - startedMs
      : (IN_FLIGHT_LEGACY_STATUSES.has(mapped.status) ? now - startedMs : null);

    return {
      // Use property_id as the jobId: one session per hotel in v4 (the
      // old onboarding_jobs had multiple rows per property — that's a
      // collapse the v4 model intentionally makes).
      id: s.property_id,
      propertyId: s.property_id,
      propertyName: nameByPid.get(s.property_id) ?? null,
      pmsType: s.pms_family,
      status: mapped.status,
      step: mapped.step,
      progressPct: mapped.progressPct,
      error: s.paused_reason,
      createdAt: s.created_at,
      startedAt: s.created_at,
      completedAt: completedMs ? new Date(completedMs).toISOString() : null,
      durationMs,
      forceRemap: false,
      resumeUrl: s.status === 'paused_mfa' ? `/admin/mfa-resume/${s.property_id}` : null,
    };
  });

  // Plan v7 Phase 2c — append mapper.* workflow jobs as additional
  // rows (visible alongside the session-derived ones).
  for (const mj of mapperJobsRaw ?? []) {
    const payload = (mj.payload as Record<string, unknown> | null) ?? {};
    const startedMs = mj.started_at ? Date.parse(mj.started_at as string) : null;
    const dur = startedMs ? now - startedMs : null;
    allRows.push({
      id: mj.id as string,
      propertyId: mj.property_id as string,
      propertyName: nameByPid.get(mj.property_id as string) ?? null,
      pmsType: (payload.pms_family as string) ?? 'unknown',
      status: mj.status === 'running' ? 'mapping' : 'queued',
      step: mj.status === 'running'
        ? `Mapper learning ${payload.pms_family ?? 'PMS'} (attempt ${mj.attempts ?? 1})`
        : `Mapper queued for ${payload.pms_family ?? 'PMS'}`,
      progressPct: mj.status === 'running' ? 50 : 10,
      error: mj.error as string | null,
      createdAt: mj.created_at as string,
      startedAt: mj.started_at as string | null,
      completedAt: mj.completed_at as string | null,
      durationMs: dur,
      forceRemap: false,
      resumeUrl: null,
    });
  }

  // Apply filters.
  let rows = allRows;
  if (filter === 'failed') rows = allRows.filter((r) => r.status === 'failed');
  if (filter === 'complete') rows = allRows.filter((r) => r.status === 'complete');
  if (liveOnly) rows = allRows.filter((r) => IN_FLIGHT_LEGACY_STATUSES.has(r.status));

  // Summary computed over the full set so the UI header is accurate.
  const summary = {
    total: allRows.length,
    running: allRows.filter((r) => IN_FLIGHT_LEGACY_STATUSES.has(r.status)).length,
    failed: allRows.filter((r) => r.status === 'failed').length,
    complete: allRows.filter((r) => r.status === 'complete').length,
  };

  return ok({ jobs: rows, summary }, { requestId });
}
