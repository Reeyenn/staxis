/**
 * POST /api/admin/mapper/takeover-command
 *   body: { jobId, command: 'click' | 'finish' | 'cancel', coordinate?, note?, frameSeq? }
 *
 * feature/cua-live-assist. During an ACTIVE founder takeover, sends the next
 * command to the robot via mapper_takeover_sessions:
 *   - 'click'  → the founder's point-and-click nudge (coordinate + frameSeq).
 *   - 'finish' → "this page IS the feed" → robot captures + learns it.
 *   - 'cancel' → "couldn't find it" → robot marks the feed not-found, moves on.
 *
 * Turn-based / idempotent: the UPDATE is a compare-and-swap guarded on
 *   status='active' AND command_seq=<current> AND applied_command_seq=<current>
 * so a command is accepted ONLY when the robot has acked the previous one. A
 * double-click (two POSTs racing one frame) → one CAS wins, the other matches
 * 0 rows → accepted:false. The board also disables Send until the robot acks,
 * so this is a backstop.
 *
 * Click safety: the coordinate is bounds-checked against the session's capture
 * viewport here, and the robot independently re-validates the coordinate AND
 * requires frameSeq === the current frame_seq before it physically clicks.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateTakeoverCommand, validateTakeoverCoordinate } from '@/lib/pms/takeover-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' }); }
  const v = validateTakeoverCommand(body);
  if (!v.ok) return err(v.reason, { requestId, status: 400, code: 'bad_request' });

  // The robot must already be in an ACTIVE takeover (it sets status='active'
  // when it pauses). 'requested' (not yet picked up) or ended → not ready.
  const { data: session, error: readErr } = await supabaseAdmin
    .from('mapper_takeover_sessions')
    .select('id, status, viewport_w, viewport_h, command_seq, applied_command_seq')
    .eq('job_id', v.jobId)
    .in('status', ['requested', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readErr) return err(`takeover lookup failed: ${readErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!session || session.status !== 'active') {
    return ok({ accepted: false, reason: 'no_active_takeover' }, { requestId });
  }

  // Defend a hard-killed worker that left a dangling 'active' row (the graceful
  // path ends it via the controller's close()): never accept a command no robot
  // will ack. If the job is terminal, the takeover is dead.
  const { data: job } = await supabaseAdmin
    .from('workflow_jobs')
    .select('status')
    .eq('id', v.jobId)
    .maybeSingle();
  if (!job || (job.status !== 'queued' && job.status !== 'running')) {
    return ok({ accepted: false, reason: 'run_finished' }, { requestId });
  }

  // Bounds-check a click against the capture viewport (robot re-validates too).
  let coordinate: { x: number; y: number } | null = null;
  if (v.command === 'click') {
    const vw = typeof session.viewport_w === 'number' ? session.viewport_w : 1280;
    const vh = typeof session.viewport_h === 'number' ? session.viewport_h : 800;
    coordinate = validateTakeoverCoordinate(v.coordinate!, vw, vh);
    if (!coordinate) {
      return err(`coordinate (${Math.round(v.coordinate!.x)}, ${Math.round(v.coordinate!.y)}) is outside the ${vw}×${vh} screen`, {
        requestId, status: 400, code: 'bad_request',
      });
    }
  }

  // Compare-and-swap: only accept when the robot has acked the prior command
  // (command_seq === applied_command_seq) and nobody else bumped it meanwhile.
  const current = session.command_seq;
  if (session.applied_command_seq !== current) {
    return ok({ accepted: false, reason: 'robot_busy' }, { requestId });
  }
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('mapper_takeover_sessions')
    .update({
      command: v.command,
      command_coordinate: coordinate,
      command_note: v.note,
      command_frame_seq: v.command === 'click' ? v.frameSeq : null,
      command_seq: current + 1,
      admin_user_id: admin.accountId,
    })
    .eq('id', session.id)
    .eq('status', 'active')
    .eq('command_seq', current)
    .eq('applied_command_seq', current)
    .select('id')
    .maybeSingle();

  if (updErr) return err(`takeover command failed: ${updErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!updated) {
    // Lost the CAS — a concurrent command won, or the robot moved on.
    return ok({ accepted: false, reason: 'robot_busy' }, { requestId });
  }
  return ok({ accepted: true, commandSeq: current + 1 }, { requestId });
}
