/**
 * /api/inventory/photo-count — estimate per-item counts from a shelf photo.
 *
 * Request:
 *   { pid: string, imageBase64: string, mediaType, itemNames: string[] }
 *
 * Response:
 *   { ok: true, counts: [{ item_name, estimated_count, confidence }] }
 *
 * Caller passes the property's tracked item names so the model can match
 * what it sees to the user's catalog. Confidence is one of high/medium/low
 * — the UI surfaces it as a colored dot next to each AI-filled value.
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
  itemNames: string[];
}

interface PhotoCountResult {
  counts: Array<{
    item_name: string;
    estimated_count: number;
    confidence: 'high' | 'medium' | 'low';
  }>;
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

function buildPrompt(itemNames: string[]): string {
  const list = itemNames.map(n => `  - ${n}`).join('\n');
  return `You are counting hotel inventory items visible in this photo.

The property tracks these items:
${list}

For each item you can identify and count in the image, return:
- item_name (must EXACTLY match one of the names from the list above — use the same capitalization and spelling)
- estimated_count (number)
- confidence ("high" | "medium" | "low")

Only return items you can actually see. If you cannot confidently count an
item (e.g., stacked linens where the quantity is unclear), set confidence to
"low" and your best guess for estimated_count.

Skip items you don't see at all — don't include them with count=0.

Return ONLY a JSON object with this exact shape, no prose, no code fences:
{
  "counts": [
    { "item_name": "...", "estimated_count": 0, "confidence": "high" }
  ]
}

If the image contains no recognizable inventory, return { "counts": [] }.`;
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const { pid, imageBase64, mediaType, itemNames } = body;
  if (!isUuid(pid)) {
    return NextResponse.json({ ok: false, error: 'invalid_pid' }, { status: 400 });
  }
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return NextResponse.json({ ok: false, error: 'invalid_image' }, { status: 400 });
  }
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType as VisionMediaType)) {
    return NextResponse.json({ ok: false, error: 'unsupported_media_type' }, { status: 400 });
  }
  if (!Array.isArray(itemNames) || itemNames.length === 0) {
    return NextResponse.json({ ok: false, error: 'no_items_in_scope' }, { status: 400 });
  }

  try {
    const result = await visionExtractJSON<PhotoCountResult>(
      { data: imageBase64, mediaType: mediaType as VisionMediaType },
      buildPrompt(itemNames.slice(0, 200)), // cap input to keep token use bounded
    );

    const allowedNames = new Set(itemNames);
    const counts = (Array.isArray(result.counts) ? result.counts : [])
      .map(c => {
        // Coerce to a non-negative integer — the model occasionally returns
        // floats (e.g. "3.5") or strings, and the input field can't display
        // a fraction sensibly. NaN and negatives become 0 via Math.max+|0.
        const raw = Number(c.estimated_count ?? 0);
        const estimated_count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
        return {
          item_name: String(c.item_name ?? '').trim(),
          estimated_count,
          confidence: (c.confidence === 'high' || c.confidence === 'medium' || c.confidence === 'low')
            ? c.confidence
            : 'low' as const,
        };
      })
      // Drop any count for an item we don't track (model hallucinated a name).
      .filter(c => c.item_name.length > 0 && allowedNames.has(c.item_name));

    return NextResponse.json({ ok: true, counts });
  } catch (e) {
    const msg = errToString(e);
    const status = /api[_ ]?key|ANTHROPIC_API_KEY/i.test(msg) ? 503 : 500;
    return NextResponse.json({ ok: false, error: 'vision_failed', detail: msg }, { status });
  }
}
