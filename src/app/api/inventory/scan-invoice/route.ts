/**
 * /api/inventory/scan-invoice — extract line items from a vendor invoice
 * image (or PDF page-as-image) using Claude Vision.
 *
 * Request:
 *   { pid: string, imageBase64: string, mediaType: 'image/jpeg'|... }
 *
 * Response:
 *   { ok: true, vendor_name, invoice_date, invoice_number, items: [...] }
 *
 * Capability check: pid must be a uuid, and the route uses supabaseAdmin so
 * the property ownership check happens implicitly via the inventory write
 * paths the client makes after confirming the extraction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { visionExtractJSON, VisionTruncatedError } from '@/lib/vision-extract';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RequestBody {
  pid: string;
  imageBase64: string;
  mediaType: string;
}

interface ExtractedInvoice {
  vendor_name: string | null;
  invoice_date: string | null;
  invoice_number: string | null;
  items: Array<{
    item_name: string;
    quantity: number;          // resolved units (cases × pack_size when applicable)
    quantity_cases: number | null;
    pack_size: number | null;  // hint for the user when they wire a new item
    unit_cost: number | null;
    total_cost: number | null;
  }>;
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Anthropic Vision only accepts these four. iPhone HEIC/HEIF must be
// converted (or rejected at the picker) before reaching here.
const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

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

export async function POST(req: NextRequest) {
  // Auth gate: this route hits the Anthropic Vision API on each request.
  // Without a session check, anyone with a guessed property UUID could
  // submit unlimited images and burn through ANTHROPIC_API_KEY budget.
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const { pid, imageBase64, mediaType } = body;
  if (!isUuid(pid)) {
    return NextResponse.json({ ok: false, error: 'invalid_pid' }, { status: 400 });
  }
  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return NextResponse.json({ ok: false, error: 'invalid_image' }, { status: 400 });
  }
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType as typeof SUPPORTED_MEDIA_TYPES[number])) {
    return NextResponse.json({ ok: false, error: 'unsupported_media_type' }, { status: 400 });
  }

  // ── Rate limit (May 2026 audit pass-5) ─────────────────────────────
  // Vision calls cost $0.003-0.01 per image. Session-gated so this is
  // never anonymous spam, but a compromised session or buggy retry
  // loop in the client could fire hundreds of scans/hour with no cap.
  // 50/hr per property is generous (Maria scanning a stack of weekly
  // invoices); fail-open behavior on Postgres errors is documented in
  // api-ratelimit.ts and now visible via the doctor's api_limits_
  // writable check.
  const rl = await checkAndIncrementRateLimit('scan-invoice', pid);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) as NextResponse;
  }

  try {
    const result = await visionExtractJSON<ExtractedInvoice>(
      { data: imageBase64, mediaType: mediaType as VisionMediaType },
      PROMPT,
    );

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
    // the cockpit can show "split this invoice into pages and rescan"
    // instead of a generic vision_failed. (May 2026 audit pass-4.)
    if (e instanceof VisionTruncatedError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'invoice_too_complex',
          detail: 'This invoice has more line items than we can scan in one pass. Try splitting it into separate pages and scanning each page.',
        },
        { status: 422 },
      );
    }
    const msg = errToString(e);
    // Map common upstream errors to friendlier client codes.
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    return NextResponse.json({ ok: false, error: 'vision_failed', detail: msg }, { status });
  }
}

type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
