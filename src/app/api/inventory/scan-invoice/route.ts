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
import { visionExtractJSON } from '@/lib/vision-extract';
import { errToString } from '@/lib/utils';

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
    quantity: number;
    unit_cost: number | null;
    total_cost: number | null;
  }>;
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

const PROMPT = `Extract all line items from this invoice or receipt.

For each item return:
- item_name (string)
- quantity (number)
- unit_cost (number, per unit price; use null if not visible)
- total_cost (number, line total; use null if not visible)

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
    { "item_name": "...", "quantity": 0, "unit_cost": 0, "total_cost": 0 }
  ]
}

If the image is not an invoice or receipt, return { "items": [] } and null vendor/date/number.`;

export async function POST(req: NextRequest) {
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
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return NextResponse.json({ ok: false, error: 'invalid_image' }, { status: 400 });
  }
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType as typeof SUPPORTED_MEDIA_TYPES[number])) {
    return NextResponse.json({ ok: false, error: 'unsupported_media_type' }, { status: 400 });
  }

  try {
    const result = await visionExtractJSON<ExtractedInvoice>(
      { data: imageBase64, mediaType: mediaType as VisionMediaType },
      PROMPT,
    );

    // Defensive normalization — coerce numbers, drop malformed rows.
    const items = (Array.isArray(result.items) ? result.items : [])
      .map(it => ({
        item_name: String(it.item_name ?? '').trim(),
        quantity: Number(it.quantity ?? 0),
        unit_cost: it.unit_cost == null ? null : Number(it.unit_cost),
        total_cost: it.total_cost == null ? null : Number(it.total_cost),
      }))
      .filter(it => it.item_name.length > 0 && it.quantity > 0);

    return NextResponse.json({
      ok: true,
      vendor_name: result.vendor_name ?? null,
      invoice_date: result.invoice_date ?? null,
      invoice_number: result.invoice_number ?? null,
      items,
    });
  } catch (e) {
    const msg = errToString(e);
    // Map common upstream errors to friendlier client codes.
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    return NextResponse.json({ ok: false, error: 'vision_failed', detail: msg }, { status });
  }
}

type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
