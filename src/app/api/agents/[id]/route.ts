// GET   /api/agents/[id]   — read one agent (member with property access)
// PATCH /api/agents/[id]   — update / activate / pause / archive (management)

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { isManager } from '@/lib/compliance/api-helpers';
import { validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { agentRepo, type UpdateAgentPatch } from '@/lib/db/agents';
import { validateAgentConfig } from '@/lib/agents/config-validate';
import type { AgentStatus } from '@/lib/agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const STATUSES: readonly AgentStatus[] = ['draft', 'active', 'paused', 'archived'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const { id } = await params;

  const agent = await agentRepo.getAgent(id).catch(() => null);
  if (!agent || !(await userHasPropertyAccess(session.userId, agent.propertyId))) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  return ok({ agent }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const rl = await checkAndIncrementRateLimit('agents-config', agent.propertyId);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const patch: UpdateAgentPatch = {};
  if (body.name !== undefined) {
    const v = validateString(body.name, { max: 120, label: 'name' });
    if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    patch.name = v.value!;
  }
  if (body.description !== undefined) {
    if (body.description === null || body.description === '') {
      patch.description = null;
    } else {
      const v = validateString(body.description, { max: 500, label: 'description' });
      if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.description = v.value!;
    }
  }
  if (body.config !== undefined) {
    const v = validateAgentConfig(body.config);
    if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    patch.config = v.value!;
  }
  if (body.status !== undefined) {
    const v = validateEnum(body.status, STATUSES, 'status');
    if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    patch.status = v.value!;
  }

  try {
    const updated = await agentRepo.updateAgent(id, patch);
    if (!updated) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return ok({ agent: updated }, { requestId });
  } catch (e) {
    log.error('[agents/:id] update failed', { requestId, id, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
