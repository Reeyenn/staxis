/**
 * POST /api/internal/knowledge/ocr-complete
 *
 * The Fly cua-service vision worker calls this after it has transcribed a
 * scanned PDF / photo. Body:
 *   { propertyId, documentId, text, pages, inputTokens, outputTokens, costUsd, partial? }
 *
 * We run the SAME chunk→embed→search pipeline the normal upload path uses
 * (indexOcrText — reusing the functions in src/lib/knowledge/indexing.ts, no
 * duplicated logic), set the doc to ready|partial, and book the OCR spend to
 * the PROPERTY ledger (agent_costs, kind='background') off the uploader's chat
 * cap — exactly like embedding cost.
 *
 * Auth: requireCronSecret (Bearer CRON_SECRET — same secret already on Fly +
 * Vercel). This is an internal machine-to-machine endpoint; there is no user
 * session. We still validate the doc belongs to the claimed property before
 * touching it (defense against a mistargeted worker POST).
 */
import type { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateInt, validateNumber } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { indexOcrText } from '@/lib/knowledge/indexing';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Embedding a doc's worth of OCR'd text (chunk + embed + store) is fast — the
// slow vision pass already happened off-box on Fly. 60s is ample headroom.
export const maxDuration = 60;

const OCR_MODEL = 'claude-sonnet-4-6';
// Upper bound on the transcribed text we accept in one POST. The worker caps
// the doc at 60 pages and each page is bounded, so a legitimate body stays well
// under this; it's a guard against a runaway payload, not a business rule.
const OCR_TEXT_MAX = 2_000_000;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const authFail = requireCronSecret(req);
  if (authFail) return authFail;

  let raw: {
    propertyId?: unknown; documentId?: unknown; text?: unknown; pages?: unknown;
    inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown; partial?: unknown;
  };
  try { raw = await req.json(); } catch { raw = {}; }

  const pidV = validateUuid(raw.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const docV = validateUuid(raw.documentId, 'documentId');
  if (docV.error) return err(docV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const textV = validateString(raw.text, { max: OCR_TEXT_MAX, label: 'text', allowEmpty: true });
  if (textV.error) return err(textV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pagesV = validateInt(raw.pages, { min: 0, max: 100_000, label: 'pages' });
  if (pagesV.error) return err(pagesV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const inTokV = validateInt(raw.inputTokens, { min: 0, max: 1_000_000_000, label: 'inputTokens' });
  if (inTokV.error) return err(inTokV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const outTokV = validateInt(raw.outputTokens, { min: 0, max: 1_000_000_000, label: 'outputTokens' });
  if (outTokV.error) return err(outTokV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const costV = validateNumber(raw.costUsd, { min: 0, max: 1000, label: 'costUsd' });
  if (costV.error) return err(costV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pageCapped = raw.partial === true;

  const propertyId = pidV.value!;
  const documentId = docV.value!;

  // Capability check: the doc must exist AND belong to the claimed property.
  // We also grab uploaded_by (an accounts.id) to attribute the OCR spend, and
  // guard against re-processing a doc that already landed on a terminal status.
  const { data: doc, error: docErr } = await supabaseAdmin
    .from('knowledge_documents')
    .select('id, property_id, uploaded_by, extraction_status')
    .eq('id', documentId)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (docErr) {
    log.error('ocr-complete: doc lookup failed', { err: docErr.message, requestId });
    return err('Lookup failed', { requestId, status: 500, code: 'db_error' });
  }
  if (!doc) {
    return err('Document not found for this property', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Idempotency guard: only a doc still awaiting OCR ('processing', or 'pending'
  // pre-handoff) should be indexed here. A duplicate/retried POST for a doc that
  // already landed on a terminal status must be a NO-OP — otherwise re-running
  // indexOcrText (which clears the doc's chunks first) would blip search
  // unavailable, and a second embed failure could DOWNGRADE a 'ready' doc to
  // 'failed'. Return the existing status so the worker's retry sees success.
  const current = (doc.extraction_status as string | null) ?? 'pending';
  if (current !== 'processing' && current !== 'pending') {
    log.info('ocr-complete: doc already finalized — no-op', { documentId, extractionStatus: current, requestId });
    return ok({ documentId, status: current, pages: pagesV.value!, alreadyDone: true }, { requestId });
  }

  // Run the existing chunk→embed→index pipeline on the provided text. The
  // uploader (uploaded_by) attributes the embedding spend to the property ledger
  // inside indexOcrText, same as the normal path.
  const accountId = (doc.uploaded_by as string | null) ?? null;
  if (!accountId) {
    // Every doc is registered with uploaded_by set; a null here is anomalous.
    // Fail loudly rather than embed with no cost attribution.
    log.error('ocr-complete: doc has no uploaded_by — cannot attribute spend', { documentId, requestId });
    return err('Document is missing its uploader', { requestId, status: 409, code: 'invalid_state' });
  }

  const status = await indexOcrText({
    propertyId,
    docId: documentId,
    text: textV.value ?? '',
    accountId,
    pageCapped,
  });

  // Book the OCR (vision) spend to the property ledger, off the user's chat cap
  // — mirrors how embedding cost is metered. Best-effort: a metering failure
  // must not undo an otherwise-successful index (the doc is already searchable).
  try {
    if (costV.value! > 0) {
      await recordNonRequestCost({
        userId: accountId,
        propertyId,
        conversationId: null,
        model: OCR_MODEL,
        modelId: OCR_MODEL,
        tokensIn: inTokV.value!,
        tokensOut: outTokV.value!,
        costUsd: costV.value!,
        kind: 'background',
      });
    }
  } catch (e) {
    log.warn('ocr-complete: cost metering failed (non-fatal)', {
      err: e instanceof Error ? e.message : String(e), requestId,
    });
  }

  return ok({ documentId, status, pages: pagesV.value! }, { requestId });
}
