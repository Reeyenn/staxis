// GET /api/agents/[id]/runs — run history for one agent (member with access).

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { agentRepo } from '@/lib/db/agents';
import type { Paginated, AgentRun } from '@/lib/agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const { id } = await params;

  const agent = await agentRepo.getAgent(id).catch(() => null);
  if (!agent || !(await userHasPropertyAccess(session.userId, agent.propertyId))) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  try {
    const runs = await agentRepo.listRunsForAgent(id, 50);
    const body: Paginated<AgentRun> = { items: runs, nextCursor: null };
    return ok(body, { requestId });
  } catch (e) {
    log.error('[agents/:id/runs] failed', { requestId, id, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
