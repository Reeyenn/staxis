/**
 * POST /api/admin/mapper/takeover
 *   body: { jobId, intent: 'start' | 'skip', targetKey?, note? }
 *
 * feature/cua-live-assist. Founder-initiated interrupt for the PMS-learning
 * robot, written into mapper_takeover_sessions (service-role only; the worker
 * polls it at the top of each mapActionCore step):
 *   - 'start' → open a 'requested' takeover; the robot PAUSES its AI loop and
 *     drives by the founder's clicks (Finish/Cancel via /takeover-command).
 *   - 'skip'  → open a 'requested' row with command='skip'; the robot abandons
 *     the (targetKey) feed and moves on, no takeover. targetKey scopes the skip
 *     so a mis-timed press can't eat the next feed.
 *
 * One open takeover per job (partial unique index). On a double-click race the
 * INSERT hits 23505 — we converge on the existing open row (mirrors
 * human-assist.ts), so the second click reports the same session, not a 500.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role) — the table is deny-all-browser.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateTakeoverStart } from '@/lib/pms/takeover-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_COLS = 'id, status, target_key, command, command_seq';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' }); }
  const v = validateTakeoverStart(body);
  if (!v.ok) return err(v.reason, { requestId, status: 400, code: 'bad_request' });

  // The job must exist and still be live — a finished run has no robot to drive.
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, kind, status')
    .eq('id', v.jobId)
    .maybeSingle();
  if (jobErr) return err(`job lookup failed: ${jobErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!job) return err('job not found', { requestId, status: 404, code: 'not_found' });
  if (job.status !== 'queued' && job.status !== 'running') {
    return ok({ accepted: false, reason: 'run_finished' }, { requestId });
  }

  const insert: Record<string, unknown> = {
    job_id: v.jobId,
    status: 'requested',
    target_key: v.targetKey,
    admin_user_id: admin.accountId,
  };
  if (v.intent === 'skip') {
    insert.command = 'skip';
    insert.command_seq = 1;
    insert.command_note = v.note;
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('mapper_takeover_sessions')
    .insert(insert)
    .select(SESSION_COLS)
    .single();

  if (insErr) {
    // 23505 = one-open-per-job partial unique index: another click already
    // opened a takeover. Converge on it rather than 500 (mirrors human-assist).
    if ((insErr as { code?: string }).code === '23505') {
      const { data: existing } = await supabaseAdmin
        .from('mapper_takeover_sessions')
        .select(SESSION_COLS)
        .eq('job_id', v.jobId)
        .in('status', ['requested', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        return ok({ accepted: true, sessionId: existing.id, converged: true }, { requestId });
      }
    }
    return err(`could not open takeover: ${insErr.message}`, { requestId, status: 500, code: 'db_error' });
  }

  return ok({ accepted: true, sessionId: inserted.id }, { requestId });
}
