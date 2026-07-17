// POST /api/compliance/vision-reading
// Body: { pid, readingTypeId, imageBase64, mediaType }
//
// AI feature #1 (snap-to-log) for the manager Compliance tab. Same vision
// extraction as the engineer surface, with the authenticated-account budget
// cap + cost ledger applied (the manager has an account; the engineer doesn't).

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { extractReadingFromImage } from '@/lib/compliance/vision';
import {
  VisionTruncatedError,
  VisionImageInvalidError,
  VisionSchemaError,
  type VisionMediaType,
  type VisionUsageReport,
} from '@/lib/vision-extract';
import { AiFeatureDisabledError } from '@/lib/ai/runtime';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

interface Body { pid?: unknown; readingTypeId?: unknown; imageBase64?: unknown; mediaType?: unknown }

export async function POST(req: NextRequest) {
  const visionDeadlineAt = Date.now() + 52_000;
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const typeV = validateUuid(body.readingTypeId, 'readingTypeId');
  if (typeV.error) return err(typeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const mediaV = validateEnum(body.mediaType, MEDIA_TYPES, 'mediaType');
  if (mediaV.error) return err(mediaV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, readingTypeId = typeV.value!;
  if (typeof body.imageBase64 !== 'string' || body.imageBase64.length < 100 || body.imageBase64.length > 8_000_000) {
    return err('invalid_image', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-vision', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const { data: typeRow } = await supabaseAdmin
    .from('compliance_reading_types')
    .select('name, unit, category')
    .eq('id', readingTypeId)
    .eq('property_id', pid)
    .maybeSingle();
  if (!typeRow) return err('Reading type not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  const { data: acct } = await supabaseAdmin.from('accounts').select('id').eq('data_user_id', session.userId).maybeSingle();
  const accountId = acct?.id as string | undefined;
  if (accountId) {
    const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
    if (!budget.ok) return err(budget.message, { requestId, status: 429, code: budget.reason });
  }

  let usage: VisionUsageReport | null = null;
  try {
    const result = await extractReadingFromImage(
      { data: body.imageBase64, mediaType: body.mediaType as VisionMediaType },
      { name: String(typeRow.name), unit: String(typeRow.unit ?? ''), category: String(typeRow.category ?? 'other') },
      (u) => { usage = u; },
      { abortSignal: req.signal, deadlineAt: visionDeadlineAt },
    );
    return ok({ value: result.value, unit: result.unit, confidence: result.confidence, note: result.note }, { requestId });
  } catch (e) {
    // Admin kill switch — an intentional state, not an outage. No error log.
    if (e instanceof AiFeatureDisabledError) return err('This AI feature is currently turned off.', { requestId, status: 503, code: 'feature_disabled' });
    if (e instanceof VisionTruncatedError) return err('image_too_complex', { requestId, status: 422, code: ApiErrorCode.ValidationFailed });
    if (e instanceof VisionImageInvalidError) return err('invalid_image', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    if (e instanceof VisionSchemaError) return err('reading_unreadable', { requestId, status: 422, code: ApiErrorCode.UpstreamFailure });
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error('[compliance/vision-reading] vision failed', { requestId, pid, msg });
    return err(status === 503 ? 'vision_unavailable' : 'vision_failed', { requestId, status, code: ApiErrorCode.UpstreamFailure });
  } finally {
    if (usage && accountId) {
      const u = usage as VisionUsageReport;
      try {
        await recordNonRequestCost({
          userId: accountId, propertyId: pid, conversationId: null,
          model: u.model, modelId: u.modelId,
          tokensIn: u.inputTokens, tokensOut: u.outputTokens,
          cachedInputTokens: u.cachedInputTokens, costUsd: u.costUsd, kind: 'vision',
        });
      } catch { /* best-effort */ }
    }
  }
}
