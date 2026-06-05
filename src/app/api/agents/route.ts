// GET  /api/agents?pid=…   — list a property's agents (any member)
// POST /api/agents          — create an agent (management only)
//
// agents is service-role-only (deny-all RLS) so ALL access is via agentRepo
// (supabaseAdmin). Reads require a session with property access; writes
// additionally require a management role — same gating as the equipment /
// compliance config routes.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { isManager } from '@/lib/compliance/api-helpers';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { agentRepo, resolveAccountId } from '@/lib/db/agents';
import { validateAgentConfig } from '@/lib/agents/config-validate';

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

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  try {
    const agents = await agentRepo.listAgents(pid);
    return ok({ agents }, { requestId });
  } catch (e) {
    log.error('[agents] list failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (!(await isManager(session.userId))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit('agents-config', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const nameV = validateString(body.name, { max: 120, label: 'name' });
  if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null && body.description !== '') {
    const dV = validateString(body.description, { max: 500, label: 'description' });
    if (dV.error) return err(dV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    description = dV.value!;
  }

  const cfgV = validateAgentConfig(body.config);
  if (cfgV.error) return err(cfgV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  let templateKey: string | null = null;
  if (body.templateKey !== undefined && body.templateKey !== null && body.templateKey !== '') {
    const tV = validateString(body.templateKey, { max: 100, label: 'templateKey' });
    if (tV.error) return err(tV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    templateKey = tV.value!;
  }

  try {
    const createdBy = await resolveAccountId(session.userId);
    const created = await agentRepo.createAgent({
      propertyId: pid,
      name: nameV.value!,
      description,
      templateKey,
      config: cfgV.value!,
      createdBy,
    });
    return ok({ agent: created }, { requestId, status: 201 });
  } catch (e) {
    log.error('[agents] create failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
