/**
 * doc_ocr workflow handler — turn a scanned PDF / uploaded photo into searchable
 * text with Claude vision, entirely off the Vercel box.
 *
 * Why here (and not in a Vercel route): a scanned PDF can be dozens of pages
 * and its transcription a very large output; Vercel's 60s function ceiling
 * can't hold that. The Fly worker runs the job under a 15-min per-job timeout
 * (payload.timeout_ms, set at enqueue) with its own cost caps.
 *
 * Flow (no-driver kind — owns no PMS browser):
 *   1. Budget guard: if today's OCR spend for the property is over the
 *      $2/property/day cap, DEFER (non-counting reschedule) — drain later.
 *   2. Download the file from the private knowledge-docs bucket (service role).
 *   3. Build ONE vision request: PDFs go up as a native `document` content
 *      block (Anthropic PDF input — the API reads each page server-side;
 *      pages are billed internally as image+text tokens, ~1-2¢/page on
 *      Sonnet); images go up as a single `image` block. No local
 *      rasterization and no PDF dependency in this service at all (the
 *      earlier mupdf approach was dropped: AGPL-3.0 license — unusable in
 *      closed-source commercial SaaS).
 *   4. Page cap 60: when the payload's pageCount (computed web-side by unpdf)
 *      exceeds it, the prompt instructs "transcribe only pages 1-60" and the
 *      doc lands `partial`. API limits (32MB request / 600 pages) are far
 *      above our 10MB upload cap.
 *   5. STREAM the response (messages.stream → finalMessage) with max_tokens
 *      64000 — a 60-page transcription is a very large output and a
 *      non-streaming call would hit SDK HTTP timeouts.
 *   6. POST the text to /api/internal/knowledge/ocr-complete (Bearer
 *      CRON_SECRET), which runs the chunk→embed→search pipeline.
 *   7. Errors: TRANSIENT Anthropic failures (429 rate limit, 5xx/529 server,
 *      network, abort-timeout) DEFER — the job re-runs later without burning
 *      its attempt. Only a permanent rejection (400 — e.g. a corrupt PDF the
 *      API refuses) or a non-API failure marks the doc `failed`. Classified
 *      via the SDK's typed error classes, never by string-matching.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { WorkflowContext } from './workflow-runtime.js';
import { env } from './env.js';
import { log } from './log.js';

// ─── Tunables ──────────────────────────────────────────────────────────────
/** $/property/day OCR ceiling. Over this → defer (non-counting reschedule). */
export const OCR_PROPERTY_DAILY_USD = 2.0;
/** Pages beyond this are not transcribed; the doc is marked `partial`. */
export const OCR_MAX_PAGES = 60;
/** Model — cheap enough at ~1-2¢/page, strong enough to transcribe a scan. */
export const OCR_MODEL = 'claude-sonnet-4-6';
/** Output budget for the WHOLE transcription (one streaming call per doc).
 *  A dense page is ~1-2k tokens; 60 pages needs real headroom. */
const OCR_MAX_OUTPUT_TOKENS = 64_000;
/** Per-call HTTP timeout override (ms). The anthropic client default is 120s —
 *  tuned for short CUA turns, far too tight for a 60-page streamed
 *  transcription. 14 min stays under the job's 15-min timeout so the job-level
 *  abort (→ defer) fires first. */
const OCR_CALL_TIMEOUT_MS = 840_000;
const OCR_BUCKET = 'knowledge-docs';

/** Image mimes we OCR as a single image block. Mirrors the web side. */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** The strict verbatim-transcription prompt. No commentary, no summarizing. */
export const OCR_SYSTEM_PROMPT =
  'You are a precise document transcriber. Transcribe ALL visible text in the ' +
  'document EXACTLY as it appears, in reading order. Start each page with a ' +
  'marker line of the form [Page N] (1-based). Preserve tables as plain-text ' +
  'rows (separate cells with " | "). Preserve headings, lists, and line breaks. ' +
  'Do NOT summarize, explain, translate, correct, or add any commentary. Do NOT ' +
  'wrap the output in code fences. If the document has no legible text at all, ' +
  'reply with the single word: [no text]. Output only the transcription.';

export interface DocOcrPayload {
  propertyId: string;
  documentId: string;
  filePath: string;
  mime: string;
  /** Total pages, computed web-side by unpdf for scanned PDFs; null when
   *  unknown (images, or backfilled docs whose page count was never stored). */
  pageCount: number | null;
}

// ─── Pure helpers (unit-tested without supabase/anthropic I/O) ───────────────

/** Validate the payload shape a doc_ocr job must carry. */
export function parseDocOcrPayload(payload: Record<string, unknown>): DocOcrPayload | null {
  const propertyId = payload.propertyId;
  const documentId = payload.documentId;
  const filePath = payload.filePath;
  const mime = payload.mime;
  if (
    typeof propertyId !== 'string' || !propertyId ||
    typeof documentId !== 'string' || !documentId ||
    typeof filePath !== 'string' || !filePath ||
    typeof mime !== 'string' || !mime
  ) return null;
  const rawPages = payload.pageCount;
  const pageCount = typeof rawPages === 'number' && Number.isFinite(rawPages) && rawPages > 0
    ? Math.floor(rawPages)
    : null;
  return { propertyId, documentId, filePath, mime, pageCount };
}

/** Is this an OCR-able image mime (vs. a PDF sent as a document block)? */
export function isOcrImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/**
 * Build the user-message content for the single vision call.
 *   - PDF  → native `document` block (base64, media_type application/pdf) +
 *            a text instruction. When pageCount exceeds the 60-page cap, the
 *            instruction limits transcription to pages 1-60 and the caller
 *            marks the doc `partial`.
 *   - image → single `image` block + instruction.
 * The media block comes FIRST, the text instruction after (per PDF-input docs).
 * Pure: content shape + page-cap decision are unit-tested directly.
 */
export function buildOcrUserContent(input: {
  mime: string;
  /** base64 WITHOUT newlines (Node's Buffer.toString('base64') never inserts any). */
  base64: string;
  pageCount: number | null;
}): { content: Anthropic.Messages.ContentBlockParam[]; pageCapped: boolean } {
  if (isOcrImageMime(input.mime)) {
    const media = input.mime === 'image/png' ? 'image/png' as const
      : input.mime === 'image/webp' ? 'image/webp' as const
      : 'image/jpeg' as const;
    return {
      content: [
        { type: 'image', source: { type: 'base64', media_type: media, data: input.base64 } },
        { type: 'text', text: 'Transcribe this image.' },
      ],
      // A single image can't exceed the page cap.
      pageCapped: false,
    };
  }

  const pageCapped = (input.pageCount ?? 0) > OCR_MAX_PAGES;
  const instruction = pageCapped
    ? `This document has ${input.pageCount} pages. Transcribe ONLY pages 1 through ${OCR_MAX_PAGES}, in order, and stop there.`
    : 'Transcribe this document.';
  return {
    content: [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: input.base64 },
      },
      { type: 'text', text: instruction },
    ],
    pageCapped,
  };
}

/** Strip a lone "[no text]" sentinel; otherwise pass the transcript through. */
export function normalizeTranscript(text: string): string {
  const t = (text ?? '').trim();
  if (/^\[no text\]$/i.test(t)) return '';
  return t;
}

/**
 * Budget decision from today's already-recorded OCR spend (micro-dollars).
 * Returns 'defer' when at/over the daily cap, else 'proceed'. Pure so the
 * threshold logic is unit-testable independent of the ledger read.
 */
export function ocrBudgetDecision(spentMicrosToday: number): 'proceed' | 'defer' {
  const capMicros = OCR_PROPERTY_DAILY_USD * 1_000_000;
  return spentMicrosToday >= capMicros ? 'defer' : 'proceed';
}

/**
 * Classify a transcription-call failure using the SDK's TYPED error classes
 * (never string matching):
 *   defer — transient; the runtime re-queues without burning the attempt:
 *     • RateLimitError (429), InternalServerError (any ≥500, incl. 529 overload)
 *     • APIConnectionError (network / DNS / TLS, incl. its timeout subclass)
 *     • APIUserAbortError (the job-timeout signal fired mid-stream)
 *   fail — permanent for THIS document; mark it failed:
 *     • BadRequestError (400 — e.g. corrupt or API-rejected PDF)
 *     • anything else (auth/permission/unknown) — loud, definite failure
 *       rather than a 24h defer loop that strands the doc in `processing`.
 */
export function classifyOcrError(err: unknown): 'defer' | 'fail' {
  if (err instanceof Anthropic.RateLimitError) return 'defer';
  if (err instanceof Anthropic.InternalServerError) return 'defer';
  if (err instanceof Anthropic.APIConnectionError) return 'defer';
  if (err instanceof Anthropic.APIUserAbortError) return 'defer';
  return 'fail';
}

// ─── I/O — used only on the live Fly worker (lazy supabase import) ───────────

/** UTC day-start ISO for "today's spend" windowing (matches the web ledger). */
function utcDayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Sum today's OCR spend (micro-dollars) for a property from claude_usage_log.
 * OCR calls are logged with workload 'cua_extraction' (see runDocOcrJob). Fails
 * OPEN (returns 0) on a read error — a transient ledger read shouldn't strand a
 * scan; the per-call output cap still bounds a single run.
 */
async function ocrSpendTodayMicros(propertyId: string): Promise<number> {
  try {
    const { supabase } = await import('./supabase.js');
    const { data, error } = await supabase
      .from('claude_usage_log')
      .select('cost_micros')
      .eq('property_id', propertyId)
      .eq('workload', 'cua_extraction')
      .gte('created_at', utcDayStartIso());
    if (error || !data) return 0;
    return data.reduce((acc, r) => acc + Number((r as { cost_micros?: number }).cost_micros ?? 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Record the doc's OCR spend into claude_usage_log directly (workload
 * 'cua_extraction'), so the Money tab attributes it AND the next job's budget
 * guard (ocrSpendTodayMicros) sees it.
 *
 * We DON'T route this through logClaudeUsage on purpose: that helper also calls
 * recordSpend for non-mapping workloads, which would charge OCR against the
 * hotel's $5/day PMS session cap and could pause live PMS polling. OCR has its
 * OWN $2/property/day guard (ocrBudgetDecision) + the web-side property ledger
 * (recordNonRequestCost kind='background'), so the session cap must stay
 * OCR-free. Best-effort — a logging failure never fails a transcription.
 */
async function logOcrUsage(opts: {
  propertyId: string; jobId: string; documentId: string;
  inputTokens: number; outputTokens: number; costMicros: number;
}): Promise<void> {
  try {
    const { supabase } = await import('./supabase.js');
    const { error } = await supabase.from('claude_usage_log').insert({
      property_id: opts.propertyId,
      workload: 'cua_extraction',
      model: OCR_MODEL,
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_micros: opts.costMicros,
      job_id: opts.jobId,
      metadata: { phase: 'doc_ocr', documentId: opts.documentId },
    });
    if (error) log.warn('doc-ocr: claude_usage_log insert failed', { err: error.message });
  } catch (e) {
    log.warn('doc-ocr: logOcrUsage threw', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Download the file bytes from the private knowledge-docs bucket. */
async function downloadFile(filePath: string): Promise<Uint8Array | null> {
  try {
    const { supabase } = await import('./supabase.js');
    const { data, error } = await supabase.storage.from(OCR_BUCKET).download(filePath);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/** Best-effort: mark the doc failed directly (the web success-endpoint only
 *  handles the happy path). Never throws. */
async function markDocFailed(documentId: string, propertyId: string, message: string): Promise<void> {
  try {
    const { supabase } = await import('./supabase.js');
    await supabase
      .from('knowledge_documents')
      .update({
        extraction_status: 'failed',
        extract_error: message,
        extracted_at: new Date().toISOString(),
      })
      .eq('id', documentId)
      .eq('property_id', propertyId);
  } catch (e) {
    log.warn('doc-ocr: markDocFailed failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** POST the transcription to the web ocr-complete endpoint (Bearer CRON_SECRET). */
async function postOcrComplete(body: {
  propertyId: string; documentId: string; text: string; pages: number;
  inputTokens: number; outputTokens: number; costUsd: number; partial: boolean;
}): Promise<{ ok: boolean; status: number }> {
  const base = env.RULES_ENGINE_BASE_URL;
  const secret = env.CRON_SECRET;
  if (!base || !secret) {
    log.error('doc-ocr: cannot post ocr-complete — RULES_ENGINE_BASE_URL or CRON_SECRET unset');
    return { ok: false, status: 0 };
  }
  const res = await fetch(`${base}/api/internal/knowledge/ocr-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Transcribe the whole document in ONE streaming vision call.
 * Streaming (messages.stream → finalMessage) is required: a 60-page verbatim
 * transcription at max_tokens 64000 would blow the SDK's non-streaming HTTP
 * timeout. Throws the SDK's typed errors on failure — the caller classifies.
 */
async function transcribeDocument(
  content: Anthropic.Messages.ContentBlockParam[],
  signal: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { anthropic } = await import('./anthropic-client.js');
  const stream = anthropic.messages.stream(
    {
      model: OCR_MODEL,
      max_tokens: OCR_MAX_OUTPUT_TOKENS,
      system: OCR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    },
    // Per-call timeout override: the client default (120s) is tuned for short
    // CUA turns; a full-document streamed transcription needs the long window.
    { signal, timeout: OCR_CALL_TIMEOUT_MS },
  );
  const final = await stream.finalMessage();
  const text = (final.content ?? [])
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return {
    text,
    inputTokens: final.usage?.input_tokens ?? 0,
    outputTokens: final.usage?.output_tokens ?? 0,
  };
}

/**
 * The doc_ocr workflow handler. Registered in index.ts as a no-driver kind.
 * Returns the standard WorkflowHandler result: ok / defer / (ok:false → fail).
 */
export async function runDocOcrJob(ctx: WorkflowContext): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; defer?: boolean }> {
  const payload = parseDocOcrPayload(ctx.payload);
  if (!payload) {
    return { ok: false, error: 'doc_ocr payload missing propertyId/documentId/filePath/mime' };
  }
  const { propertyId, documentId, filePath, mime, pageCount } = payload;

  // 1. Budget guard — defer (non-counting) when over the daily cap.
  const spent = await ocrSpendTodayMicros(propertyId);
  if (ocrBudgetDecision(spent) === 'defer') {
    log.info('doc-ocr: deferring — property over daily OCR budget', {
      propertyId, documentId, spentMicros: spent, capUsd: OCR_PROPERTY_DAILY_USD,
    });
    return { ok: false, defer: true, error: 'over daily OCR budget for this property' };
  }

  // 2. Download.
  const bytes = await downloadFile(filePath);
  if (!bytes) {
    await markDocFailed(documentId, propertyId, 'Couldn\'t read the uploaded scan — please try uploading it again.');
    return { ok: false, error: 'download failed' };
  }

  // 3. Build the single vision request. Buffer.toString('base64') emits no
  // newlines — required by the PDF-input API.
  const { content, pageCapped } = buildOcrUserContent({
    mime, base64: Buffer.from(bytes).toString('base64'), pageCount,
  });

  if (ctx.signal.aborted) {
    // Claimed right at the timeout boundary — defer, don't burn the attempt.
    return { ok: false, defer: true, error: 'aborted before transcription — will retry' };
  }

  // 4-5. One streaming transcription call for the whole document.
  let out: { text: string; inputTokens: number; outputTokens: number };
  try {
    out = await transcribeDocument(content, ctx.signal);
  } catch (e) {
    const cls = classifyOcrError(e);
    log.warn('doc-ocr: transcription failed', {
      err: e instanceof Error ? e.message : String(e), documentId, classification: cls,
    });
    if (cls === 'defer') {
      return { ok: false, defer: true, error: 'transient AI error during transcription — will retry' };
    }
    await markDocFailed(documentId, propertyId, 'AI couldn\'t read this scan — it may be corrupt, password-protected, or unreadable.');
    return { ok: false, error: 'transcription rejected' };
  }

  // Log the spend ONCE from the final message's usage.
  const { computeCostMicros } = await import('./usage-pricing.js');
  const usage = { input_tokens: out.inputTokens, output_tokens: out.outputTokens };
  const costMicros = computeCostMicros(usage, OCR_MODEL);
  await logOcrUsage({
    propertyId, jobId: ctx.jobId, documentId,
    inputTokens: out.inputTokens, outputTokens: out.outputTokens, costMicros,
  });

  const text = normalizeTranscript(out.text);
  const costUsd = costMicros / 1_000_000;
  const pages = pageCapped ? OCR_MAX_PAGES : (pageCount ?? 1);

  // 6. Hand the text to the web pipeline (chunk → embed → search).
  let posted: { ok: boolean; status: number };
  try {
    posted = await postOcrComplete({
      propertyId, documentId, text, pages,
      inputTokens: out.inputTokens, outputTokens: out.outputTokens, costUsd, partial: pageCapped,
    });
  } catch (e) {
    log.warn('doc-ocr: ocr-complete POST threw', { err: e instanceof Error ? e.message : String(e), documentId });
    // The transcription itself succeeded; a transient web-side hiccup shouldn't
    // burn the (single) attempt — defer so it re-posts once the web app is back.
    return { ok: false, defer: true, error: 'ocr-complete POST failed (transient) — will retry' };
  }
  if (!posted.ok) {
    if (posted.status >= 500 || posted.status === 0 || posted.status === 429) {
      // Transient web-side failure — defer and re-post later.
      return { ok: false, defer: true, error: `ocr-complete returned ${posted.status} — will retry` };
    }
    // A 4xx (bad request / not found) is not going to fix itself on retry.
    await markDocFailed(documentId, propertyId, 'Finished reading the scan, but saving it for search failed.');
    return { ok: false, error: `ocr-complete returned ${posted.status}` };
  }

  return {
    ok: true,
    result: { documentId, pages, capped: pageCapped, costUsd: Number(costUsd.toFixed(6)) },
  };
}
