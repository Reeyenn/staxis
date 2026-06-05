// GET /api/agents/runs/[runId] — the run RECEIPT (run + every step).

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { agentRepo } from '@/lib/db/agents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const { runId } = await params;

  const idV = validateUuid(runId, 'runId');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const receipt = await agentRepo.getRunWithSteps(runId).catch(() => null);
  if (!receipt || !(await userHasPropertyAccess(session.userId, receipt.run.propertyId))) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  return ok({ receipt }, { requestId });
}
