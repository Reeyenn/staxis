// ═══════════════════════════════════════════════════════════════════════════
// Knowledge OCR enqueue — the bridge from the web app to the Fly vision worker.
//
// A scanned PDF or an uploaded photo can't be read by unpdf/mammoth (no text
// layer), and multi-page vision OCR is far too slow for the upload route's
// after() hook (maxDuration 60s). So instead of dead-ending the doc as
// `unsupported`, indexDocument sets it to `processing` and enqueues a
// `doc_ocr` row into workflow_jobs. The Fly cua-service worker claims it,
// rasterizes + transcribes each page with Claude vision, and POSTs the text
// back to /api/internal/knowledge/ocr-complete — which runs the SAME
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
  const { propertyId, documentId, filePath, mime } = input;
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

    // Stable-per-doc idempotency key: one logical OCR job per document. A
    // re-index of the same doc collides on the unique constraint (23505) rather
    // than spawning a second run — which we treat as "already enqueued".
    const idempotencyKey = `${DOC_OCR_JOB_KIND}:${documentId}`;
    const { error: insErr } = await supabaseAdmin
      .from('workflow_jobs')
      .insert({
        property_id: propertyId,
        kind: DOC_OCR_JOB_KIND,
        idempotency_key: idempotencyKey,
        // OCR is a single self-contained pass; the budget guard defers (no
        // attempt burned) when over cap, so one real attempt is right — a
        // genuine failure should surface, not silently retry forever.
        max_attempts: 1,
        triggered_by: 'knowledge:index',
        payload: { propertyId, documentId, filePath, mime },
      });
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
