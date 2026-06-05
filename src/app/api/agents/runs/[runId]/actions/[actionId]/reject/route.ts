// POST /api/agents/runs/[runId]/actions/[actionId]/reject
// Reject a queued (approve_first) step. Management only.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { isManager } from '@/lib/compliance/api-helpers';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { agentRepo, resolveAccountId } from '@/lib/db/agents';
import { rejectStep } from '@/lib/agents/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

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

  const rl = await checkAndIncrementRateLimit('agents-approve', found.run.propertyId);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const decidedBy = await resolveAccountId(session.userId);
    const result = await rejectStep(actionId, decidedBy);
    if (!result.ok) return err(result.error ?? 'reject failed', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    return ok({ runStatus: result.status }, { requestId });
  } catch (e) {
    log.error('[agents reject] failed', { requestId, actionId, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
