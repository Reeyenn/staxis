// ═══════════════════════════════════════════════════════════════════════════
// Knowledge OCR — reading a scanned PDF or a photographed page, server-side.
//
// ─── What this used to be, and why it broke ──────────────────────────────────
// Until 2026-07-27 this module did not read anything. It INSERTED a `doc_ocr`
// row into `workflow_jobs` and returned, trusting the Fly `cua-service` worker
// to claim it. That worker was decommissioned on 2026-07-25 (three independent
// brakes: fly.toml env, an env default, and a park-at-boot in index.ts), and
// nothing on the Vercel side has ever consumed `workflow_jobs`. So every
// scanned PDF and every uploaded photo was marked `processing`, queued to
// nobody, and sat there — with KnowledgePane showing a spinner and re-polling
// every 4 seconds, forever. It was silent: no error, no log, no doctor check.
//
// Worse, the idempotency key was stable-per-document (`doc_ocr:<docId>`) and
// nothing purges `workflow_jobs`, so a second attempt at the same document
// collided on the unique constraint, was read as "already enqueued", and set
// the document straight back to `processing`. The feature could not even
// retry its way out.
//
// ─── What it is now ──────────────────────────────────────────────────────────
// The read happens inline, in the same background pass that indexes every other
// document, through `vision-extract` — the same server-side Claude-vision seam
// the invoice and quote scanners already use. No queue, no worker, no job row.
// There is therefore no idempotency key left to burn: re-uploading a document,
// or re-indexing an existing one, simply runs again.
//
// ─── What it can and cannot read (these limits are the honest part) ──────────
// A single vision call reads the whole file — a PDF rides as a native
// `document` block, so the model sees every page without local rasterization.
// That call is bounded three ways, and each bound has a user-visible answer
// rather than a stall:
//
//   size   — vision-extract caps a PDF at 4MB decoded and an image at 5MB
//            (VISION_*_MAX_DECODED_BYTES). The hub accepts uploads up to 10MB,
//            so a big scan is genuinely possible and is refused as
//            `scan_too_large`. It is NOT refused at upload time: a 9MB PDF with
//            a real text layer is read fine and never comes near this path.
//   pages  — the response is capped at 8192 output tokens and a truncated
//            response throws away the text it had, so a long scan would spend
//            money and return nothing. DOC_OCR_MAX_PAGES refuses that BEFORE
//            the call, as `scan_too_long`.
//   money  — a per-property daily ceiling, carried over from the worker this
//            replaced, refused as `scan_budget`.
//
// Everything here is a terminal answer. Nothing in this module can leave a
// document in `processing`.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  visionExtractText,
  VisionImageInvalidError,
  VisionTruncatedError,
  VISION_MAX_DECODED_BYTES,
  VISION_PDF_MAX_DECODED_BYTES,
  type VisionSource,
  type VisionUsageReport,
} from '@/lib/vision-extract';
import { AiFeatureDisabledError, AiExecutionDeadlineError } from '@/lib/ai/runtime';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { DOC_ISSUE_MESSAGE, isImageMime, type DocIssueReason } from './types';

/** The Control Center feature that chooses the model AND books the spend. */
const OCR_FEATURE = 'knowledge.document_ocr' as const;

/**
 * Per-property daily ceiling for scan reading. Carried over unchanged from the
 * Fly worker's OCR_PROPERTY_DAILY_USD so the guardrail didn't quietly loosen
 * when the work moved on-box. A page costs roughly $0.01-0.05, so $2 is ~40+
 * documents in a day — far past normal use, tight enough that a stuck loop or
 * a bulk dump can't run up an unbounded bill.
 */
export const DOC_OCR_PROPERTY_DAILY_USD = 2.0;

/**
 * Refuse a scanned PDF longer than this without calling the model.
 *
 * The ceiling is the 8192-token response cap, not page count as such: a dense
 * page transcribes to roughly 500-800 tokens, so ~15 pages is where a response
 * starts hitting the cap. Past the cap `visionExtractText` raises
 * VisionTruncatedError and DISCARDS the partial transcript — the money is spent
 * and there is nothing to show for it. Refusing up front turns that into an
 * instant, free, actionable answer.
 *
 * Page-splitting is deliberately not attempted: reading a PDF's page count is
 * possible (unpdf), but WRITING a subset PDF needs a library this repo removed
 * on purpose (mupdf, AGPL). Pretending to support long scans by silently
 * indexing only their first pages would be the dishonest option.
 */
export const DOC_OCR_MAX_PAGES = 15;

/**
 * The transcription instruction. Deliberately plain: this is a verbatim
 * reading, not a summary — the output is chunked and embedded for search, so
 * paraphrase would make the hotel's own document unfindable by its own wording.
 *
 * The transcript is UNTRUSTED text. It flows into knowledge_chunks and can
 * later reach an agent as retrieved context, exactly like every other uploaded
 * document's text; a scan carrying "ignore your instructions" is data about
 * what the page says, never an instruction. That is pre-existing for the whole
 * knowledge hub, not new here — no document text has ever been privileged.
 */
export const OCR_PROMPT = [
  'Transcribe all readable text from this document, exactly as written.',
  'Preserve the reading order, headings, and list/table structure as plain text.',
  'Do not summarize, translate, correct, or comment on the content.',
  'If a passage is illegible, write [illegible] in its place and continue.',
  'Return only the transcription.',
].join(' ');

/**
 * Decide the final extraction_status for an OCR'd doc. `ready` only when the
 * whole transcript was indexed; `partial` if it was truncated at the text cap,
 * the page cap applied, chunking hit its cap, or embedding degraded to
 * keyword-only. Pure so the transition table is unit-testable without supabase.
 */
export function decideOcrStatus(flags: {
  truncated: boolean;
  pageCapped: boolean;
  embedPartial: boolean;
  hitChunkCap: boolean;
}): 'ready' | 'partial' {
  return flags.truncated || flags.pageCapped || flags.embedPartial || flags.hitChunkCap
    ? 'partial'
    : 'ready';
}

// ── Pre-flight: will this file fit through a single vision call? ─────────────

/** The largest decoded payload vision-extract accepts for a given mime. */
export function ocrByteLimitFor(mime: string): number {
  return isImageMime(mime) ? VISION_MAX_DECODED_BYTES : VISION_PDF_MAX_DECODED_BYTES;
}

export type OcrRefusal = { reason: DocIssueReason };

/**
 * Reject, without spending anything, a file that cannot ride one vision call.
 * Pure and exported so the size/page contract is unit-testable — these are the
 * two branches a user is most likely to actually hit.
 *
 * `pageCount` is unpdf's total for a scanned PDF, or null when unknown (images
 * are always one page, and an unknown count is not evidence of a long doc, so
 * null passes).
 */
export function checkOcrFits(input: {
  byteLength: number;
  mime: string;
  pageCount: number | null;
}): OcrRefusal | null {
  if (input.byteLength > ocrByteLimitFor(input.mime)) return { reason: 'scan_too_large' };
  if (input.pageCount !== null && input.pageCount > DOC_OCR_MAX_PAGES) {
    return { reason: 'scan_too_long' };
  }
  return null;
}

// ── Budget ───────────────────────────────────────────────────────────────────

/**
 * Today's scan-reading spend for one property, from the cost ledger. Returns
 * null when the ledger could not be read.
 *
 * Null rather than Infinity, and `scan_busy` rather than `scan_budget`: both
 * refuse the call (fail CLOSED, unlike the embedding meter's fail-open — an
 * embedding is ~$0.0005 where a vision call is up to 100x that, and a ledger
 * nobody can read is exactly where a runaway loop would go unnoticed). But the
 * two say very different things to the user. "You've hit today's limit, try
 * tomorrow" is a lie when the truth is a database hiccup that may clear in
 * seconds, and it would send someone waiting a day for nothing.
 */
export async function ocrSpendTodayUsd(propertyId: string): Promise<number | null> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('cost_usd')
    .eq('property_id', propertyId)
    .eq('feature', OCR_FEATURE)
    .gte('created_at', dayStart.toISOString());
  if (error) {
    log.warn('knowledge.ocrSpendTodayUsd failed', { err: error.message });
    return null;
  }
  return (data ?? []).reduce((acc, r) => acc + Number((r as { cost_usd?: number }).cost_usd ?? 0), 0);
}

// ── The read ─────────────────────────────────────────────────────────────────

export interface RunDocumentOcrInput {
  propertyId: string;
  documentId: string;
  /** Bytes already downloaded by the caller — indexDocument holds them, and a
   *  second storage round-trip for a 4MB file is pure latency. */
  bytes: Uint8Array;
  mime: string;
  /** accounts(id) the spend is booked against (agent_costs.user_id). */
  accountId: string;
  /** unpdf's total pages for a scanned PDF; null for images/unknown. */
  pageCount: number | null;
  /** Absolute wall-clock deadline for the vision call. The caller owns the
   *  overall budget, so it — not this module — decides how much is left. */
  deadlineAt?: number;
}

export type RunDocumentOcrResult =
  | { ok: true; text: string }
  | { ok: false; reason: DocIssueReason };

/**
 * Read a scan/photo into text. Never throws: every path returns either the
 * transcript or a reason code, so the caller can always write a terminal
 * status. Spend is booked even when the call fails partway, because the tokens
 * were still consumed.
 */
export async function runDocumentOcr(input: RunDocumentOcrInput): Promise<RunDocumentOcrResult> {
  const { propertyId, documentId, bytes, mime, accountId, pageCount } = input;

  // 1. Free refusals first — never spend on a file that cannot fit.
  const refusal = checkOcrFits({ byteLength: bytes.byteLength, mime, pageCount });
  if (refusal) {
    log.info('knowledge.runDocumentOcr refused', {
      documentId, reason: refusal.reason, bytes: bytes.byteLength, pageCount,
    });
    return { ok: false, reason: refusal.reason };
  }

  // 2. Daily ceiling. An unreadable ledger refuses too, but says so honestly.
  const spent = await ocrSpendTodayUsd(propertyId);
  if (spent === null) return { ok: false, reason: 'scan_busy' };
  if (spent >= DOC_OCR_PROPERTY_DAILY_USD) {
    log.warn('knowledge.runDocumentOcr over daily budget', { propertyId, documentId, spent });
    return { ok: false, reason: 'scan_budget' };
  }

  const source: VisionSource = isImageMime(mime)
    ? { data: Buffer.from(bytes).toString('base64'), mediaType: mime as 'image/jpeg' | 'image/png' | 'image/webp' }
    : { data: Buffer.from(bytes).toString('base64'), mediaType: 'application/pdf' };

  // 3. The call. Usage is captured even on the throwing paths (vision-extract
  //    reports in a finally), so the ledger sees tokens that were really spent.
  // Collected into an array, matching the invoice/quote scanners: a `let`
  // assigned only inside the callback reads as never-assigned to the compiler.
  const usages: VisionUsageReport[] = [];
  const captureUsage = (u: VisionUsageReport) => { usages.push(u); };

  try {
    const text = await visionExtractText(
      source,
      OCR_PROMPT,
      captureUsage,
      OCR_FEATURE,
      input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt },
    );
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: classifyOcrFailure(e, documentId) };
  } finally {
    await bookOcrSpend({ usage: usages[0] ?? null, propertyId, accountId, documentId });
  }
}

/**
 * Map a vision failure to the reason the user sees. Split out and exported so
 * the mapping is testable without a model call — the distinction that matters
 * is retryable (`scan_busy`, "upload it again") vs. structural (`scan_too_long`,
 * "split the file"): telling someone to retry a document that can never succeed
 * is the same silent dead end this module was built to remove.
 */
export function classifyOcrFailure(e: unknown, documentId?: string): DocIssueReason {
  if (e instanceof VisionTruncatedError) return 'scan_too_long';
  if (e instanceof VisionImageInvalidError) return 'scan_too_large';
  if (e instanceof AiExecutionDeadlineError) return 'scan_busy';
  // The admin switched the feature off in the Control Center. Retryable from
  // the user's side once it's back on — and honest that nothing is wrong with
  // their file.
  if (e instanceof AiFeatureDisabledError) return 'scan_busy';
  const msg = e instanceof Error ? e.message : String(e);
  // "returned no text" is vision-extract's answer for a blank/illegible page.
  if (/returned no text/i.test(msg)) return 'scan_empty';
  log.error('knowledge.runDocumentOcr failed', { documentId, err: msg });
  return 'scan_busy';
}

/** Book whatever the call actually cost. Never throws — losing the ledger entry
 *  must not cost the user their document, but it is logged at error level
 *  because unbooked spend also blinds the daily ceiling above. */
async function bookOcrSpend(opts: {
  usage: VisionUsageReport | null;
  propertyId: string;
  accountId: string;
  documentId: string;
}): Promise<void> {
  const u = opts.usage;
  if (!u || u.costUsd <= 0) return;
  try {
    await recordNonRequestCost({
      feature: OCR_FEATURE,
      userId: opts.accountId,
      propertyId: opts.propertyId,
      conversationId: null,
      model: u.model,
      modelId: u.modelId,
      tokensIn: u.inputTokens,
      tokensOut: u.outputTokens,
      cachedInputTokens: u.cachedInputTokens,
      costUsd: u.costUsd,
      kind: 'vision',
    });
  } catch (e) {
    log.error('knowledge.bookOcrSpend failed — scan spend is unrecorded', {
      documentId: opts.documentId,
      propertyId: opts.propertyId,
      costUsd: u.costUsd,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The stored `extract_error` sentence for a refusal reason. */
export function ocrIssueMessage(reason: DocIssueReason): string {
  return DOC_ISSUE_MESSAGE[reason];
}

/**
 * Which extraction_status a refusal lands on. `unsupported` ("Not
 * text-searchable") for the structural ones the file will never pass, `failed`
 * ("Couldn't read") for the ones worth trying again — the badge itself should
 * tell the two apart before the user reads a word of explanation.
 */
export function ocrStatusForReason(reason: DocIssueReason): 'failed' | 'unsupported' {
  return reason === 'scan_too_large' || reason === 'scan_too_long' ? 'unsupported' : 'failed';
}
