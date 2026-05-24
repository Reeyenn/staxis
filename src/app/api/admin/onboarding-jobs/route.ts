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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface JobRow {
  id: string;
  propertyId: string;
  propertyName: string | null;
  pmsType: string;
  status: 'queued' | 'running' | 'mapping' | 'extracting' | 'complete' | 'failed' | 'cancelled';
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

const RUNNING_STATES = new Set<JobRow['status']>(['queued', 'running', 'mapping', 'extracting']);

interface MappedShape {
  status: JobRow['status'];
  step: string;
  progressPct: number | null;
}

function mapSessionToJobShape(s: SessionRow): MappedShape {
  switch (s.status) {
    case 'starting':
      return { status: 'running', step: 'Logging into PMS…', progressPct: 30 };
    case 'alive':
      return { status: 'complete', step: 'Connected — polling every ~30s.', progressPct: 100 };
    case 'paused_mfa':
      return { status: 'mapping', step: 'Waiting for MFA — click to resolve.', progressPct: 70 };
    case 'paused_no_knowledge_file':
      return { status: 'mapping', step: 'Awaiting mapper — PMS not learned yet.', progressPct: 50 };
    case 'paused_cost_cap':
      return { status: 'running', step: 'Cost cap tripped — auto-resumes at midnight.', progressPct: 90 };
    case 'paused_circuit_breaker':
      return { status: 'failed', step: 'Repeated read failures — paused for triage.', progressPct: null };
    case 'failed_restart':
      return { status: 'failed', step: 'Login failing — edit credentials and retry.', progressPct: null };
    case 'stopped':
      return { status: 'cancelled', step: 'Stopped by admin.', progressPct: null };
    default:
      // Future-proof: unknown status → surface as 'running' with the
      // raw status as the step so admin can see something's off.
      return { status: 'running', step: `Status: ${s.status}`, progressPct: null };
  }
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

  // Look up property names for display in one round-trip.
  const propIds = Array.from(new Set(sessions.map((s) => s.property_id))).filter(Boolean);
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
    const mapped = mapSessionToJobShape(s);
    const startedMs = Date.parse(s.created_at);
    const completedMs = s.status === 'alive' && s.last_alive_at
      ? Date.parse(s.last_alive_at)
      : null;
    const durationMs = completedMs
      ? completedMs - startedMs
      : (RUNNING_STATES.has(mapped.status) ? now - startedMs : null);

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

  // Apply filters.
  let rows = allRows;
  if (filter === 'failed') rows = allRows.filter((r) => r.status === 'failed');
  if (filter === 'complete') rows = allRows.filter((r) => r.status === 'complete');
  if (liveOnly) rows = allRows.filter((r) => RUNNING_STATES.has(r.status));

  // Summary computed over the full set so the UI header is accurate.
  const summary = {
    total: allRows.length,
    running: allRows.filter((r) => RUNNING_STATES.has(r.status)).length,
    failed: allRows.filter((r) => r.status === 'failed').length,
    complete: allRows.filter((r) => r.status === 'complete').length,
  };

  return ok({ jobs: rows, summary }, { requestId });
}
