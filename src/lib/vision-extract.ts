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
import { env } from '@/lib/env';
import { ANTHROPIC_MAX_RETRIES } from '@/lib/external-service-config';

// Pin the model — the prompts in this file are calibrated for Sonnet 4-class
// vision quality. Bumping the version requires a re-test of both prompts.
const MODEL = 'claude-sonnet-4-6';

// Per-request timeout. Vision calls typically complete in 3-8s; 30s is
// generous and well under the route's 60s maxDuration so the Anthropic
// SDK fails fast (and we surface a 503) rather than hanging Vercel's
// function until the route timeout. May 2026 audit pass-5: the SDK
// defaults to no timeout, so an Anthropic API hiccup could pin our
// function memory for minutes at fleet scale.
//
// Belt-and-suspenders (audit/concurrency #16): the SDK's `timeout` option
// is a soft client-side deadline; under some HTTP-keepalive conditions
// the request can keep running on the wire (and keep billing) past it.
// Each call site also passes an `AbortSignal.timeout(VISION_ABORT_MS)`
// to actually cut the fetch. We keep the SDK timeout below the abort so
// the SDK is the first to fire under happy-path slowness, but the abort
// is guaranteed to cut the wire if anything wedges.
//
// Audit/external-api-hardening (May 2026): `maxRetries` was the SDK
// default of 2, which can push worst-case wall-clock past 90s — over the
// route's maxDuration. Now imported from external-service-config so it
// stays in lockstep with the main agent's budget math.
const VISION_REQUEST_TIMEOUT_MS = 30_000;
const VISION_ABORT_MS = 35_000;

// Module-level singleton — matches the pattern in `src/lib/agent/llm.ts` and
// `src/app/api/walkthrough/step/route.ts`. Re-instantiating `new Anthropic()`
// per call burns a TLS handshake on every invoice scan.
let _visionClient: Anthropic | null = null;

/** Throws if ANTHROPIC_API_KEY is missing — caller catches and 500s the route. */
function getClient(): Anthropic {
  if (_visionClient) return _visionClient;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Vision features (invoice OCR, photo count) require it. ' +
      'Set in Vercel → Project Settings → Environment Variables and redeploy.',
    );
  }
  _visionClient = new Anthropic({
    apiKey: key,
    timeout: VISION_REQUEST_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
  return _visionClient;
}

export interface VisionImage {
  /** Base64-encoded image data (no data: prefix). */
  data: string;
  /** MIME type. Anthropic Vision only accepts these four — HEIC/HEIF from
   *  iPhone Safari are NOT in the list and must be rejected at the picker
   *  with a friendly "convert to JPEG" message before reaching this layer. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export type VisionMediaType = VisionImage['mediaType'];

/**
 * Sentinel error subclass for image-validation failures. Routes catch this
 * to return a 400 with a friendly message instead of letting Anthropic
 * reject the request (which would burn an API call and surface an opaque
 * 5xx upstream error).
 */
export class VisionImageInvalidError extends Error {
  constructor(public readonly reason: string) {
    super(`Image rejected: ${reason}`);
    this.name = 'VisionImageInvalidError';
  }
}

// ── Image validation (Codex audit pass-6) ─────────────────────────────────
//
// Anthropic Vision charges per byte. The routes used to gate uploads only on
// `imageBase64.length > 100` — a 50MB photo or an HTML file labeled as
// image/png would sail through and burn the bill. This wrapper now decodes
// the base64, verifies the byte length is sane, and matches the leading
// magic bytes against the declared mediaType.
//
// 5MB raw is Anthropic's documented per-image hard limit; we enforce a
// slightly tighter 5MB to leave headroom for SDK encoding overhead. Modern
// phone cameras produce 2-4MB JPEGs, so 5MB covers legitimate hotel use.
const VISION_MAX_DECODED_BYTES = 5 * 1024 * 1024;
const VISION_MIN_DECODED_BYTES = 256;

const MAGIC_BYTES: Record<VisionMediaType, (bytes: Uint8Array) => boolean> = {
  // FF D8 FF — start of any JPEG variant (JFIF, EXIF, etc.).
  'image/jpeg': b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // 89 50 4E 47 0D 0A 1A 0A — PNG signature.
  'image/png': b =>
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  // RIFF....WEBP — bytes 0-3 are "RIFF", bytes 8-11 are "WEBP".
  'image/webp': b =>
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  // GIF87a or GIF89a.
  'image/gif': b =>
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
};

function validateImage(image: VisionImage): void {
  if (typeof image.data !== 'string' || image.data.length === 0) {
    throw new VisionImageInvalidError('empty image data');
  }
  // Reject obvious data-URL prefixes — callers must strip them first. A
  // sneaked-in "data:image/png;base64," prefix would corrupt the decode
  // and mask the magic-byte check.
  if (image.data.startsWith('data:')) {
    throw new VisionImageInvalidError('data URL prefix not allowed; pass raw base64');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(image.data, 'base64');
  } catch {
    throw new VisionImageInvalidError('not valid base64');
  }
  // Buffer.from(..., 'base64') silently drops invalid characters instead
  // of throwing. A garbage-in / tiny-out result is the canary that the
  // input wasn't really base64 image bytes.
  if (decoded.length < VISION_MIN_DECODED_BYTES) {
    throw new VisionImageInvalidError(
      `decoded payload is only ${decoded.length} bytes — too small to be a real image`,
    );
  }
  if (decoded.length > VISION_MAX_DECODED_BYTES) {
    throw new VisionImageInvalidError(
      `decoded payload is ${(decoded.length / 1024 / 1024).toFixed(1)}MB; ` +
      `max is ${VISION_MAX_DECODED_BYTES / 1024 / 1024}MB. ` +
      `Re-take the photo at a lower resolution or compress before upload.`,
    );
  }
  const check = MAGIC_BYTES[image.mediaType];
  if (!check) {
    throw new VisionImageInvalidError(`unsupported mediaType: ${image.mediaType}`);
  }
  if (!check(decoded)) {
    throw new VisionImageInvalidError(
      `payload does not start with valid ${image.mediaType} bytes ` +
      `(file may be corrupt or mislabeled)`,
    );
  }
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

/**
 * Usage payload emitted by the optional onUsage callback. Routes that
 * record cost (via `recordNonRequestCost`) capture this to book the
 * Anthropic Vision spend against the daily budget.
 *
 * Security review 2026-05-16 (Pattern F): without this callback, vision
 * call sites had no clean way to record spend in `agent_costs`, so the
 * daily cap (`assertAudioBudget`) never saw vision usage. Each scan
 * cost ~$0.003-0.01 — small but uncapped at the $ layer (only the
 * hourly 50-count rate limit caught abuse). Now routes assert the
 * budget pre-flight + record the actual spend post-call.
 */
export interface VisionUsageReport {
  inputTokens: number;
  outputTokens: number;
  model: string;
  modelId: string | null;
  costUsd: number;
}

// Anthropic Sonnet 4.6 vision pricing (per 1M tokens, as of 2026-05).
// Pinned alongside MODEL so a future pricing change shows up next to
// the model bump it's tied to. Vision input tokens include the image
// token cost computed by the SDK.
const VISION_PRICE_INPUT_PER_MTOK_USD = 3.0;
const VISION_PRICE_OUTPUT_PER_MTOK_USD = 15.0;

function estimateVisionCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * VISION_PRICE_INPUT_PER_MTOK_USD +
    (outputTokens / 1_000_000) * VISION_PRICE_OUTPUT_PER_MTOK_USD
  );
}

export async function visionExtractText(
  image: VisionImage,
  prompt: string,
  onUsage?: (usage: VisionUsageReport) => void,
): Promise<string> {
  // Validate BEFORE we burn an API call. Throws VisionImageInvalidError
  // which routes catch to return a structured 400.
  validateImage(image);
  const client = getClient();
  const response = await client.messages.create(
    {
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
    },
    // Hard wire-level abort (audit/concurrency #16). Without this an
    // Anthropic outage could leave the underlying fetch running past
    // VISION_REQUEST_TIMEOUT_MS, still billing tokens for a response
    // nobody is waiting for.
    { signal: AbortSignal.timeout(VISION_ABORT_MS) },
  );

  // Capture usage for the optional callback BEFORE any error-throw — so
  // a truncation/empty-text error path STILL bills the cost (we did pay
  // Anthropic for the tokens). The callback runs synchronously so the
  // caller's recordNonRequestCost happens before we throw.
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  if (onUsage) {
    onUsage({
      inputTokens,
      outputTokens,
      model: MODEL,
      modelId: response.model ?? null,
      costUsd: estimateVisionCostUsd(inputTokens, outputTokens),
    });
  }

  // Detect truncation BEFORE returning partial text. The downstream JSON
  // parsers would otherwise hit unclosed braces and report a generic
  // "non-JSON output" error, hiding the real cause from the operator.
  if (response.stop_reason === 'max_tokens') {
    throw new VisionTruncatedError(outputTokens, VISION_MAX_TOKENS);
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
 * Sentinel error subclass thrown when the model returned valid JSON but
 * the shape did not pass the caller's runtime validator. Routes catch
 * this to return a 422 with a stable error code; the offending model
 * output is logged server-side, never sent to the client.
 */
export class VisionSchemaError extends Error {
  constructor(public readonly reason: string) {
    super(`Vision JSON failed schema validation: ${reason}`);
    this.name = 'VisionSchemaError';
  }
}

/**
 * Same as above but pulls a JSON object out of the response. Tolerates
 * common Claude output patterns:
 *   - bare JSON
 *   - JSON wrapped in ```json ... ``` fences
 *   - JSON inside any other prose (extracts first balanced { ... } block)
 *
 * Codex audit pass-6 P1 — the previous version cast the parsed value
 * straight to `T` with no runtime check. Malformed-but-syntactically-
 * valid output (a JSON `null`, an array where an object was expected,
 * a missing required field) would either crash downstream code or
 * silently pass garbage. Callers can now pass `validate` to assert
 * the shape; the validator either returns the typed value or throws
 * VisionSchemaError. Backwards-compatible: omit `validate` to get the
 * old unchecked-cast behavior (deprecated for new callers).
 */
export async function visionExtractJSON<T>(
  image: VisionImage,
  prompt: string,
  validate?: (raw: unknown) => T,
  onUsage?: (usage: VisionUsageReport) => void,
): Promise<T> {
  const text = await visionExtractText(image, prompt, onUsage);

  const validated = (raw: unknown): T => {
    if (validate) return validate(raw);
    return raw as T;
  };

  // Try direct parse first — fastest path when the model behaves.
  try {
    return validated(JSON.parse(text));
  } catch (err) {
    if (err instanceof VisionSchemaError) throw err;
    /* fall through to fence / brace recovery */
  }

  // Strip ```json ... ``` fences.
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return validated(JSON.parse(fence[1]));
    } catch (err) {
      if (err instanceof VisionSchemaError) throw err;
      /* fall through */
    }
  }

  // Extract first balanced { ... } block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return validated(JSON.parse(text.slice(start, end + 1)));
    } catch (err) {
      if (err instanceof VisionSchemaError) throw err;
      /* fall through */
    }
  }

  // Don't echo model output to the caller — routes that surface
  // `error.message` to the browser would otherwise leak whatever the
  // model produced (potentially OCR text from a customer's invoice or
  // injected commentary). Log the head server-side for diagnostics
  // and throw a stable, content-free message.
  console.warn('[vision-extract] model returned non-JSON output', {
    head: text.slice(0, 200),
  });
  throw new Error('Vision API returned non-JSON output (see server logs for diagnostic head).');
}
