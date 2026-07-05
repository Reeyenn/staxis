/**
 * doc_ocr workflow handler — turn a scanned PDF / uploaded photo into searchable
 * text with Claude vision, entirely off the Vercel box.
 *
 * Why here (and not in a Vercel route): a scanned PDF can be dozens of pages;
 * one vision call per page at ~5-15s each blows past Vercel's 60s function
 * ceiling. The Fly worker has a 10-min per-job budget and its own cost caps.
 *
 * Flow (no-driver kind — owns no PMS browser):
 *   1. Budget guard: if today's OCR spend for the property is over the
 *      $2/property/day cap, DEFER (non-counting reschedule) — drain later.
 *   2. Download the file from the private knowledge-docs bucket (service role).
 *   3. PDF → rasterize each page to PNG at ~150 DPI via mupdf (pure wasm — see
 *      note below). Image → use the bytes as-is.
 *   4. Cap at 60 pages: beyond that, transcribe the first 60 and mark partial.
 *   5. One Claude vision call per page (claude-sonnet-4-6), strict verbatim
 *      transcription. Concatenate with [Page N] markers.
 *   6. POST the text to /api/internal/knowledge/ocr-complete (Bearer
 *      CRON_SECRET), which runs the chunk→embed→search pipeline.
 *   7. On unrecoverable failure: set the doc's extraction_status = 'failed'
 *      with a plain-English extract_error.
 *
 * Rasterizer choice — mupdf (Artifex, npm `mupdf`):
 *   The Fly runtime image is mcr.microsoft.com/playwright:v1.59.1-jammy. It has
 *   Chromium but NO PDF-rasterization native libs (no libvips/canvas/poppler),
 *   and adding a native addon means chasing glibc/build-deps in the image. mupdf
 *   is pure WebAssembly with ZERO native dependencies — it runs anywhere Node 20
 *   runs, including this image, with no extra system packages. Verified locally
 *   on Node 20.20 (opens a PDF, renders a page to a valid PNG). See the unit test
 *   doc-ocr-handler.test.ts which rasterizes a real PDF end-to-end.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { WorkflowContext } from './workflow-runtime.js';
import { env } from './env.js';
import { log } from './log.js';

// ─── Tunables ──────────────────────────────────────────────────────────────
/** $/property/day OCR ceiling. Over this → defer (non-counting reschedule). */
export const OCR_PROPERTY_DAILY_USD = 2.0;
/** Pages beyond this are dropped; the doc is marked `partial`. */
export const OCR_MAX_PAGES = 60;
/** Rasterize at ~150 DPI (PDFs are 72 DPI native → scale = 150/72). */
const OCR_DPI = 150;
/** Model — cheap enough at ~1¢/page, strong enough to transcribe a scan. */
export const OCR_MODEL = 'claude-sonnet-4-6';
/** Cap output tokens per page — a dense page is ~1-2k tokens of text. */
const OCR_MAX_OUTPUT_TOKENS = 4096;
const OCR_BUCKET = 'knowledge-docs';

/** Image mimes we OCR as-is (no rasterization). Mirrors the web side. */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** The strict verbatim-transcription prompt. No commentary, no summarizing. */
export const OCR_SYSTEM_PROMPT =
  'You are a precise document transcriber. Transcribe ALL visible text in the ' +
  'image EXACTLY as it appears, in reading order. Preserve tables as plain-text ' +
  'rows (separate cells with " | "). Preserve headings, lists, and line breaks. ' +
  'Do NOT summarize, explain, translate, correct, or add any commentary. Do NOT ' +
  'wrap the output in code fences. If the image has no legible text, reply with ' +
  'the single word: [no text]. Output only the transcription.';

export interface DocOcrPayload {
  propertyId: string;
  documentId: string;
  filePath: string;
  mime: string;
}

/** A page rendered to a base64 PNG ready for a vision call. */
export interface OcrPageImage {
  /** 1-based page number (for the [Page N] marker). */
  page: number;
  /** base64-encoded PNG bytes. */
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

// ─── Pure helpers (unit-tested without supabase/anthropic) ───────────────────

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
  return { propertyId, documentId, filePath, mime };
}

/** Is this an OCR-able image mime (vs. a PDF to rasterize)? */
export function isOcrImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/**
 * Rasterize PDF bytes to per-page PNGs at ~150 DPI using mupdf (pure wasm).
 * Returns { pages, totalPages, capped } — pages is capped at OCR_MAX_PAGES; when
 * capped is true the doc has more pages than we transcribed → `partial`.
 */
export async function rasterizePdf(bytes: Uint8Array): Promise<{ pages: OcrPageImage[]; totalPages: number; capped: boolean }> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const totalPages = doc.countPages();
    const limit = Math.min(totalPages, OCR_MAX_PAGES);
    const scale = OCR_DPI / 72;
    const matrix = mupdf.Matrix.scale(scale, scale);
    const pages: OcrPageImage[] = [];
    for (let i = 0; i < limit; i++) {
      const page = doc.loadPage(i);
      // alpha=false (opaque white background), showExtras=true (annotations/widgets).
      const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        const png = pix.asPNG();
        pages.push({ page: i + 1, base64: Buffer.from(png).toString('base64'), mediaType: 'image/png' });
      } finally {
        // Free the wasm-heap objects eagerly. A 150-DPI full-page pixmap is
        // multi-MB; leaning on GC/finalizers across a 60-page loop grows the
        // wasm heap enough to trip the worker's 80% RAM auto-restart.
        pix.destroy();
        page.destroy();
      }
    }
    return { pages, totalPages, capped: totalPages > OCR_MAX_PAGES };
  } finally {
    doc.destroy();
  }
}

/** Concatenate per-page transcripts with [Page N] markers, dropping empties. */
export function joinPageTranscripts(parts: { page: number; text: string }[]): string {
  const NO_TEXT = /^\s*\[no text\]\s*$/i;
  return parts
    .map((p) => {
      const t = (p.text ?? '').trim();
      if (!t || NO_TEXT.test(t)) return null;
      return `[Page ${p.page}]\n${t}`;
    })
    .filter((s): s is string => s !== null)
    .join('\n\n');
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
 * scan; the per-job + per-page bounds still cap a single run.
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
 * Record one page's OCR spend into claude_usage_log directly (workload
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
  propertyId: string; jobId: string; documentId: string; page: number;
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
      metadata: { phase: 'doc_ocr', documentId: opts.documentId, page: opts.page },
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
 * Transcribe one page image with Claude vision. Returns the text + token usage.
 * Throws on an API error so the caller can decide fail vs. defer.
 */
async function transcribePage(img: OcrPageImage, signal: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { anthropic } = await import('./anthropic-client.js');
  const params = {
    model: OCR_MODEL,
    max_tokens: OCR_MAX_OUTPUT_TOKENS,
    system: OCR_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } },
          { type: 'text' as const, text: 'Transcribe this page.' },
        ],
      },
    ],
  };
  const resp = await anthropic.messages.create(params, signal ? { signal } : undefined);
  const text = (resp.content ?? [])
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return {
    text,
    inputTokens: resp.usage?.input_tokens ?? 0,
    outputTokens: resp.usage?.output_tokens ?? 0,
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
  const { propertyId, documentId, filePath, mime } = payload;

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

  // 3. Rasterize (PDF) or use image bytes as-is.
  let images: OcrPageImage[];
  let capped = false;
  try {
    if (isOcrImageMime(mime)) {
      const media = mime === 'image/png' ? 'image/png' : mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
      images = [{ page: 1, base64: Buffer.from(bytes).toString('base64'), mediaType: media }];
    } else {
      const r = await rasterizePdf(bytes);
      images = r.pages;
      capped = r.capped;
    }
  } catch (e) {
    log.warn('doc-ocr: rasterize failed', { err: e instanceof Error ? e.message : String(e), documentId });
    await markDocFailed(documentId, propertyId, 'Couldn\'t open this scan for reading — it may be corrupt or password-protected.');
    return { ok: false, error: 'rasterize failed' };
  }

  if (images.length === 0) {
    await markDocFailed(documentId, propertyId, 'This scan had no pages to read.');
    return { ok: false, error: 'no pages' };
  }

  // 4-5. Transcribe each page. Record spend per page (workload 'cua_extraction')
  // so the budget guard sees it and the Money tab attributes it.
  const parts: { page: number; text: string }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const { computeCostMicros } = await import('./usage-pricing.js');
  let costMicros = 0;
  for (const img of images) {
    if (ctx.signal.aborted) {
      // Timed out mid-run. Don't mark failed — a defer lets it re-run cleanly
      // (idempotent: indexOcrText clears chunks first). Bounded by DEFER_MAX_AGE.
      return { ok: false, defer: true, error: 'aborted (timeout) mid-transcription — will retry' };
    }
    let pageOut: { text: string; inputTokens: number; outputTokens: number };
    try {
      pageOut = await transcribePage(img, ctx.signal);
    } catch (e) {
      log.warn('doc-ocr: page transcription failed', {
        err: e instanceof Error ? e.message : String(e), documentId, page: img.page,
      });
      await markDocFailed(documentId, propertyId, 'AI couldn\'t read this scan — please try a clearer copy.');
      return { ok: false, error: `page ${img.page} transcription failed` };
    }
    parts.push({ page: img.page, text: pageOut.text });
    inputTokens += pageOut.inputTokens;
    outputTokens += pageOut.outputTokens;
    const usage = { input_tokens: pageOut.inputTokens, output_tokens: pageOut.outputTokens };
    const pageCostMicros = computeCostMicros(usage, OCR_MODEL);
    costMicros += pageCostMicros;
    // Per-page spend log — keeps the running per-property daily total fresh so
    // the next job's budget guard is accurate. Written directly (NOT via
    // logClaudeUsage) so OCR never touches the PMS $5/day session cost cap.
    await logOcrUsage({
      propertyId, jobId: ctx.jobId, documentId, page: img.page,
      inputTokens: pageOut.inputTokens, outputTokens: pageOut.outputTokens,
      costMicros: pageCostMicros,
    });
  }

  const text = joinPageTranscripts(parts);
  const costUsd = costMicros / 1_000_000;

  // 6. Hand the text to the web pipeline (chunk → embed → search).
  let posted: { ok: boolean; status: number };
  try {
    posted = await postOcrComplete({
      propertyId, documentId, text, pages: images.length,
      inputTokens, outputTokens, costUsd, partial: capped,
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
    result: { documentId, pages: images.length, capped, costUsd: Number(costUsd.toFixed(6)) },
  };
}
