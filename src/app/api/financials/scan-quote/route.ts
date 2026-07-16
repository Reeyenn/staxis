/**
 * /api/financials/scan-quote — Smart CapEx. Snap a contractor quote/estimate →
 * Claude Vision extracts the project, the quoted total, and line items → returns
 * a DRAFT the manager confirms into a CapEx project (human approves the write).
 *
 * Same hardened path as scan-invoice: visionExtractJSON + daily $ cap + the
 * api_limits rate limiter keyed on the RAW pid (billing endpoint, fails closed).
 */

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
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';
import { captureException } from '@/lib/sentry';
import { ok, err } from '@/lib/api-response';
import { parseDollarsToCents } from '@/lib/financials/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
const SUPPORTED_MEDIA_TYPES: readonly VisionMediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface ExtractedQuote {
  project_name: string | null;
  vendor_name: string | null;
  quote_total: number | null; // dollars
  quote_date: string | null;
  line_items: Array<{ label: string; amount: number | null }>;
  summary: string | null;
}

const PROMPT = `You are reading a contractor quote, estimate, or bid for a hotel capital project.

Extract and return ONLY this JSON object (no prose, no code fences):
{
  "project_name": "short name for the project (e.g. 'Lobby HVAC replacement') or null",
  "vendor_name": "the contractor/company name or null",
  "quote_total": total_quoted_amount_in_dollars_or_null,
  "quote_date": "YYYY-MM-DD or null",
  "line_items": [ { "label": "what this line is for", "amount": amount_in_dollars_or_null } ],
  "summary": "one-sentence description of the work, or null"
}

Rules:
- quote_total is the GRAND TOTAL of the quote in dollars (e.g. 24500.00). Null if not visible.
- line_items: one per distinct line on the quote (labor, materials, each room, etc.). amount in dollars; null if a line has no price. Keep labels short.
- If the image is not a quote/estimate, return nulls and an empty line_items array.`;

export async function POST(req: NextRequest): Promise<Response> {
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

  const rl = await checkAndIncrementRateLimit('financials-scan-quote', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
  if (!budget.ok) {
    return NextResponse.json({ ok: false, requestId, error: budget.message, code: budget.reason }, { status: 429 });
  }

  let usage: VisionUsageReport | null = null;
  const captureUsage = (u: VisionUsageReport): void => {
    usage = u;
  };

  try {
    const result = await visionExtractJSON<ExtractedQuote>(
      { data: imageBase64, mediaType: mediaType as VisionMediaType },
      PROMPT,
      (raw): ExtractedQuote => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new VisionSchemaError('expected an object at top level');
        }
        const o = raw as Record<string, unknown>;
        const rawLines = Array.isArray(o.line_items) ? o.line_items : [];
        const line_items = rawLines
          .map((l) => {
            const li = (l ?? {}) as Record<string, unknown>;
            return {
              label: typeof li.label === 'string' ? li.label : '',
              amount: typeof li.amount === 'number' && Number.isFinite(li.amount) ? li.amount : null,
            };
          })
          .filter((l) => l.label.trim().length > 0)
          .slice(0, 100);
        return {
          project_name: typeof o.project_name === 'string' ? o.project_name : null,
          vendor_name: typeof o.vendor_name === 'string' ? o.vendor_name : null,
          quote_total: typeof o.quote_total === 'number' && Number.isFinite(o.quote_total) ? o.quote_total : null,
          quote_date: typeof o.quote_date === 'string' ? o.quote_date : null,
          line_items,
          summary: typeof o.summary === 'string' ? o.summary : null,
        };
      },
      captureUsage,
      'financials.quote_scan',
      { abortSignal: req.signal, deadlineAt: visionDeadlineAt },
    );

    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const quoteCents = result.quote_total != null ? Math.max(0, parseDollarsToCents(result.quote_total) ?? 0) : null;
    const lineItems = result.line_items.map((l) => ({
      label: l.label.trim().slice(0, 200),
      amountCents: l.amount != null ? Math.max(0, parseDollarsToCents(l.amount) ?? 0) : null,
    }));
    // If the model didn't see a grand total, fall back to the sum of priced lines.
    const lineSum = lineItems.reduce((a, l) => a + (l.amountCents ?? 0), 0);
    const effectiveQuoteCents = quoteCents ?? (lineSum > 0 ? lineSum : null);

    return ok(
      {
        draft: {
          name: (result.project_name ?? '').toString().trim().slice(0, 200) || null,
          vendor: (result.vendor_name ?? '').toString().trim().slice(0, 200) || null,
          quoteCents: effectiveQuoteCents,
          quoteDate: result.quote_date && ymd.test(result.quote_date) ? result.quote_date : null,
          summary: (result.summary ?? '').toString().trim().slice(0, 500) || null,
          lineItems,
        },
      },
      { requestId },
    );
  } catch (e) {
    if (e instanceof VisionTruncatedError) {
      return err('quote_too_complex', { requestId, status: 422, code: 'quote_too_complex' });
    }
    if (e instanceof VisionImageInvalidError) {
      return err('invalid_image', { requestId, status: 400, code: 'invalid_image', details: e.message });
    }
    if (e instanceof VisionSchemaError) {
      log.warn('[financials/scan-quote] vision JSON failed schema validation', { pid, reason: e.reason });
      return err('quote_extract_invalid_shape', { requestId, status: 422, code: 'quote_extract_invalid_shape' });
    }
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error('[financials/scan-quote] vision call failed', { pid, err: e instanceof Error ? e : new Error(msg) });
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
        log.error('[financials/scan-quote] cost-ledger write failed', { err: errObj, pid, accountId });
        captureException(errObj, { subsystem: 'cost-ledger', route: 'financials-scan-quote', severity: 'high', pid, accountId, cost_usd: u.costUsd });
      }
    }
  }
}
