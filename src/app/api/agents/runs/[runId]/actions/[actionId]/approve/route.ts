// POST /api/agents/runs/[runId]/actions/[actionId]/approve
// Approve a queued (approve_first) step and execute it. Management only. The
// step's run must be live. Atomic CAS in the engine makes double-approve a
// no-op. SMS-firing actions are rate-limited on the SMS bucket before execute.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { isManager } from '@/lib/compliance/api-helpers';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse, type RateLimitEndpoint } from '@/lib/api-ratelimit';
import { agentRepo, resolveAccountId } from '@/lib/db/agents';
import { executeApprovedStep } from '@/lib/agents/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string; actionId: string }> }) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const { runId, actionId } = await params;

  if (validateUuid(runId, 'runId').error || validateUuid(actionId, 'actionId').error) {
    return err('Invalid id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const found = await agentRepo.getStepWithRun(actionId).catch(() => null);
  if (!found || found.step.runId !== runId || !(await userHasPropertyAccess(session.userId, found.run.propertyId))) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (!(await isManager(session.userId))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (found.run.mode !== 'live') {
    return err('Cannot approve a step from a non-live run', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const smsLike = found.step.actionKey === 'send_staff_sms' || found.step.spendsMoney || found.step.contactsGuest;
  const rlKey: RateLimitEndpoint = smsLike ? 'agents-action-sms' : 'agents-approve';
  const rl = await checkAndIncrementRateLimit(rlKey, found.run.propertyId);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const decidedBy = await resolveAccountId(session.userId);
    const result = await executeApprovedStep(actionId, decidedBy);
    if (!result.ok) return err(result.error ?? 'approve failed', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    return ok({ runStatus: result.status }, { requestId });
  } catch (e) {
    log.error('[agents approve] failed', { requestId, actionId, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
