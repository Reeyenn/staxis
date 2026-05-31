// POST /api/compliance/setup
// Body: { pid, text? }
//
// AI feature #5 — ONE-LINE AI SETUP. Auto-detects the property's brand from
// its name / PMS family and pre-loads the brand-required readings + PM logs.
// If `text` is supplied ("we have 15 extinguishers, 18 emergency lights, a
// pool, 3 walk-in fridges"), Claude parses it into a spec that tunes the
// counts / presence on top of the brand template. Manager-gated.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { isManager } from '@/lib/compliance/api-helpers';
import { detectTemplate } from '@/lib/compliance/templates';
import { parseSetupFromText, buildSeedsFromSpec } from '@/lib/compliance/nlp';
import { applySeeds } from '@/lib/compliance/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body { pid?: unknown; text?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;
  let text = '';
  if (body.text !== undefined && body.text !== null) {
    const tv = validateString(body.text, { max: 1000, label: 'text', allowEmpty: true });
    if (tv.error) return err(tv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    text = tv.value || '';
  }

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (!(await isManager(session.userId))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-setup', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const { data: prop } = await supabaseAdmin
      .from('properties')
      .select('name, pms_type')
      .eq('id', pid)
      .maybeSingle();
    const template = detectTemplate(prop?.name as string | null, prop?.pms_type as string | null);

    let readingSeeds = template.readingTypes;
    let pmSeeds = template.pmTasks;
    if (text.trim()) {
      const spec = await parseSetupFromText(text);
      const built = buildSeedsFromSpec(template, spec);
      readingSeeds = built.readingSeeds;
      pmSeeds = built.pmSeeds;
    }

    const { readingsCreated, pmCreated } = await applySeeds(pid, readingSeeds, pmSeeds, template.key);
    return ok({
      detectedBrand: template.label,
      templateKey: template.key,
      readingsCreated,
      pmCreated,
    }, { requestId });
  } catch (e) {
    log.error('[compliance/setup] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
