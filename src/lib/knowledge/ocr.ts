// ═══════════════════════════════════════════════════════════════════════════
// Knowledge OCR enqueue — the bridge from the web app to the Fly vision worker.
//
// A scanned PDF or an uploaded photo can't be read by unpdf/mammoth (no text
// layer), and a whole-document vision transcription is far too slow for the
// upload route's after() hook (maxDuration 60s). So instead of dead-ending the
// doc as `unsupported`, indexDocument sets it to `processing` and enqueues a
// `doc_ocr` row into workflow_jobs. The Fly cua-service worker claims it, sends
// the PDF/image to Claude vision in ONE call (native PDF input — no local
// rasterization), and POSTs the text back to
// /api/internal/knowledge/ocr-complete — which runs the SAME
// chunk→embed→search pipeline the normal path uses.
//
// workflow_jobs.kind is free-text (no CHECK constraint — see migration 0201),
// so `doc_ocr` needs no schema change to flow through the existing queue.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

/** The workflow_jobs.kind the Fly OCR handler claims. */
export const DOC_OCR_JOB_KIND = 'doc_ocr';

/**
 * Per-job timeout the worker runtime honors via payload.timeout_ms (the
 * no-driver lane's pickMapperTimeoutMs reads the override). 15 min: one
 * streamed whole-document vision transcription comfortably fits; without this
 * the no-driver default is the mapper's 90 min — far too generous for OCR.
 */
export const DOC_OCR_TIMEOUT_MS = 900_000;

/**
 * Decide the final extraction_status for an OCR'd doc. `ready` only when the
 * whole transcript was indexed; `partial` if it was truncated at the text cap,
 * the worker hit its page cap, chunking hit its cap, or embedding degraded to
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

export interface EnqueueOcrInput {
  propertyId: string;
  documentId: string;
  filePath: string;
  mime: string;
  /** Total pages (from unpdf) for scanned PDFs; null when unknown (images).
   *  The worker uses it for the 60-page cap instruction + the partial flag. */
  pageCount?: number | null;
}

/**
 * Build the workflow_jobs row a doc_ocr enqueue inserts. Pure — the payload
 * contract with the Fly worker (pageCount passthrough, the 15-min timeout_ms
 * override, stable-per-doc idempotency key, single attempt) is unit-testable
 * without supabase.
 */
export function buildDocOcrJobRow(input: EnqueueOcrInput): {
  property_id: string;
  kind: string;
  idempotency_key: string;
  max_attempts: number;
  triggered_by: string;
  payload: {
    propertyId: string;
    documentId: string;
    filePath: string;
    mime: string;
    pageCount: number | null;
    timeout_ms: number;
  };
} {
  return {
    property_id: input.propertyId,
    kind: DOC_OCR_JOB_KIND,
    // Stable-per-doc idempotency key: one logical OCR job per document. A
    // re-index of the same doc collides on the unique constraint (23505) rather
    // than spawning a second run — which the caller treats as "already enqueued".
    idempotency_key: `${DOC_OCR_JOB_KIND}:${input.documentId}`,
    // OCR is a single self-contained pass; the worker defers (no attempt
    // burned) on budget/transient-API failures, so one real attempt is right —
    // a genuine permanent failure should surface, not silently retry forever.
    max_attempts: 1,
    triggered_by: 'knowledge:index',
    payload: {
      propertyId: input.propertyId,
      documentId: input.documentId,
      filePath: input.filePath,
      mime: input.mime,
      pageCount: input.pageCount ?? null,
      timeout_ms: DOC_OCR_TIMEOUT_MS,
    },
  };
}

/**
 * Enqueue a doc_ocr worker job for a scan/photo, unless one is already in
 * flight for this document. Returns whether a job now exists (either freshly
 * enqueued or an existing unfinished one) so the caller can decide the doc's
 * status. Never throws — a failed enqueue is logged and reported as false so
 * indexDocument can fall back to a definite terminal state instead of stranding
 * the doc in `processing` with no worker job.
 *
 * Dedupe: skip if a queued/running doc_ocr job already exists for the doc. The
 * workflow_jobs (property_id, idempotency_key) unique constraint is the DB-level
 * backstop; this pre-check avoids a churn of failed inserts and keeps the
 * idempotency_key stable-per-doc so a re-index doesn't spawn a duplicate run.
 */
export async function enqueueOcrJob(input: EnqueueOcrInput): Promise<boolean> {
  const { propertyId, documentId } = input;
  try {
    // Already an unfinished OCR job for this doc? Reuse it.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('workflow_jobs')
      .select('id, status')
      .eq('property_id', propertyId)
      .eq('kind', DOC_OCR_JOB_KIND)
      .contains('payload', { documentId })
      .in('status', ['queued', 'running'])
      .limit(1)
      .maybeSingle();
    if (exErr) {
      // A read failure shouldn't block the enqueue — fall through and let the
      // unique constraint dedupe if a race actually double-inserts.
      log.warn('knowledge.enqueueOcrJob dedupe read failed', { err: exErr.message });
    } else if (existing) {
      return true; // an OCR job is already in flight for this doc
    }

    const { error: insErr } = await supabaseAdmin
      .from('workflow_jobs')
      .insert(buildDocOcrJobRow(input));
    if (insErr) {
      // 23505 = unique_violation → a job for this doc already exists (race or
      // re-index). That's a success for our purposes: an OCR job IS enqueued.
      if ((insErr as { code?: string }).code === '23505') return true;
      log.error('knowledge.enqueueOcrJob insert failed', { err: insErr.message });
      return false;
    }
    return true;
  } catch (e) {
    log.error('knowledge.enqueueOcrJob threw', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
