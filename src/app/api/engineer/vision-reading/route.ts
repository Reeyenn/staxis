// POST /api/engineer/vision-reading
// Body: { pid, staffId, readingTypeId, imageBase64, mediaType }
//
// AI feature #1 (snap-to-log) for the engineer mobile page. Capability gate,
// then Claude Vision reads the gauge/strip and we return the pre-fill value.
// Does NOT log — the engineer confirms then calls /api/engineer/log-reading.

import { NextRequest } from 'next/server';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';
import { checkStaffCapability, resolveCostAccount } from '@/lib/compliance/api-helpers';
import { extractReadingFromImage } from '@/lib/compliance/vision';
import {
  VisionTruncatedError,
  VisionImageInvalidError,
  VisionSchemaError,
  type VisionMediaType,
  type VisionUsageReport,
} from '@/lib/vision-extract';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

interface Body {
  pid?: unknown; staffId?: unknown; readingTypeId?: unknown;
  imageBase64?: unknown; mediaType?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const typeV = validateUuid(body.readingTypeId, 'readingTypeId');
  if (typeV.error) return err(typeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const mediaV = validateEnum(body.mediaType, MEDIA_TYPES, 'mediaType');
  if (mediaV.error) return err(mediaV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, staffId = staffV.value!, readingTypeId = typeV.value!;
  if (typeof body.imageBase64 !== 'string' || body.imageBase64.length < 100 || body.imageBase64.length > 8_000_000) {
    return err('invalid_image', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const rl = await checkAndIncrementRateLimit('engineer-vision', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const staff = await checkStaffCapability(pid, staffId);
  if (!staff) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  const { data: typeRow } = await supabaseAdmin
    .from('compliance_reading_types')
    .select('name, unit, category')
    .eq('id', readingTypeId)
    .eq('property_id', pid)
    .maybeSingle();
  if (!typeRow) return err('Reading type not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  // Per-day budget cap. The engineer has no account, so attribute spend to a
  // property owner/GM account and gate on the same $/day cap the manager twin
  // enforces — a leaked magic link otherwise drives unbounded Claude Vision.
  const accountId = await resolveCostAccount(pid);
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
    );
    return ok({ value: result.value, unit: result.unit, confidence: result.confidence, note: result.note }, { requestId });
  } catch (e) {
    if (e instanceof VisionTruncatedError) return err('image_too_complex', { requestId, status: 422, code: ApiErrorCode.ValidationFailed });
    if (e instanceof VisionImageInvalidError) return err('invalid_image', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    if (e instanceof VisionSchemaError) return err('reading_unreadable', { requestId, status: 422, code: ApiErrorCode.UpstreamFailure });
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error('[engineer/vision-reading] vision failed', { requestId, pid, staffId, msg });
    return err(status === 503 ? 'vision_unavailable' : 'vision_failed', { requestId, status, code: ApiErrorCode.UpstreamFailure });
  } finally {
    // Best-effort cost attribution to the property owner/GM account resolved above.
    if (usage && accountId) {
      const u = usage as VisionUsageReport;
      try {
        await recordNonRequestCost({
          userId: accountId, propertyId: pid, conversationId: null,
          model: u.model, modelId: u.modelId,
          tokensIn: u.inputTokens, tokensOut: u.outputTokens,
          costUsd: u.costUsd, kind: 'vision',
        });
      } catch { /* cost ledger best-effort */ }
    }
  }
}
