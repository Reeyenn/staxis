/**
 * GET /api/admin/mapper/live/[jobId]
 *
 * Plan v8 Phase B chunk 2. Initial-paint state for the Live Mapping
 * console. After fetching this, the front-end subscribes to two
 * Supabase realtime channels for ongoing updates:
 *   - postgres_changes on mapping_help_requests filtered by job_id
 *   - the broadcast channel `mapping:{jobId}` for action/screenshot events
 *
 * Response:
 *   {
 *     job: { id, kind, status, attempts, max_attempts, payload, created_at,
 *            started_at, completed_at, error, result, claude_cost_micros },
 *     property: { display_name, pms_family } | null,
 *     pendingHelpRequest: <mapping_help_requests row | null, plus
 *       screenshotUrl: a 1h signed URL for the privacy-redacted screenshot
 *       (the bucket is private; the browser can't read it directly)>,
 *     recentHelpRequests: <last 5 mapping_help_requests rows>,
 *   }
 *
 * Auth: requireAdmin.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  // Codebase-standard admin gate — return requireAdmin's response verbatim
  // (correct 403 for a non-admin session) instead of re-minting a flat 401.
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return err('jobId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  const [jobRes, pendingRes, recentRes, takeoverRes] = await Promise.all([
    supabaseAdmin
      .from('workflow_jobs')
      .select('id, property_id, kind, status, attempts, max_attempts, payload, created_at, started_at, completed_at, error, result, claude_cost_micros')
      .eq('id', jobId)
      .maybeSingle(),
    supabaseAdmin
      .from('mapping_help_requests')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'pending')
      .maybeSingle(),
    supabaseAdmin
      .from('mapping_help_requests')
      .select('id, target_key, question, status, action_type, response_text, answered_at, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(5),
    // feature/cua-live-assist — the open founder-takeover session (if any).
    supabaseAdmin
      .from('mapper_takeover_sessions')
      .select('id, status, target_key, frame_seq, viewport_w, viewport_h, command_seq, applied_command_seq, started_at')
      .eq('job_id', jobId)
      .in('status', ['requested', 'active'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (jobRes.error) {
    return err(`workflow_jobs lookup failed: ${jobRes.error.message}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  if (!jobRes.data) {
    return err('job not found', { requestId, status: 404, code: 'not_found' });
  }

  // feature/cua-polish — opportunistic cleanup of the per-job watcher object
  // (written by POST below). Once the job is terminal there's no help to hold,
  // so drop it; the expire-help-requests cron only sweeps live.png + tracked
  // screenshots, not this. Fire-and-forget — never blocks or fails the read.
  if (['completed', 'failed', 'cancelled'].includes(jobRes.data.status as string)) {
    void supabaseAdmin.storage
      .from('mapping-screenshots')
      .remove([`${jobId}/watcher.json`])
      .then(() => {}, () => {});
  }

  // Hotel name for the board header ("Learning {Hotel}'s PMS"). pms_family
  // comes from the job payload (the job is per-family; property_id is the
  // representative hotel). Best-effort — a lookup failure must not break
  // the board.
  const payload = (jobRes.data.payload ?? {}) as Record<string, unknown>;
  let property: { display_name: string; pms_family: string | null } | null = null;
  if (jobRes.data.property_id) {
    const { data: prop } = await supabaseAdmin
      .from('properties')
      .select('display_name')
      .eq('id', jobRes.data.property_id)
      .maybeSingle();
    property = {
      display_name: (prop?.display_name as string | undefined) ?? jobRes.data.property_id,
      pms_family: typeof payload.pms_family === 'string' ? payload.pms_family : null,
    };
  }

  // Signed URL for the pending help screenshot (1h ≫ the row's 15-min TTL).
  // The mapping-screenshots bucket is private with admin-only RLS — the
  // browser cannot fetch the object key directly.
  let pendingHelpRequest: Record<string, unknown> | null = pendingRes.data ?? null;
  if (pendingHelpRequest && typeof pendingHelpRequest.screenshot_storage_path === 'string') {
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from('mapping-screenshots')
      .createSignedUrl(pendingHelpRequest.screenshot_storage_path, 3600);
    if (signErr) {
      // Non-fatal: the panel degrades to text-only guidance.
      pendingHelpRequest = { ...pendingHelpRequest, screenshotUrl: null };
    } else {
      pendingHelpRequest = { ...pendingHelpRequest, screenshotUrl: signed?.signedUrl ?? null };
    }
  }

  // feature/cua-live-assist — takeover session + a signed URL for the
  // click-target frame (its OWN object {jobId}/takeover.png, published awaited
  // by the worker — NOT the heartbeat-gated ambient live.png). Only mint once
  // a frame exists (frame_seq > 0); the board preloads so a transient miss
  // keeps the prior frame.
  let takeover: Record<string, unknown> | null = takeoverRes.data ?? null;
  if (takeover && typeof takeover.frame_seq === 'number' && takeover.frame_seq > 0) {
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from('mapping-screenshots')
      .createSignedUrl(`${jobId}/takeover.png`, 3600);
    takeover = { ...takeover, frameUrl: signErr ? null : (signed?.signedUrl ?? null) };
  } else if (takeover) {
    takeover = { ...takeover, frameUrl: null };
  }

  // feature/cua-live-assist — draft map summary for Save & Finish / Discard.
  // Prefer the id the run wrote into result; fall back to the newest draft for
  // the family. Selectors are NEVER returned — only a coverage summary.
  const result = (jobRes.data.result ?? {}) as Record<string, unknown>;
  const knowledgeFileId = typeof result.knowledge_file_id === 'string' ? result.knowledge_file_id : null;
  let draftMap: {
    id: string; version: number; status: string; pmsFamily: string;
    actionsFound: number; missingRequired: string[]; missingBusinessCritical: string[];
  } | null = null;
  // STRICT: only the draft THIS run produced (knowledge_file_id). No newest-by-
  // family fallback — Save/Discard resolve the same way (job-draft.ts), so the
  // board summary and the action can never refer to a different run's map.
  if (knowledgeFileId) {
    type KFRow = { id: string; version: number; status: string; pms_family: string; knowledge: unknown };
    const { data } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, version, status, pms_family, knowledge')
      .eq('id', knowledgeFileId)
      .maybeSingle();
    const row = (data as KFRow | null) ?? null;
    if (row) {
      const knowledge = (row.knowledge ?? {}) as { actions?: Record<string, unknown>; feedGaps?: { missingRequired?: Array<{ target?: unknown }>; missingBusinessCritical?: unknown[] } };
      const gaps = knowledge.feedGaps;
      draftMap = {
        id: row.id,
        version: row.version,
        status: row.status,
        pmsFamily: row.pms_family,
        actionsFound: Object.keys(knowledge.actions ?? {}).length,
        missingRequired: Array.isArray(gaps?.missingRequired)
          ? gaps!.missingRequired.map((e) => (typeof e?.target === 'string' ? e.target : '')).filter(Boolean)
          : [],
        missingBusinessCritical: Array.isArray(gaps?.missingBusinessCritical)
          ? (gaps!.missingBusinessCritical as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
      };
    }
  }

  // feature/cua-polish — surface the awaiting-2FA signal the worker writes to
  // workflow_jobs.result (cua-service/src/mapper.ts setAwaitingMfa). Same shape
  // the Launch Bay reads via /api/admin/onboarding-detail, so the live watch
  // page can render the SAME 2FA code box (→ existing POST /api/admin/pms-auth-
  // code) without forking the 2FA mechanism. Cleared automatically once the
  // worker resumes (it nulls awaiting_2fa).
  const awaiting2fa = Boolean((result as { awaiting_2fa?: unknown }).awaiting_2fa);
  const awaiting2faSince =
    (result as { awaiting_2fa?: { since?: string } }).awaiting_2fa?.since ?? null;

  return ok({
    job: jobRes.data,
    property,
    pendingHelpRequest,
    recentHelpRequests: recentRes.data ?? [],
    takeover,
    draftMap,
    awaiting2fa,
    awaiting2faSince,
  }, { requestId });
}

/**
 * POST /api/admin/mapper/live/[jobId] — per-job watcher heartbeat (feature/
 * cua-polish).
 *
 * The Learning Board pings this every 30s while its tab is open AND visible,
 * scoped to THIS job. cua-service/src/human-assist.ts reads the freshness of
 * the object written here to decide — PER JOB, not globally — whether to HOLD
 * a help request for a watching admin (point-and-click takeover) vs fast-path
 * to "nobody's home". Replaces the old global accounts.last_seen_at gate for
 * help-requests: an admin parked on another job (or any admin page) must no
 * longer make THIS stuck job wait.
 *
 * Stored as ONE tiny object per job (`{jobId}/watcher.json`, overwritten in
 * place — upsert), in the private, service-role-only mapping-screenshots
 * bucket. No schema change, no new table, and it never touches
 * workflow_jobs.result — so it can't race the worker's result writes. The GET
 * handler removes it once the job is terminal (the expire cron doesn't), so it
 * doesn't accumulate.
 *
 * Auth: requireAdmin (same gate as GET).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return err('jobId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  // Scope the write to a live job (Codex review [3], defense-in-depth): don't
  // let a stray/terminal/non-existent jobId accumulate a watcher object, and
  // don't keep a help-hold alive for a job that isn't running. Cheap PK lookup.
  const { data: jobRow } = await supabaseAdmin
    .from('workflow_jobs')
    .select('status')
    .eq('id', jobId)
    .maybeSingle();
  if (!jobRow) {
    return err('job not found', { requestId, status: 404, code: 'not_found' });
  }
  if (['completed', 'failed', 'cancelled'].includes(jobRow.status as string)) {
    // Terminal — nothing to hold help for. Best-effort cleanup, no write.
    void supabaseAdmin.storage
      .from('mapping-screenshots')
      .remove([`${jobId}/watcher.json`])
      .then(() => {}, () => {});
    return ok({ watching: false, reason: 'job_not_running' }, { requestId });
  }

  // The `at` timestamp lives INSIDE the body (the worker parses it) rather than
  // relying on storage object metadata, which doesn't reliably refresh on an
  // in-place overwrite. cacheControl '0' so a re-read never sees a stale frame.
  const at = new Date().toISOString();
  const payload = Buffer.from(JSON.stringify({ at, by: admin.accountId }));
  const { error: upErr } = await supabaseAdmin.storage
    .from('mapping-screenshots')
    .upload(`${jobId}/watcher.json`, payload, {
      contentType: 'application/json',
      cacheControl: '0',
      upsert: true,
    });
  if (upErr) {
    return err(`watcher heartbeat failed: ${upErr.message}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  return ok({ watching: true, at }, { requestId });
}
