/**
 * /api/financials/scan-invoice — snap a vendor invoice → Claude Vision extracts
 * vendor + total + date, AI-suggests a department, and flags a "2× your usual"
 * outlier. Returns a DRAFT the manager confirms in the expense form (a human
 * approves every money write); it does NOT auto-insert.
 *
 * Reuses the hardened invoice scanner: visionExtractJSON + the daily $ budget
 * cap + the api_limits rate limiter (keyed on the RAW pid — billing endpoint,
 * fails closed). Mirrors /api/inventory/scan-invoice. The gate / image checks /
 * rate limit / budget / Vision error mapping / cost-ledger `finally` are shared
 * with scan-quote via runFinanceScanRoute; this file supplies the prompt, the
 * schema mapper, and the draft builder.
 */

import { type NextRequest } from 'next/server';
import { VisionSchemaError } from '@/lib/vision-extract';
import { runFinanceScanRoute } from '@/lib/financials/scan-vision-route';
import { isDepartment, parseDollarsToCents, type Department } from '@/lib/financials/shared';
import { vendorHistoryCents } from '@/lib/financials/db';
import { detectInvoiceOutlier } from '@/lib/financials/anomaly';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  return runFinanceScanRoute<ExtractedFinanceInvoice>(req, {
    endpoint: 'financials-scan-invoice',
    logLabel: '[financials/scan-invoice]',
    costRoute: 'financials-scan-invoice',
    tooComplexCode: 'invoice_too_complex',
    invalidShapeCode: 'invoice_extract_invalid_shape',
    prompt: PROMPT,
    mapRaw: (raw): ExtractedFinanceInvoice => {
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
    buildData: async (result, { pid }) => {
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

      return {
        draft: {
          vendor,
          invoiceDate,
          invoiceNumber: (result.invoice_number ?? '').toString().trim().slice(0, 100) || null,
          amountCents,
          department,
          summary: (result.summary ?? '').toString().trim().slice(0, 200) || null,
        },
        anomalyWarning,
      };
    },
  });
}
