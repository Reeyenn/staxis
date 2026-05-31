/**
 * /api/financials/scan-invoice — snap a vendor invoice → Claude Vision extracts
 * vendor + total + date, AI-suggests a department, and flags a "2× your usual"
 * outlier. Returns a DRAFT the manager confirms in the expense form (a human
 * approves every money write); it does NOT auto-insert.
 *
 * Reuses the hardened invoice scanner: visionExtractJSON + the daily $ budget
 * cap + the api_limits rate limiter (keyed on the RAW pid — billing endpoint,
 * fails closed). Mirrors /api/inventory/scan-invoice.
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
import { isDepartment, parseDollarsToCents, type Department } from '@/lib/financials/shared';
import { vendorHistoryCents } from '@/lib/financials/db';
import { detectInvoiceOutlier } from '@/lib/financials/anomaly';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
const SUPPORTED_MEDIA_TYPES: readonly VisionMediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface ExtractedFinanceInvoice {
  vendor_name: string | null;
  invoice_date: string | null;
  invoice_number: string | null;
  total_amount: number | null; // dollars
  suggested_department: string | null;
  summary: string | null;
}

const PROMPT = `You are reading a vendor invoice or receipt to log a hotel expense.

Extract and return ONLY this JSON object (no prose, no code fences):
{
  "vendor_name": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "invoice_number": "string or null",
  "total_amount": number_in_dollars_or_null,
  "suggested_department": "one of: rooms, housekeeping, maintenance, front_desk, breakfast, utilities, sales_marketing, admin_general, other",
  "summary": "3-6 word description of what was purchased, or null"
}

Rules:
- total_amount is the GRAND TOTAL actually owed/paid (after tax), as a plain number in dollars (e.g. 1234.56). Null if not visible.
- suggested_department: pick the single best fit. Linens/toiletries/cleaning supplies → housekeeping. Repairs/parts/HVAC/plumbing → maintenance. Food/coffee/breakfast supplies → breakfast. Power/water/gas/internet → utilities. Ads/OTA/marketing → sales_marketing. Office/bank/software/insurance → admin_general. If unclear → other.
- If the image is not an invoice or receipt, return all nulls and "other".`;

export async function POST(req: NextRequest): Promise<Response> {
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
  const rl = await checkAndIncrementRateLimit('financials-scan-invoice', pid);
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
    const result = await visionExtractJSON<ExtractedFinanceInvoice>(
      { data: imageBase64, mediaType: mediaType as VisionMediaType },
      PROMPT,
      (raw): ExtractedFinanceInvoice => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new VisionSchemaError('expected an object at top level');
        }
        const o = raw as Record<string, unknown>;
        return {
          vendor_name: typeof o.vendor_name === 'string' ? o.vendor_name : null,
          invoice_date: typeof o.invoice_date === 'string' ? o.invoice_date : null,
          invoice_number: typeof o.invoice_number === 'string' ? o.invoice_number : null,
          total_amount: typeof o.total_amount === 'number' && Number.isFinite(o.total_amount) ? o.total_amount : null,
          suggested_department: typeof o.suggested_department === 'string' ? o.suggested_department : null,
          summary: typeof o.summary === 'string' ? o.summary : null,
        };
      },
      captureUsage,
    );

    const amountCents = result.total_amount != null ? Math.max(0, parseDollarsToCents(result.total_amount) ?? 0) : null;
    const department: Department = isDepartment(result.suggested_department)
      ? (result.suggested_department as Department)
      : 'other';
    const vendor = (result.vendor_name ?? '').toString().trim().slice(0, 200) || null;
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const invoiceDate = result.invoice_date && ymd.test(result.invoice_date) ? result.invoice_date : null;

    // Outlier check vs this vendor's own history (read-only, best-effort).
    let anomalyWarning: string | null = null;
    if (vendor && amountCents != null && amountCents > 0) {
      try {
        const history = await vendorHistoryCents(pid, vendor, invoiceDate ?? undefined);
        const outlier = detectInvoiceOutlier(amountCents, vendor, history);
        if (outlier) anomalyWarning = outlier.message;
      } catch {
        /* non-fatal */
      }
    }

    return ok(
      {
        draft: {
          vendor,
          invoiceDate,
          invoiceNumber: (result.invoice_number ?? '').toString().trim().slice(0, 100) || null,
          amountCents,
          department,
          summary: (result.summary ?? '').toString().trim().slice(0, 200) || null,
        },
        anomalyWarning,
      },
      { requestId },
    );
  } catch (e) {
    if (e instanceof VisionTruncatedError) {
      return err('invoice_too_complex', { requestId, status: 422, code: 'invoice_too_complex' });
    }
    if (e instanceof VisionImageInvalidError) {
      return err('invalid_image', { requestId, status: 400, code: 'invalid_image', details: e.message });
    }
    if (e instanceof VisionSchemaError) {
      log.warn('[financials/scan-invoice] vision JSON failed schema validation', { pid, reason: e.reason });
      return err('invoice_extract_invalid_shape', { requestId, status: 422, code: 'invoice_extract_invalid_shape' });
    }
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    log.error('[financials/scan-invoice] vision call failed', { pid, err: e instanceof Error ? e : new Error(msg) });
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
          costUsd: u.costUsd,
          kind: 'vision',
        });
      } catch (costErr) {
        const errObj = costErr instanceof Error ? costErr : new Error(String(costErr));
        log.error('[financials/scan-invoice] cost-ledger write failed', {
          err: errObj,
          pid,
          accountId,
          unrecorded: { tokensIn: u.inputTokens, tokensOut: u.outputTokens, costUsd: u.costUsd, modelId: u.modelId },
        });
        captureException(errObj, { subsystem: 'cost-ledger', route: 'financials-scan-invoice', severity: 'high', pid, accountId, cost_usd: u.costUsd });
      }
    }
  }
}
