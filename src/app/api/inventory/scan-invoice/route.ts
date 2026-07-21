/**
 * /api/inventory/scan-invoice — extract line items from a vendor invoice
 * using Claude Vision. Handles single or multi-page photo invoices and PDFs.
 *
 * Request — exactly ONE of three body shapes (pid always required):
 *   1. Legacy single image:
 *        { pid, imageBase64: string, mediaType: 'image/jpeg'|'image/png'|'image/webp'|'image/gif' }
 *      (normalized internally to a one-entry pages array).
 *   2. Multi-page photos:
 *        { pid, pages: [{ imageBase64, mediaType }, ...] }  — 1 to 5 entries.
 *   3. PDF (the model reads all pages in one call):
 *        { pid, pdfBase64: string }                        — raw base64, no data: prefix.
 *   Sending both `pages`/`imageBase64` and `pdfBase64`, or neither, is a 400.
 *
 * Response (UNCHANGED — merged across pages):
 *   { ok: true, vendor_name, invoice_date, invoice_number, items: [...] }
 *
 * Authorization: invoice OCR returns financial evidence and incurs provider
 * spend, so it requires the central finance gate, the inventory-ordering
 * capability, and an enabled Inventory section before calling Vision.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { visionExtractJSON, VisionTruncatedError, VisionImageInvalidError, VisionSchemaError, type VisionUsageReport } from '@/lib/vision-extract';
import { AiFeatureDisabledError } from '@/lib/ai/runtime';
import { mergeInvoicePages, type ExtractedInvoice } from '@/lib/invoice-scan-merge';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';
import { captureException } from '@/lib/sentry';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { canForProperty } from '@/lib/capabilities/server';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Anthropic Vision only accepts these four. iPhone HEIC/HEIF must be
// converted (or rejected at the picker) before reaching here.
const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type VisionMediaType = typeof SUPPORTED_MEDIA_TYPES[number];

// Cap the multi-page photo fan-out. Each page is its own ~55s vision call
// (parallel — see below), and 5 pages covers any realistic paper invoice a
// housekeeper photographs. More than 5 is almost certainly a mis-tap.
const MAX_PAGES = 5;

const PROMPT = `Extract all line items from this invoice or receipt.

For each item return:
- item_name (string)
- quantity (number, total individual units received — see case logic below)
- quantity_cases (number, count of cases/boxes on this line; null if line is in individual units)
- pack_size (number, units per case if visible on the line — e.g. "Case of 36"; null if not specified)
- unit_cost (number, per-unit price; use null if not visible)
- total_cost (number, line total; use null if not visible)

CASE LOGIC (this is critical for hotel inventory):
- Hotel invoices often list items in cases, boxes, or dozens with a pack size (e.g. "3 cases @ 36/case", "Box of 24", "1 dozen").
- When the line is in case form: set quantity_cases = N, pack_size = units-per-case, quantity = N × pack_size.
- When the line is in individual units: set quantity = N, quantity_cases = null, pack_size = null.
- If pack size is implied by phrasing ("dozen" = 12, "gross" = 144) infer it.

Also extract:
- vendor_name (string, or null)
- invoice_date (string in YYYY-MM-DD format, or null)
- invoice_number (string, or null)

Return ONLY a JSON object with this exact shape, no prose, no code fences:
{
  "vendor_name": "...",
  "invoice_date": "YYYY-MM-DD",
  "invoice_number": "...",
  "items": [
    { "item_name": "...", "quantity": 108, "quantity_cases": 3, "pack_size": 36, "unit_cost": 0, "total_cost": 0 }
  ]
}

If the image is not an invoice or receipt, return { "items": [] } and null vendor/date/number.`;

// Per-page schema validator — same shape check the single-image route used.
// Reject null, arrays, primitives, and missing-items so a malformed-but-valid-
// JSON response produces a controlled 422 instead of a crash on result.items.
function validateInvoice(raw: unknown): ExtractedInvoice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VisionSchemaError('expected an object at top level');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.items)) {
    throw new VisionSchemaError('missing or non-array "items" field');
  }
  return {
    vendor_name: typeof obj.vendor_name === 'string' ? obj.vendor_name : null,
    invoice_date: typeof obj.invoice_date === 'string' ? obj.invoice_date : null,
    invoice_number: typeof obj.invoice_number === 'string' ? obj.invoice_number : null,
    items: obj.items as ExtractedInvoice['items'],
  };
}

export async function POST(req: NextRequest) {
  const visionDeadlineAt = Date.now() + 52_000;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const pid = b.pid;
  if (!isUuid(pid)) {
    return NextResponse.json({ ok: false, error: 'invalid_pid' }, { status: 400 });
  }
  const financeGate = await requireFinanceAccess(req, pid);
  if (!financeGate.ok) return financeGate.response;
  if (!(await canForProperty(
    { role: financeGate.role },
    'manage_inventory_orders',
    financeGate.pid,
  ))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  const inventorySectionGate = await requireSectionEnabled(req, financeGate.pid, 'inventory');
  if (!inventorySectionGate.ok) return inventorySectionGate.response;

  // ── Normalize the three body shapes ────────────────────────────────
  // 1. legacy   { imageBase64, mediaType }        → one-entry pages array
  // 2. multi    { pages: [{ imageBase64, mediaType }] }
  // 3. pdf      { pdfBase64 }
  // Exactly one media input must be present. `pdfBase64` and any image
  // input (pages/imageBase64) are mutually exclusive.
  const hasPdf = b.pdfBase64 !== undefined;
  const hasImages = b.pages !== undefined || b.imageBase64 !== undefined;
  if (hasPdf && hasImages) {
    return NextResponse.json({ ok: false, error: 'ambiguous_body' }, { status: 400 });
  }
  if (!hasPdf && !hasImages) {
    return NextResponse.json({ ok: false, error: 'missing_image' }, { status: 400 });
  }

  // Build the ordered list of image pages (empty for the PDF path).
  let pages: Array<{ imageBase64: string; mediaType: VisionMediaType }> = [];
  let pdfBase64: string | null = null;

  if (hasPdf) {
    if (typeof b.pdfBase64 !== 'string' || b.pdfBase64.length < 100) {
      return NextResponse.json({ ok: false, error: 'invalid_pdf' }, { status: 400 });
    }
    pdfBase64 = b.pdfBase64;
  } else {
    // Collect the raw page entries: multi-page `pages` array, or the legacy
    // single `{ imageBase64, mediaType }` wrapped as one page.
    let rawPages: unknown[];
    if (b.pages !== undefined) {
      if (!Array.isArray(b.pages)) {
        return NextResponse.json({ ok: false, error: 'invalid_pages' }, { status: 400 });
      }
      rawPages = b.pages;
    } else {
      rawPages = [{ imageBase64: b.imageBase64, mediaType: b.mediaType }];
    }
    if (rawPages.length < 1 || rawPages.length > MAX_PAGES) {
      return NextResponse.json(
        { ok: false, error: 'invalid_page_count', detail: `Send 1 to ${MAX_PAGES} pages.` },
        { status: 400 },
      );
    }
    // Validate each page: string of a plausible length + supported media type.
    // (Deep magic-byte / size checks happen in vision-extract's validator.)
    const normalized: Array<{ imageBase64: string; mediaType: VisionMediaType }> = [];
    for (const p of rawPages) {
      const entry = (p ?? {}) as Record<string, unknown>;
      const img = entry.imageBase64;
      const mt = entry.mediaType;
      if (typeof img !== 'string' || img.length < 100) {
        return NextResponse.json({ ok: false, error: 'invalid_image' }, { status: 400 });
      }
      if (!SUPPORTED_MEDIA_TYPES.includes(mt as VisionMediaType)) {
        return NextResponse.json({ ok: false, error: 'unsupported_media_type' }, { status: 400 });
      }
      normalized.push({ imageBase64: img, mediaType: mt as VisionMediaType });
    }
    pages = normalized;
  }

  // ── Rate limit (May 2026 audit pass-5; multi-page May extended) ─────
  // Vision calls cost $0.003-0.01 per page. Count ONE increment per image
  // page (a 5-page invoice = 5 hits) and ONE increment for a PDF (the model
  // reads all its pages in a single Anthropic call, so it's one billable
  // request regardless of page count). We increment per page BEFORE fanning
  // out the vision calls, so a request that would push the property over its
  // hourly cap is stopped (429) at the first denied page — we never fire the
  // remaining vision calls once we're over. 50/hr per property is generous
  // (Maria scanning a stack of weekly invoices); fail-open behavior on
  // Postgres errors is documented in api-ratelimit.ts.
  const increments = hasPdf ? 1 : pages.length;
  for (let i = 0; i < increments; i++) {
    const rl = await checkAndIncrementRateLimit('scan-invoice', pid);
    if (!rl.allowed) {
      return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) as NextResponse;
    }
  }

  // Security review 2026-05-16 (Pattern F — unified cost cap): vision
  // scans cost $0.003-0.01 each. Pre-flight against the daily $ budget
  // so a property hitting (e.g.) 5,000 scans/day burns out at the cap
  // instead of silently piling up Anthropic charges. We also need the
  // caller's `accounts.id` to attribute the spend (auth.userId is the
  // Supabase user, not the accounts PK that agent_costs.user_id FKs to).
  const accountId = financeGate.accountId;
  const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
  if (!budget.ok) {
    return NextResponse.json(
      { ok: false, error: budget.message, code: budget.reason },
      { status: 429 },
    ) as NextResponse;
  }

  // Capture vision usage so we can book the spend post-call. Each page's
  // callback pushes into this array (fan-out below runs the calls in
  // parallel); the finally block SUMS them into one recordNonRequestCost.
  // The callbacks run synchronously inside visionExtractJSON BEFORE any
  // truncation/empty-text throw, so even error paths bill whatever usage
  // was captured (the Anthropic calls already happened).
  const usages: VisionUsageReport[] = [];
  const captureUsage = (u: VisionUsageReport): void => { usages.push(u); };

  try {
    // Fan out ONE vision call per page IN PARALLEL. Each call carries its own
    // 55s wire-abort (see vision-extract), and this route's maxDuration is 60s
    // — running the (up to 5) pages sequentially would blow that ceiling, so
    // they MUST be parallel. A continuation page with no invoice header simply
    // returns null vendor/date/number; mergeInvoicePages handles that. The PDF
    // path is a single call (the model reads all pages internally).
    let extracted: ExtractedInvoice[];
    if (pdfBase64) {
      const one = await visionExtractJSON<ExtractedInvoice>(
        { data: pdfBase64, mediaType: 'application/pdf' },
        PROMPT,
        validateInvoice,
        captureUsage,
        'inventory.invoice_scan',
        { abortSignal: req.signal, deadlineAt: visionDeadlineAt },
      );
      extracted = [one];
    } else {
      extracted = await Promise.all(
        pages.map(p =>
          visionExtractJSON<ExtractedInvoice>(
            { data: p.imageBase64, mediaType: p.mediaType },
            PROMPT,
            validateInvoice,
            captureUsage,
            'inventory.invoice_scan',
            { abortSignal: req.signal, deadlineAt: visionDeadlineAt },
          ),
        ),
      );
    }

    // Merge the per-page extractions into one invoice: items concatenated in
    // page order, header fields = first non-null in page order.
    const result = mergeInvoicePages(extracted);

    // Defensive normalization — coerce numbers, drop malformed rows. NaN
    // and non-finite values from the model are mapped to null/0 so we never
    // persist garbage into the database.
    const safeNumOrNull = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const safeIntOrNull = (v: unknown): number | null => {
      const n = safeNumOrNull(v);
      return n == null ? null : Math.max(0, Math.trunc(n));
    };
    const items = (Array.isArray(result.items) ? result.items : [])
      .map(it => {
        const qtyCases = safeIntOrNull(it.quantity_cases);
        const packSize = safeIntOrNull(it.pack_size);
        // If the model gave us cases + pack size but a stale quantity (or
        // forgot to multiply), prefer the resolved math.
        const declaredQty = Number(it.quantity ?? 0);
        const computedQty = qtyCases != null && packSize != null && packSize > 0
          ? qtyCases * packSize
          : null;
        const qtyRaw = computedQty ?? declaredQty;
        return {
          item_name: String(it.item_name ?? '').trim(),
          quantity: Number.isFinite(qtyRaw) ? Math.max(0, qtyRaw) : 0,
          quantity_cases: qtyCases,
          pack_size: packSize,
          unit_cost: safeNumOrNull(it.unit_cost),
          total_cost: safeNumOrNull(it.total_cost),
        };
      })
      .filter(it => it.item_name.length > 0 && it.quantity > 0);

    return NextResponse.json({
      ok: true,
      vendor_name: result.vendor_name ?? null,
      invoice_date: result.invoice_date ?? null,
      invoice_number: result.invoice_number ?? null,
      items,
    });
  } catch (e) {
    // Surface "invoice too complex" as a distinct, actionable error so
    // the cockpit can show a "scan fewer pages" hint instead of a generic
    // vision_failed. Now that multi-page + PDF exist, the message points at
    // the real fix: fewer pages per scan / one page per photo. (May 2026
    // audit pass-4; message updated for the multi-page contract.)
    if (e instanceof AiFeatureDisabledError) {
      // Admin kill switch — an intentional state, not an outage. No error log.
      return NextResponse.json(
        { ok: false, error: 'feature_disabled', detail: 'This AI feature is currently turned off.' },
        { status: 503 },
      );
    }
    if (e instanceof VisionTruncatedError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'invoice_too_complex',
          detail: 'One page had more line items than we can read in a single pass. Scan fewer pages at a time — one page per photo — and try again.',
        },
        { status: 422 },
      );
    }
    // Image (or PDF) rejected by validation in vision-extract.ts. Surface the
    // specific reason — these are user-actionable ("file too large",
    // "wrong format") and don't leak any internal detail.
    if (e instanceof VisionImageInvalidError) {
      return NextResponse.json(
        { ok: false, error: 'invalid_image', detail: e.message },
        { status: 400 },
      );
    }
    // Schema-validation failure — model returned JSON that didn't match
    // the expected ExtractedInvoice shape. Stable, content-free 422.
    if (e instanceof VisionSchemaError) {
      log.warn('[scan-invoice] vision JSON failed schema validation', {
        reason: e.reason, pid,
      });
      return NextResponse.json(
        { ok: false, error: 'invoice_extract_invalid_shape' },
        { status: 422 },
      );
    }
    const msg = errToString(e);
    // Map common upstream errors to friendlier client codes.
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    // Codex audit pass-6: don't echo upstream error detail to clients —
    // it can leak prompt fragments, model output, or internal config.
    // Log server-side and return a stable client message.
    log.error('[scan-invoice] vision call failed', {
      err: e instanceof Error ? e : new Error(msg),
      pid,
    });
    return NextResponse.json(
      { ok: false, error: status === 503 ? 'vision_unavailable' : 'vision_failed' },
      { status },
    );
  } finally {
    // Security review 2026-05-16 (Pattern F): record actual Anthropic
    // spend even on error paths. The cost was already incurred by the
    // time the response arrived — billing-honest = bill it. Caps
    // depend on agent_costs being authoritative for today's spend.
    //
    // Multi-page: SUM every page's usage into a single ledger row. Some
    // pages may have failed (Promise.all rejects on the first, but earlier
    // pages' callbacks already fired) — record whatever was captured so we
    // never under-bill a call Anthropic already ran.
    if (usages.length > 0 && accountId) {
      const tokensIn = usages.reduce((s, u) => s + u.inputTokens, 0);
      const tokensOut = usages.reduce((s, u) => s + u.outputTokens, 0);
      const cachedInputTokens = usages.reduce((s, u) => s + u.cachedInputTokens, 0);
      const costUsd = usages.reduce((s, u) => s + u.costUsd, 0);
      const { model, modelId } = usages[0];
      try {
        await recordNonRequestCost({
          userId: accountId,
          propertyId: pid,
          conversationId: null,
          model,
          modelId,
          tokensIn,
          tokensOut,
          cachedInputTokens,
          costUsd,
          kind: 'vision',
        });
      } catch (costErr) {
        // 2026-05-22 audit (Codex): cost-ledger failure previously only
        // hit log.error. The Anthropic call already happened (we owe
        // Anthropic the spend) but agent_costs has no row, so subsequent
        // assertAudioBudget calls see a stale daily total and the cap
        // loses fidelity for the rest of the UTC day. Now we:
        //   - log.error with full unrecorded-spend metadata (manual
        //     reconciliation surface),
        //   - captureException to Sentry so a single failure pages,
        //   - write a durable app_events row so an operator can sum
        //     across these rows + agent_costs to recover the real total.
        // We do NOT 500 the user — the vision result already returned.
        const errObj = costErr instanceof Error ? costErr : new Error(String(costErr));
        log.error('[scan-invoice] cost-ledger write failed', {
          err: errObj,
          pid, accountId,
          unrecorded: { tokensIn, tokensOut, costUsd, modelId },
        });
        captureException(errObj, {
          subsystem: 'cost-ledger',
          route: 'scan-invoice',
          severity: 'high',
          pid, accountId,
          cost_usd: costUsd,
        });
        try {
          await supabaseAdmin.from('app_events').insert({
            property_id: pid,
            event_type: 'cost_ledger_failure',
            metadata: {
              route: 'scan-invoice',
              accountId,
              model,
              modelId,
              tokensIn,
              tokensOut,
              costUsd,
            },
          });
        } catch { /* Sentry already paged; durable fallback best-effort */ }
      }
    }
  }
}
