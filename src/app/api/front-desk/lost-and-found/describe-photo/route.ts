/**
 * POST /api/front-desk/lost-and-found/describe-photo
 *
 * Claude Vision auto-describe for a found-item photo: returns
 * { description, category, color } the desk can accept or edit before logging.
 * Mirrors /api/inventory/photo-count: pre-flight $ budget, record actual spend
 * (even on error paths), structured error codes, never leaks model output.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { captureException } from '@/lib/sentry';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';
import {
  VisionTruncatedError,
  VisionImageInvalidError,
  VisionSchemaError,
  type VisionUsageReport,
  type VisionMediaType,
} from '@/lib/vision-extract';
import { describeFoundItemPhoto } from '@/lib/lost-and-found/describe';
import { gateFrontDeskWrite } from '@/lib/lost-and-found/api-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

interface Body {
  pid?: string;
  imageBase64?: string;
  mediaType?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateFrontDeskWrite<Body>(req, 'lost-found-describe-photo');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId, accountId } = gate;

  if (typeof body.imageBase64 !== 'string' || body.imageBase64.length < 100) {
    return err('invalid_image', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!SUPPORTED_MEDIA_TYPES.includes(body.mediaType as VisionMediaType)) {
    return err('unsupported_media_type', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  // Pre-flight daily $ budget (same pattern as photo-count).
  if (accountId) {
    const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
    if (!budget.ok) {
      return err(budget.message, {
        requestId,
        status: 429,
        code: ApiErrorCode.RateLimited,
      });
    }
  }

  let usage: VisionUsageReport | null = null;

  try {
    const result = await describeFoundItemPhoto(
      { data: body.imageBase64, mediaType: body.mediaType as VisionMediaType },
      (u) => {
        usage = u;
      },
    );
    return ok(result, { requestId });
  } catch (e) {
    if (e instanceof VisionTruncatedError) {
      return err('image_too_complex', {
        requestId,
        status: 422,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    if (e instanceof VisionImageInvalidError) {
      return err('invalid_image', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        details: e.message,
      });
    }
    if (e instanceof VisionSchemaError) {
      return err('describe_invalid_shape', {
        requestId,
        status: 422,
        code: ApiErrorCode.UpstreamFailure,
      });
    }
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error('lost-found describe-photo failed', {
      requestId,
      pid,
      err: e instanceof Error ? e : new Error(msg),
    });
    return err(status === 503 ? 'vision_unavailable' : 'vision_failed', {
      requestId,
      status,
      code: status === 503 ? ApiErrorCode.UpstreamFailure : ApiErrorCode.InternalError,
    });
  } finally {
    if (usage && accountId) {
      const u = usage as VisionUsageReport;
      try {
        await recordNonRequestCost({
          userId: accountId,
          propertyId: pid,
          conversationId: null,
          model: u.model,
          modelId: u.modelId,
          tokensIn: u.inputTokens,
          tokensOut: u.outputTokens,
          costUsd: u.costUsd,
          kind: 'vision',
        });
      } catch (costErr) {
        const errObj = costErr instanceof Error ? costErr : new Error(String(costErr));
        log.error('lost-found describe-photo cost-ledger write failed', {
          requestId,
          pid,
          accountId,
          err: errObj,
        });
        captureException(errObj, {
          subsystem: 'cost-ledger',
          route: 'lost-found-describe-photo',
          severity: 'high',
          pid,
        });
      }
    }
  }
}
