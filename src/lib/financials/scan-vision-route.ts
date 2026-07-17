// ═══════════════════════════════════════════════════════════════════════════
// Shared runner for the two financials Vision-scan routes.
//
// /api/financials/scan-invoice and /api/financials/scan-quote are structural
// twins: same finance-access gate, same image validation, same RAW-pid rate
// limit, same daily $ budget cap, same Vision error → HTTP mapping, and the
// same cost-ledger `finally`. They differ ONLY in the model prompt, the JSON
// schema mapper, and how the extracted result is shaped into the DRAFT the
// route returns. This module owns everything identical; each route supplies
// the three varying pieces (prompt / mapRaw / buildData) plus its endpoint /
// log-label / error-code strings.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse, type NextRequest } from 'next/server';
import {
  visionExtractJSON,
  VisionTruncatedError,
  VisionImageInvalidError,
  VisionSchemaError,
  type VisionUsageReport,
} from '@/lib/vision-extract';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  type RateLimitEndpoint,
} from '@/lib/api-ratelimit';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';
import { captureException } from '@/lib/sentry';
import { ok, err } from '@/lib/api-response';
import type { AiFeatureKey } from '@/lib/ai/types';
import { AiFeatureDisabledError } from '@/lib/ai/runtime';

type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
const SUPPORTED_MEDIA_TYPES: readonly VisionMediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface FinanceScanConfig<TExtract> {
  /** AI Control Center feature key — routes the Vision call through the per-feature model config. */
  featureKey: AiFeatureKey;
  /** api_limits rate-limit endpoint (RAW pid keyed; billing, fails closed). */
  endpoint: RateLimitEndpoint;
  /** Log/Sentry prefix, e.g. '[financials/scan-invoice]'. */
  logLabel: string;
  /** captureException route tag, e.g. 'financials-scan-invoice'. */
  costRoute: string;
  /** err() code for a Vision-truncated response (e.g. 'invoice_too_complex'). */
  tooComplexCode: string;
  /** err() code for a schema-invalid extraction (e.g. 'invoice_extract_invalid_shape'). */
  invalidShapeCode: string;
  /** The model prompt. */
  prompt: string;
  /** Narrow the raw model JSON into the typed extract (throws VisionSchemaError). */
  mapRaw: (raw: unknown) => TExtract;
  /** Build the response `data` object from the extract (may do best-effort DB reads). */
  buildData: (result: TExtract, ctx: { pid: string }) => Promise<unknown> | unknown;
}

export async function runFinanceScanRoute<TExtract>(
  req: NextRequest,
  config: FinanceScanConfig<TExtract>,
): Promise<Response> {
  const {
    featureKey, endpoint, logLabel, costRoute, tooComplexCode, invalidShapeCode,
    prompt, mapRaw, buildData,
  } = config;
  // Leave 8s of the 60s route ceiling for buildData + the cost-ledger finally.
  const visionDeadlineAt = Date.now() + 52_000;

  const body = (await req.json().catch(() => null)) as
    | { pid?: string; imageBase64?: string; mediaType?: string }
    | null;
  if (!body) return err('invalid_json', { requestId: 'na', status: 400, code: 'invalid_json' });

  const gate = await requireFinanceAccess(req, body.pid);
  if (!gate.ok) return gate.response;
  const { pid, requestId, accountId } = gate;

  const { imageBase64, mediaType } = body;
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return err('invalid_image', { requestId, status: 400, code: 'invalid_image' });
  }
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType as VisionMediaType)) {
    return err('unsupported_media_type', { requestId, status: 400, code: 'unsupported_media_type' });
  }

  // Rate limit (RAW pid — billing endpoint, fails closed on RPC error).
  const rl = await checkAndIncrementRateLimit(endpoint, pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Daily $ budget cap so a runaway client can't pile up Anthropic charges.
  const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
  if (!budget.ok) {
    return NextResponse.json({ ok: false, requestId, error: budget.message, code: budget.reason }, { status: 429 });
  }

  let usage: VisionUsageReport | null = null;
  const captureUsage = (u: VisionUsageReport): void => {
    usage = u;
  };

  try {
    const result = await visionExtractJSON<TExtract>(
      { data: imageBase64, mediaType: mediaType as VisionMediaType },
      prompt,
      mapRaw,
      captureUsage,
      featureKey,
      { abortSignal: req.signal, deadlineAt: visionDeadlineAt },
    );

    const data = await buildData(result, { pid });
    return ok(data, { requestId });
  } catch (e) {
    if (e instanceof AiFeatureDisabledError) {
      // Admin kill switch — an intentional state, not an outage. No error log.
      return err('This AI feature is currently turned off.', { requestId, status: 503, code: 'feature_disabled' });
    }
    if (e instanceof VisionTruncatedError) {
      return err(tooComplexCode, { requestId, status: 422, code: tooComplexCode });
    }
    if (e instanceof VisionImageInvalidError) {
      return err('invalid_image', { requestId, status: 400, code: 'invalid_image', details: e.message });
    }
    if (e instanceof VisionSchemaError) {
      log.warn(`${logLabel} vision JSON failed schema validation`, { pid, reason: e.reason });
      return err(invalidShapeCode, { requestId, status: 422, code: invalidShapeCode });
    }
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error(`${logLabel} vision call failed`, { pid, err: e instanceof Error ? e : new Error(msg) });
    return err(status === 503 ? 'vision_unavailable' : 'vision_failed', { requestId, status, code: status === 503 ? 'vision_unavailable' : 'vision_failed' });
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
        log.error(`${logLabel} cost-ledger write failed`, {
          err: errObj,
          pid,
          accountId,
          unrecorded: { tokensIn: u.inputTokens, tokensOut: u.outputTokens, costUsd: u.costUsd, modelId: u.modelId },
        });
        captureException(errObj, { subsystem: 'cost-ledger', route: costRoute, severity: 'high', pid, accountId, cost_usd: u.costUsd });
      }
    }
  }
}
