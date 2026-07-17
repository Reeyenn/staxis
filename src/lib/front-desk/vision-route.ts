// ═══════════════════════════════════════════════════════════════════════════
// Shared runner for the two front-desk Vision routes.
//
// /api/front-desk/lost-and-found/describe-photo and
// /api/front-desk/packages/scan-label are true twins: authenticated front-desk
// gate → image validation → pre-flight daily $ budget → Vision extract →
// structured error mapping (never leaks model output) → cost-ledger `finally`
// that records actual spend on every path (including error paths). They differ
// only in five strings: the gate function, the rate-limit/capture endpoint, the
// extract function, the schema-error code, and the log label.
// ═══════════════════════════════════════════════════════════════════════════

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
  type VisionImage,
  type VisionCallOptions,
} from '@/lib/vision-extract';
import type { RateLimitEndpoint } from '@/lib/api-ratelimit';
import { AiFeatureDisabledError } from '@/lib/ai/runtime';

// Camera stills only (no gif). Both surfaces use inline base64 — nothing stored
// — but keeping the list aligned with the presign allow-list avoids a latent
// "scan accepts it, upload rejects it" trap.
const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface FrontDeskVisionBody {
  pid?: string;
  imageBase64?: string;
  mediaType?: string;
}

interface FrontDeskVisionGateOk<TBody> {
  ok: true;
  body: TBody;
  pid: string;
  requestId: string;
  accountId: string | null;
}
type FrontDeskVisionGateResult<TBody> =
  | FrontDeskVisionGateOk<TBody>
  | { ok: false; response: Response };

export interface FrontDeskVisionRouteConfig<TBody extends FrontDeskVisionBody, TResult> {
  /** Authenticated front-desk gate (gateFrontDeskWrite / gatePackagesWrite). */
  gate: (req: NextRequest, endpoint: RateLimitEndpoint) => Promise<FrontDeskVisionGateResult<TBody>>;
  /** Rate-limit endpoint; also used as the captureException route tag. */
  endpoint: RateLimitEndpoint;
  /** The Vision extractor (describeFoundItemPhoto / scanShippingLabel). */
  extract: (
    image: VisionImage,
    onUsage?: (u: VisionUsageReport) => void,
    opts?: VisionCallOptions,
  ) => Promise<TResult>;
  /** err() code returned when the model output fails schema validation. */
  schemaErrCode: string;
  /** Log prefix, e.g. 'lost-found describe-photo' / 'packages scan-label'. */
  label: string;
}

export async function runFrontDeskVisionRoute<TBody extends FrontDeskVisionBody, TResult>(
  req: NextRequest,
  config: FrontDeskVisionRouteConfig<TBody, TResult>,
): Promise<Response> {
  const { gate, endpoint, extract, schemaErrCode, label } = config;
  // Leave 8s of the 60s route ceiling for the cost-ledger finally.
  const visionDeadlineAt = Date.now() + 52_000;

  const g = await gate(req, endpoint);
  if (!g.ok) return g.response;
  const { body, pid, requestId, accountId } = g;

  if (typeof body.imageBase64 !== 'string' || body.imageBase64.length < 100) {
    return err('invalid_image', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!(SUPPORTED_MEDIA_TYPES as readonly string[]).includes(body.mediaType ?? '')) {
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
    const result = await extract(
      { data: body.imageBase64, mediaType: body.mediaType as VisionMediaType },
      (u) => {
        usage = u;
      },
      { abortSignal: req.signal, deadlineAt: visionDeadlineAt },
    );
    return ok(result, { requestId });
  } catch (e) {
    if (e instanceof AiFeatureDisabledError) {
      // Admin kill switch — an intentional state, not an outage. No error log.
      return err('This AI feature is currently turned off.', {
        requestId,
        status: 503,
        code: 'feature_disabled',
      });
    }
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
      return err(schemaErrCode, {
        requestId,
        status: 422,
        code: ApiErrorCode.UpstreamFailure,
      });
    }
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error(`${label} failed`, {
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
          cachedInputTokens: u.cachedInputTokens,
          costUsd: u.costUsd,
          kind: 'vision',
        });
      } catch (costErr) {
        const errObj = costErr instanceof Error ? costErr : new Error(String(costErr));
        log.error(`${label} cost-ledger write failed`, {
          requestId,
          pid,
          accountId,
          err: errObj,
        });
        captureException(errObj, {
          subsystem: 'cost-ledger',
          route: endpoint,
          severity: 'high',
          pid,
        });
      }
    }
  }
}
