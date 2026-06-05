// POST /api/agents/[id]/run — manually run an agent now, OR dry-run ("test on
// yesterday's data") a past day. body: { mode: 'live'|'dry_run', date?: 'YYYY-MM-DD' }.
// Management only. A live manual run uses TODAY (a past date is rejected); a
// dry_run REQUIRES a date.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { isManager } from '@/lib/compliance/api-helpers';
import { validateEnum, validateDateStr } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { agentRepo, resolveAccountId } from '@/lib/db/agents';
import { runAgent } from '@/lib/agents/engine';
import type { RunMode } from '@/lib/agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const { id } = await params;

  const agent = await agentRepo.getAgent(id).catch(() => null);
  if (!agent || !(await userHasPropertyAccess(session.userId, agent.propertyId))) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (!(await isManager(session.userId))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const modeV = validateEnum<RunMode>(body.mode, ['live', 'dry_run'] as const, 'mode');
  if (modeV.error) return err(modeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const mode = modeV.value!;

  let date: string | undefined;
  if (mode === 'dry_run') {
    const dV = validateDateStr(body.date, { label: 'date', allowPastDays: 400, allowFutureDays: 0 });
    if (dV.error) return err(`dry_run requires a valid past date: ${dV.error}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    date = dV.value!;
  } else if (body.date !== undefined && body.date !== null && body.date !== '') {
    return err('a live run always uses today — omit "date" (use dry_run to test a past day)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const rl = await checkAndIncrementRateLimit('agents-run', agent.propertyId);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const triggeredBy = await resolveAccountId(session.userId);
    const outcome = await runAgent(id, {
      mode,
      triggerSource: mode === 'dry_run' ? 'backtest' : 'manual',
      asOfDate: date,
      triggeredBy,
    });
    return ok({ outcome }, { requestId });
  } catch (e) {
    log.error('[agents/:id/run] failed', { requestId, id, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
