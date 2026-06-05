// GET /api/agents/runs?pid=…&status=awaiting_approval
// Property-wide approval queue (Chat 2's headline surface): every run waiting
// on a human, with its pending steps.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { agentRepo } from '@/lib/db/agents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const pidV = validateUuid(req.nextUrl.searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  const statusV = validateEnum(req.nextUrl.searchParams.get('status') ?? 'awaiting_approval', ['awaiting_approval'] as const, 'status');
  if (statusV.error) return err(statusV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    const items = await agentRepo.listApprovalQueue(pid);
    return ok({ items }, { requestId });
  } catch (e) {
    log.error('[agents/runs] queue failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
