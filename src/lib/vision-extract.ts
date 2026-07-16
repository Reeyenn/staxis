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
import type { AiFeatureKey, AiModelRef } from '@/lib/ai/types';
import { executeAiFeature, estimateAiCostUsd } from '@/lib/ai/runtime';
import { normalizeAnthropicUsage } from '@/lib/ai/usage';
import {
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_VISION_TIMEOUT_MS,
  ANTHROPIC_VISION_ABORT_MS,
} from '@/lib/external-service-config';

// Pin the model — the prompts in this file are calibrated for Sonnet 4-class
// vision quality. Bumping the version requires a re-test of both prompts.
const MODEL = 'claude-sonnet-4-6';

// Vision timeout budget. The per-attempt SDK timeout (50s) and the whole-call
// wire abort (55s) both live in external-service-config now — per that file's
// rule 1, a raw timeout number in an SDK client is a code-review red flag, so
// these are imported (ANTHROPIC_VISION_TIMEOUT_MS / ANTHROPIC_VISION_ABORT_MS)
// rather than hard-coded here. The consumer routes set maxDuration = 60, and
// the 55s abort keeps the worst case under that ceiling.
//
// Why 50s (was 30s): a real 20-line supplier invoice measures ~23s (~1600
// output tokens at ~70 tok/s). 30-plus-line invoices ran past the old 30s
// per-attempt timeout and surfaced a misleading "vision_unavailable" error.
// The old comment argued shorter-is-better-UX — a clean fail beats a long
// spinner — but that's superseded by measured reality: legitimate long
// invoices genuinely need ~45-50s, so failing them fast was failing them
// wrong.
//
// Belt-and-suspenders (audit/concurrency #16): the SDK's `timeout` option
// is a soft client-side deadline; under some HTTP-keepalive conditions the
// request can keep running on the wire (and keep billing) past it. Each call
// site also passes an `AbortSignal.timeout(ANTHROPIC_VISION_ABORT_MS)` to
// actually cut the fetch. The abort (55s) outlives one full attempt (50s) so
// the SDK timeout is the first to fire under happy-path slowness, but the
// abort is guaranteed to cut the wire — across the maxRetries=1 retry too —
// if anything wedges.
//
// Audit/external-api-hardening (May 2026): `maxRetries` was the SDK default
// of 2, which can push worst-case wall-clock past 90s — over the route's
// maxDuration. Now imported from external-service-config so it stays in
// lockstep with the main agent's budget math.

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
    timeout: ANTHROPIC_VISION_TIMEOUT_MS,
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
 * PDF source for the same vision pipeline. Anthropic accepts a whole PDF via a
 * `document` content block (claude-sonnet-4-6 supports it) — the model reads
 * every page in one call, so multi-page invoices don't need to be exploded into
 * per-page images client-side. Discriminated from VisionImage by the fixed
 * `application/pdf` mediaType so `visionExtract*` can take either.
 */
export interface VisionPdf {
  /** Base64-encoded PDF bytes (no data: prefix). */
  data: string;
  mediaType: 'application/pdf';
}

/** Either input the vision pipeline accepts. */
export type VisionSource = VisionImage | VisionPdf;

/** Narrow a VisionSource to the PDF branch. */
function isPdf(src: VisionSource): src is VisionPdf {
  return src.mediaType === 'application/pdf';
}

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

// ── PDF validation ─────────────────────────────────────────────────────────
//
// Mirrors the image validation: decode the base64, sanity-check the byte
// length, and match the leading magic bytes ("%PDF-") so a mislabeled or
// garbage payload is rejected here (a friendly 400) instead of burning an
// Anthropic call. Reuses VisionImageInvalidError so route error-mapping is
// unchanged.
//
// 4MB decoded cap (tighter than the 5MB image cap): the whole request body
// travels through Vercel, which caps serverless request bodies at ~4.5MB. A
// base64 PDF is ~1.33× its decoded size, so a 4MB decoded PDF is already
// ~5.3MB on the wire — right at the edge. Keeping the decoded ceiling at 4MB
// leaves a little headroom before Vercel rejects the request outright. A real
// multi-page supplier invoice PDF is well under this.
const VISION_PDF_MAX_DECODED_BYTES = 4 * 1024 * 1024;
const VISION_PDF_MIN_DECODED_BYTES = 256;

// %PDF- — 0x25 0x50 0x44 0x46 0x2D. Every conforming PDF begins with this
// header (optionally after a few junk bytes, but real exports lead with it).
function pdfMagicOk(b: Uint8Array): boolean {
  return (
    b.length >= 5 &&
    b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d
  );
}

function validatePdf(pdf: VisionPdf): void {
  if (typeof pdf.data !== 'string' || pdf.data.length === 0) {
    throw new VisionImageInvalidError('empty PDF data');
  }
  // Reject data-URL prefixes — callers must strip them first (same trap as the
  // image path: a sneaked-in "data:application/pdf;base64," corrupts the decode
  // and masks the magic-byte check).
  if (pdf.data.startsWith('data:')) {
    throw new VisionImageInvalidError('data URL prefix not allowed; pass raw base64');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(pdf.data, 'base64');
  } catch {
    throw new VisionImageInvalidError('not valid base64');
  }
  if (decoded.length < VISION_PDF_MIN_DECODED_BYTES) {
    throw new VisionImageInvalidError(
      `decoded payload is only ${decoded.length} bytes — too small to be a real PDF`,
    );
  }
  if (decoded.length > VISION_PDF_MAX_DECODED_BYTES) {
    throw new VisionImageInvalidError(
      `decoded PDF is ${(decoded.length / 1024 / 1024).toFixed(1)}MB; ` +
      `max is ${VISION_PDF_MAX_DECODED_BYTES / 1024 / 1024}MB. ` +
      `Split the PDF or scan fewer pages at a time.`,
    );
  }
  if (!pdfMagicOk(decoded)) {
    throw new VisionImageInvalidError(
      `payload does not start with valid PDF bytes (%PDF-) ` +
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
  /** Total input including uncached, cache creation, and cache reads. */
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  model: string;
  modelId: string | null;
  costUsd: number;
}

export interface VisionCallOptions {
  /** Caller/request cancellation, composed with the existing whole-call limit. */
  abortSignal?: AbortSignal;
  /** Optional route-owned absolute deadline. */
  deadlineAt?: number;
}

// Anthropic Sonnet 4.6 vision pricing (per 1M tokens, as of 2026-05).
// Pinned alongside MODEL so a future pricing change shows up next to
// the model bump it's tied to. Vision input tokens include the image
// token cost computed by the SDK.
const VISION_PRICE_INPUT_PER_MTOK_USD = 3.0;
const VISION_PRICE_OUTPUT_PER_MTOK_USD = 15.0;

function estimateVisionCostUsd(usage: ReturnType<typeof normalizeAnthropicUsage>): number {
  return estimateAiCostUsd({
    inputUsdPerMillionTokens: VISION_PRICE_INPUT_PER_MTOK_USD,
    outputUsdPerMillionTokens: VISION_PRICE_OUTPUT_PER_MTOK_USD,
    cachedInputUsdPerMillionTokens: VISION_PRICE_INPUT_PER_MTOK_USD * 0.1,
    cacheCreation5mInputUsdPerMillionTokens: VISION_PRICE_INPUT_PER_MTOK_USD * 1.25,
    cacheCreation1hInputUsdPerMillionTokens: VISION_PRICE_INPUT_PER_MTOK_USD * 2,
    source: 'vision-default',
    asOf: '2026-07',
  }, {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
  });
}

async function executeVisionAttempt<T>(
  client: Anthropic,
  mediaBlock: Anthropic.ContentBlockParam,
  prompt: string,
  selectedModel: AiModelRef | null,
  signal: AbortSignal,
  attemptUsages: VisionUsageReport[],
  transform: (text: string) => T,
): Promise<T> {
  const response = await client.messages.create(
    {
      model: selectedModel?.modelId ?? MODEL,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            mediaBlock,
            { type: 'text', text: prompt },
          ],
        },
      ],
    },
    { signal },
  );

  // A provider can bill a syntactically successful response even when its
  // text is truncated or fails the caller's schema. Preserve every attempt's
  // spend before validation so fallback never erases primary usage.
  const usage = normalizeAnthropicUsage(response.usage);
  attemptUsages.push({
    ...usage,
    model: selectedModel?.modelId ?? MODEL,
    modelId: response.model ?? null,
    costUsd: selectedModel?.pricing
      ? estimateAiCostUsd(selectedModel.pricing, {
          uncachedInputTokens: usage.uncachedInputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens,
          cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
        })
      : estimateVisionCostUsd(usage),
  });

  if (response.stop_reason === 'max_tokens') {
    throw new VisionTruncatedError(usage.outputTokens, VISION_MAX_TOKENS);
  }

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Vision API returned no text. Try a clearer photo.');
  return transform(text);
}

function reportVisionAttempts(
  attempts: VisionUsageReport[],
  onUsage?: (usage: VisionUsageReport) => void,
): void {
  if (!onUsage || attempts.length === 0) return;
  const last = attempts[attempts.length - 1];
  onUsage({
    inputTokens: attempts.reduce((sum, usage) => sum + usage.inputTokens, 0),
    uncachedInputTokens: attempts.reduce((sum, usage) => sum + usage.uncachedInputTokens, 0),
    outputTokens: attempts.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cachedInputTokens: attempts.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
    cacheCreationInputTokens: attempts.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0),
    cacheCreation5mInputTokens: attempts.reduce((sum, usage) => sum + usage.cacheCreation5mInputTokens, 0),
    cacheCreation1hInputTokens: attempts.reduce((sum, usage) => sum + usage.cacheCreation1hInputTokens, 0),
    costUsd: attempts.reduce((sum, usage) => sum + usage.costUsd, 0),
    model: last.model,
    modelId: last.modelId,
  });
}

async function runVisionExtraction<T>(
  source: VisionSource,
  prompt: string,
  transform: (text: string) => T,
  onUsage?: (usage: VisionUsageReport) => void,
  featureKey?: AiFeatureKey,
  opts: VisionCallOptions = {},
): Promise<T> {
  // Validate BEFORE we burn an API call. Throws VisionImageInvalidError
  // which routes catch to return a structured 400. PDFs go through the
  // parallel PDF validator (magic bytes + tighter size cap); images keep
  // the existing per-format magic-byte checks.
  if (isPdf(source)) {
    validatePdf(source);
  } else {
    validateImage(source);
  }
  // Build the media content block: a `document` block for PDFs (the model
  // reads all pages in one call), an `image` block otherwise. Both are valid
  // ContentBlockParam members in the installed SDK (@anthropic-ai/sdk 0.96.0 —
  // Base64PDFSource + DocumentBlockParam), so no assertion is needed.
  const mediaBlock: Anthropic.ContentBlockParam = isPdf(source)
    ? {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: source.data,
        },
      }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: source.mediaType,
          data: source.data,
        },
      };
  const client = getClient();
  const attempts: VisionUsageReport[] = [];
  try {
    if (!featureKey) {
      const timeoutSignal = AbortSignal.timeout(ANTHROPIC_VISION_ABORT_MS);
      const signal = opts.abortSignal
        ? AbortSignal.any([opts.abortSignal, timeoutSignal])
        : timeoutSignal;
      return await executeVisionAttempt(
        client,
        mediaBlock,
        prompt,
        null,
        signal,
        attempts,
        transform,
      );
    }
    const configured = await executeAiFeature(
      featureKey,
      'anthropic',
      (model, context) => executeVisionAttempt(
        client,
        mediaBlock,
        prompt,
        model,
        context.signal!,
        attempts,
        transform,
      ),
      {
        requirePricing: true,
        deadlineAt: opts.deadlineAt,
        deadlineMs: opts.deadlineAt === undefined ? ANTHROPIC_VISION_ABORT_MS : undefined,
        fallbackReserveMs: 18_000,
        abortSignal: opts.abortSignal,
      },
    );
    return configured.value;
  } finally {
    reportVisionAttempts(attempts, onUsage);
  }
}

export async function visionExtractText(
  source: VisionSource,
  prompt: string,
  onUsage?: (usage: VisionUsageReport) => void,
  featureKey?: AiFeatureKey,
  opts: VisionCallOptions = {},
): Promise<string> {
  return runVisionExtraction(source, prompt, (text) => text, onUsage, featureKey, opts);
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

function parseVisionJson<T>(text: string, validate?: (raw: unknown) => T): T {
  const validated = (raw: unknown): T => {
    if (validate) return validate(raw);
    return raw as T;
  };

  try {
    return validated(JSON.parse(text));
  } catch (err) {
    if (err instanceof VisionSchemaError) throw err;
  }

  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return validated(JSON.parse(fence[1]));
    } catch (err) {
      if (err instanceof VisionSchemaError) throw err;
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return validated(JSON.parse(text.slice(start, end + 1)));
    } catch (err) {
      if (err instanceof VisionSchemaError) throw err;
    }
  }

  console.warn('[vision-extract] model returned non-JSON output', {
    head: text.slice(0, 200),
  });
  throw new Error('Vision API returned non-JSON output (see server logs for diagnostic head).');
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
  source: VisionSource,
  prompt: string,
  validate?: (raw: unknown) => T,
  onUsage?: (usage: VisionUsageReport) => void,
  featureKey?: AiFeatureKey,
  opts: VisionCallOptions = {},
): Promise<T> {
  // Parsing and caller schema validation happen inside each model attempt.
  // A malformed 200 response therefore fails over just like a provider 5xx.
  return runVisionExtraction(
    source,
    prompt,
    (text) => parseVisionJson(text, validate),
    onUsage,
    featureKey,
    opts,
  );
}
