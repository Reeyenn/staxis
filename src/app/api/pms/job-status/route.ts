/**
 * GET /api/pms/job-status?id=<propertyId>
 *
 * Polled by the /settings/pms UI and /onboard wizard while the CUA is
 * coming up. Returns the live state of the CUA session for this hotel,
 * projected to the legacy "onboarding job" shape so the existing UI
 * (status / step / progressPct / error) doesn't need to change.
 *
 * Plan v4 rewire (2026-05-24): in v4 there is exactly one CUA session
 * per hotel (`public.property_sessions`). `jobId` is the property's id.
 * The old `onboarding_jobs` consumer (cua-service/src/job-runner.ts)
 * was deleted in the v4 cutover; this route now reads property_sessions
 * directly and maps the status. See migration 0206.
 *
 * Status mapping (property_sessions.status → legacy job shape):
 *   - starting                  → running,  step="Logging into PMS…",       progress=30
 *   - alive                     → complete, step="Connected — polling.",     progress=100
 *   - paused_mfa                → mapping,  step="Waiting for MFA…",         progress=70
 *   - paused_no_knowledge_file  → mapping,  step="Awaiting mapper…",         progress=50
 *   - paused_cost_cap           → running,  step="Cost cap — auto-resumes",  progress=90
 *   - paused_circuit_breaker    → failed,   step="Repeated read failures"
 *   - failed_restart            → failed,   step="Login failing — edit creds"
 *   - stopped                   → cancelled, step="Stopped by admin"
 *
 * Auth: caller must own the property.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { callerManagesHotel } from '@/lib/team-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { mapPropertySessionStatusToJobShape } from '@/lib/cua-session-job-mapping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface SessionRow {
  property_id: string;
  pms_family: string;
  status: string;
  paused_reason: string | null;
  last_alive_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const idV = validateUuid(url.searchParams.get('id'), 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // In v4 jobId == propertyId. Capability check first — never leak the
  // existence of another hotel's session via 404 vs 403 ambiguity, so a
  // non-manager (or a manager of a different hotel) always gets a flat 403.
  // 0273 enables GM self-onboarding: management-with-access, not owner-only,
  // but still never staff. Fails closed.
  if (!(await callerManagesHotel(session.userId, idV.value!))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data: rowRaw } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id, pms_family, status, paused_reason, last_alive_at, created_at, updated_at')
    .eq('property_id', idV.value!)
    .maybeSingle();

  if (!rowRaw) {
    return err('Job not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const row = rowRaw as SessionRow;
  const mapped = mapPropertySessionStatusToJobShape(row.status);

  return ok({
    id: row.property_id,
    propertyId: row.property_id,
    pmsType: row.pms_family,
    status: mapped.status,
    step: mapped.step,
    progressPct: mapped.progressPct,
    result: null,
    // Redact vendor-leaking details from the user-facing error field.
    // Internal paused_reason can contain selectors / URLs from the
    // worker; strip aggressively before exposing to the owner.
    error: redactVendorDetail(row.paused_reason),
    recipeId: null,
    startedAt: row.created_at,
    completedAt: row.status === 'alive' ? row.last_alive_at : null,
    createdAt: row.created_at,
  }, { requestId });
}

/**
 * Strip vendor-leaking shapes from a paused_reason string. Keeps the
 * high-level reason (so the user still sees "Login failed") but drops:
 *   - URLs (vendor login pages, internal redirect chains)
 *   - CSS / XPath selectors (Playwright artifacts)
 *   - JS error stacks
 *   - File paths from the worker
 *
 * Conservative — if the input is unrecognisable, returns a generic
 * "the sync didn't complete" rather than echoing raw worker output.
 */
function redactVendorDetail(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err !== 'string') return 'The sync did not complete. Please try again or contact support.';
  const cleaned = err
    .replace(/https?:\/\/[^\s"')\]]+/gi, '[url]')
    .replace(/[#.][\w-]+(\[[^\]]+\])+/g, '[selector]')
    .replace(/\/\/?\w+(\[[^\]]+\])?(\/\w+(\[[^\]]+\])?)*/g, '[xpath]')
    .replace(/\s+at\s+[^\n]+/g, '')
    .replace(/\/[\w/.-]*cua-service[\w/.-]*/g, '[worker]');
  if (cleaned.trim().length < 8) {
    return 'The sync did not complete. Please try again or contact support.';
  }
  return cleaned.slice(0, 300);
}
