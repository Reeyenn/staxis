// ═══════════════════════════════════════════════════════════════════════════
// Vision extraction shim — Anthropic Claude Vision wrapper.
//
// One place where ANTHROPIC_API_KEY lives, one place where the model name is
// pinned, one place where we sanity-check the JSON shape. Both the invoice
// OCR route and the photo-count route import this so future model bumps or
// prompt tweaks happen in a single file.
//
// Returns parsed JSON or throws a structured error the API route can format
// for the client. Never logs the image content.
// ═══════════════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';

// Pin the model — the prompts in this file are calibrated for Sonnet 4-class
// vision quality. Bumping the version requires a re-test of both prompts.
const MODEL = 'claude-sonnet-4-6';

// Per-request timeout. Vision calls typically complete in 3-8s; 30s is
// generous and well under the route's 60s maxDuration so the Anthropic
// SDK fails fast (and we surface a 503) rather than hanging Vercel's
// function until the route timeout. May 2026 audit pass-5: the SDK
// defaults to no timeout, so an Anthropic API hiccup could pin our
// function memory for minutes at fleet scale.
const VISION_REQUEST_TIMEOUT_MS = 30_000;

/** Throws if ANTHROPIC_API_KEY is missing — caller catches and 500s the route. */
function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Vision features (invoice OCR, photo count) require it. ' +
      'Set in Vercel → Project Settings → Environment Variables and redeploy.',
    );
  }
  return new Anthropic({ apiKey: key, timeout: VISION_REQUEST_TIMEOUT_MS });
}

export interface VisionImage {
  /** Base64-encoded image data (no data: prefix). */
  data: string;
  /** MIME type. Anthropic Vision only accepts these four — HEIC/HEIF from
   *  iPhone Safari are NOT in the list and must be rejected at the picker
   *  with a friendly "convert to JPEG" message before reaching this layer. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

/**
 * Send an image + a text prompt to Claude. Returns the model's text response.
 * The prompt should instruct the model to return JSON; the caller is
 * responsible for parsing.
 */
/**
 * Sentinel error subclass thrown when Claude's response was truncated by
 * `max_tokens`. The caller route can catch and surface a "split the invoice"
 * message to the user instead of a generic 500. May 2026 audit pass-4
 * found we were silently failing JSON parse on invoices with 100+ items.
 */
export class VisionTruncatedError extends Error {
  constructor(public readonly tokensUsed: number, public readonly limit: number) {
    super(
      `Vision response truncated at ${tokensUsed} tokens (limit ${limit}). ` +
      `The input image likely contains more items than fit in one response. ` +
      `Split the source into pages or smaller crops and re-scan.`,
    );
    this.name = 'VisionTruncatedError';
  }
}

// May 2026 audit pass-4: bumped from 4096 to 8192. 4096 truncated
// wholesale-supplier invoices with 100+ line items, producing unclosed
// JSON that fell through the parse fallbacks to a generic "vision_failed"
// 500. 8192 covers ~150-item invoices comfortably. Any truncation that
// still happens at 8192 throws VisionTruncatedError so the route can
// surface a useful message instead of opaque parse failures.
const VISION_MAX_TOKENS = 8192;

export async function visionExtractText(
  image: VisionImage,
  prompt: string,
): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: image.data,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  // Detect truncation BEFORE returning partial text. The downstream JSON
  // parsers would otherwise hit unclosed braces and report a generic
  // "non-JSON output" error, hiding the real cause from the operator.
  if (response.stop_reason === 'max_tokens') {
    throw new VisionTruncatedError(response.usage?.output_tokens ?? 0, VISION_MAX_TOKENS);
  }

  // Concatenate any text blocks in the response (usually one).
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Vision API returned no text. Try a clearer photo.');
  }
  return text;
}

/**
 * Same as above but pulls a JSON object out of the response. Tolerates
 * common Claude output patterns:
 *   - bare JSON
 *   - JSON wrapped in ```json ... ``` fences
 *   - JSON inside any other prose (extracts first balanced { ... } block)
 */
export async function visionExtractJSON<T>(
  image: VisionImage,
  prompt: string,
): Promise<T> {
  const text = await visionExtractText(image, prompt);

  // Try direct parse first — fastest path when the model behaves.
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through */
  }

  // Strip ```json ... ``` fences.
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      /* fall through */
    }
  }

  // Extract first balanced { ... } block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
    }
  }

  throw new Error(`Vision API returned non-JSON output. First 200 chars: ${text.slice(0, 200)}`);
}
