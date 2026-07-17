/**
 * /api/financials/scan-quote — Smart CapEx. Snap a contractor quote/estimate →
 * Claude Vision extracts the project, the quoted total, and line items → returns
 * a DRAFT the manager confirms into a CapEx project (human approves the write).
 *
 * Same hardened path as scan-invoice: visionExtractJSON + daily $ cap + the
 * api_limits rate limiter keyed on the RAW pid (billing endpoint, fails closed).
 * The gate / image checks / rate limit / budget / Vision error mapping /
 * cost-ledger `finally` are shared with scan-invoice via runFinanceScanRoute;
 * this file supplies the prompt, the schema mapper, and the draft builder.
 */

import { type NextRequest } from 'next/server';
import { VisionSchemaError } from '@/lib/vision-extract';
import { runFinanceScanRoute } from '@/lib/financials/scan-vision-route';
import { parseDollarsToCents } from '@/lib/financials/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  return runFinanceScanRoute<ExtractedQuote>(req, {
    featureKey: 'financials.quote_scan',
    endpoint: 'financials-scan-quote',
    logLabel: '[financials/scan-quote]',
    costRoute: 'financials-scan-quote',
    tooComplexCode: 'quote_too_complex',
    invalidShapeCode: 'quote_extract_invalid_shape',
    prompt: PROMPT,
    mapRaw: (raw): ExtractedQuote => {
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
    buildData: (result) => {
      const ymd = /^\d{4}-\d{2}-\d{2}$/;
      const quoteCents = result.quote_total != null ? Math.max(0, parseDollarsToCents(result.quote_total) ?? 0) : null;
      const lineItems = result.line_items.map((l) => ({
        label: l.label.trim().slice(0, 200),
        amountCents: l.amount != null ? Math.max(0, parseDollarsToCents(l.amount) ?? 0) : null,
      }));
      // If the model didn't see a grand total, fall back to the sum of priced lines.
      const lineSum = lineItems.reduce((a, l) => a + (l.amountCents ?? 0), 0);
      const effectiveQuoteCents = quoteCents ?? (lineSum > 0 ? lineSum : null);

      return {
        draft: {
          name: (result.project_name ?? '').toString().trim().slice(0, 200) || null,
          vendor: (result.vendor_name ?? '').toString().trim().slice(0, 200) || null,
          quoteCents: effectiveQuoteCents,
          quoteDate: result.quote_date && ymd.test(result.quote_date) ? result.quote_date : null,
          summary: (result.summary ?? '').toString().trim().slice(0, 500) || null,
          lineItems,
        },
      };
    },
  });
}
