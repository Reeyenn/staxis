// GET  /api/compliance/load-template            → list available templates
// POST /api/compliance/load-template { pid, templateKey } → apply one
//
// Starter Template library (AI feature #5 companion). GET is the picker list;
// POST loads a chosen brand template's readings + PM logs. Manager-gated POST.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { isManager } from '@/lib/compliance/api-helpers';
import { TEMPLATES, getTemplate } from '@/lib/compliance/templates';
import { applySeeds } from '@/lib/compliance/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  return ok({
    templates: TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      readingCount: t.readingTypes.length,
      pmCount: t.pmTasks.length,
    })),
  }, { requestId });
}

interface Body { pid?: unknown; templateKey?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const keyV = validateString(body.templateKey, { max: 60, label: 'templateKey' });
  if (keyV.error) return err(keyV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;
  const template = getTemplate(keyV.value!);
  if (!template) return err('Unknown template', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (!(await isManager(session.userId))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-config', hashToRateLimitKey(`${pid}:${session.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const { readingsCreated, pmCreated } = await applySeeds(pid, template.readingTypes, template.pmTasks, template.key);
    return ok({ templateKey: template.key, readingsCreated, pmCreated }, { requestId });
  } catch (e) {
    log.error('[compliance/load-template] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
