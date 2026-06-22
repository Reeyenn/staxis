// ═══════════════════════════════════════════════════════════════════════════
// Knowledge indexing — the write side of the document-reading pipeline.
//
// Orchestrates: download bytes → extract text (state machine) → chunk →
// embed → store chunks → set final status. Runs in the background via the
// route's after() hook so a slow PDF/embedding never blocks the upload
// response (and so the UI shows pending → processing → ready honestly).
//
// Cost: embedding spend is metered to the PROPERTY budget line (agent_costs,
// kind='background'), NOT the uploader's personal chat cap. A generous
// per-property daily ceiling degrades gracefully to keyword-only on overflow.
//
// Embed-once / re-embed-on-change: documents are immutable (a change = new
// upload = new row), so a doc embeds exactly once. SOPs can be edited, so
// indexArticle deletes + re-inserts that article's chunks on every save.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { chunkText, DEFAULT_MAX_CHUNKS, type TextChunk } from './chunking';
import { extractDocumentText } from './extraction';
import {
  getDefaultEmbedder, estimateEmbeddingCostUsd, EMBEDDING_MODEL, toVectorLiteral, type Embedder,
} from './embeddings';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import type { KnowledgeVisibility, ExtractionStatus } from './types';

const BUCKET = 'knowledge-docs';

// Property-scoped daily embedding budget (defense-in-depth at 300-hotel scale).
// Embeddings are tiny (~$0.0005 per large doc), so $1/property/day ≈ 2000 large
// docs. On overflow we still STORE chunks (keyword-searchable) but skip the
// embedding → status 'partial' with an honest note; the query path likewise
// falls back to keyword-only. Tunable without a schema change.
export const EMBEDDING_PROPERTY_DAILY_USD = 1.0;

// ── Cost metering ────────────────────────────────────────────────────────────

function utcDayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Today's embedding spend for a property (isolated by model). */
export async function embeddingSpendTodayUsd(propertyId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('cost_usd')
    .eq('property_id', propertyId)
    .eq('model', EMBEDDING_MODEL)
    .gte('created_at', utcDayStartIso());
  if (error) {
    // Fail OPEN for metering reads — embeddings are cheap and we'd rather index
    // than block on a transient ledger read error. The cost is still recorded
    // post-embed; only the pre-flight ceiling is skipped this once.
    log.warn('knowledge.embeddingSpendTodayUsd failed', { err: error.message });
    return 0;
  }
  return (data ?? []).reduce((acc, r) => acc + Number((r as { cost_usd?: number }).cost_usd ?? 0), 0);
}

/** Book embedding spend to the PROPERTY ledger (agent_costs, kind='background')
 *  — off the user's chat cap. Reused by the query path in core.ts. */
export async function meterEmbeddingCost(opts: {
  accountId: string;
  propertyId: string;
  totalTokens: number;
  model: string;
}): Promise<void> {
  const costUsd = estimateEmbeddingCostUsd(opts.totalTokens);
  if (costUsd <= 0) return;
  try {
    await recordNonRequestCost({
      userId: opts.accountId,       // agent_costs.user_id → accounts(id)
      propertyId: opts.propertyId,
      conversationId: null,
      model: EMBEDDING_MODEL,
      modelId: opts.model,
      tokensIn: opts.totalTokens,
      tokensOut: 0,
      costUsd,
      kind: 'background',           // off the user's chat cap; on the property ledger
    });
  } catch (e) {
    // Metering must never fail an index. Log + continue.
    log.warn('knowledge.meterEmbeddingCost failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

// ── Chunk persistence ────────────────────────────────────────────────────────

interface EmbedStoreResult { partial: boolean; error: string | null; chunkCount: number; }

async function embedAndStoreChunks(opts: {
  propertyId: string;
  accountId: string;
  visibility: KnowledgeVisibility;
  /** Denormalized department for visibility='dept' documents; null otherwise
   *  (and always null for articles). Mirrored to knowledge_chunks.visible_dept. */
  visibleDept: string | null;
  sourceType: 'document' | 'article';
  documentId: string | null;
  articleId: string | null;
  chunks: TextChunk[];
  embedder?: Embedder;
}): Promise<EmbedStoreResult> {
  const { chunks } = opts;
  if (chunks.length === 0) return { partial: false, error: null, chunkCount: 0 };

  // Pre-flight property embedding ceiling. Over budget → store keyword-only.
  let vectors: (number[] | null)[] = chunks.map(() => null);
  let partial = false;
  let error: string | null = null;

  const spent = await embeddingSpendTodayUsd(opts.propertyId);
  if (spent >= EMBEDDING_PROPERTY_DAILY_USD) {
    partial = true;
    error = 'Daily embedding budget reached for this property — searchable by keyword for now.';
  } else {
    try {
      // Construct the embedder INSIDE the try so a missing OPENAI_API_KEY (or any
      // construction error) degrades to keyword-only `partial` rather than
      // throwing out of indexDocument and stranding the doc in `pending`
      // (Codex review MED-3). Chunks are still stored + keyword-searchable.
      const embedder = opts.embedder ?? getDefaultEmbedder();
      const res = await embedder.embed(chunks.map((c) => c.content));
      if (res.vectors.length === chunks.length) {
        vectors = res.vectors;
      } else {
        partial = true;
        error = 'Embedding returned an unexpected count — keyword-only for now.';
      }
      await meterEmbeddingCost({
        accountId: opts.accountId, propertyId: opts.propertyId,
        totalTokens: res.totalTokens, model: res.model,
      });
    } catch (e) {
      partial = true;
      error = 'Embedding service was unavailable — searchable by keyword for now.';
      log.warn('knowledge.embed failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  const rows = chunks.map((c, i) => ({
    property_id: opts.propertyId,
    document_id: opts.documentId,
    article_id: opts.articleId,
    source_type: opts.sourceType,
    chunk_index: c.index,
    content: c.content,
    section: c.section,
    visibility: opts.visibility,
    visible_dept: opts.visibleDept,
    embedding: vectors[i] ? toVectorLiteral(vectors[i] as number[]) : null,
    char_count: c.charCount,
  }));

  // Insert in batches so a huge doc doesn't exceed PostgREST's payload limit.
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error: insErr } = await supabaseAdmin.from('knowledge_chunks').insert(rows.slice(i, i + BATCH));
    if (insErr) {
      log.error('knowledge.insertChunks failed', { err: insErr.message });
      return { partial: true, error: 'Some passages could not be stored.', chunkCount: i };
    }
  }
  return { partial, error, chunkCount: rows.length };
}

async function deleteChunksForDocument(documentId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('knowledge_chunks').delete().eq('document_id', documentId);
  if (error) log.warn('knowledge.deleteChunksForDocument failed', { err: error.message });
}
async function deleteChunksForArticle(articleId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('knowledge_chunks').delete().eq('article_id', articleId);
  if (error) log.warn('knowledge.deleteChunksForArticle failed', { err: error.message });
}

/** Read a document's CURRENT scope (visibility + visible_dept) from the row,
 *  falling back to the supplied values if the row can't be read. Used so chunks
 *  are stamped with the live scope, not the (possibly stale) upload-time scope. */
async function currentDocScope(
  propertyId: string, docId: string,
  fallbackVisibility: KnowledgeVisibility, fallbackVisibleDept: string | null,
): Promise<{ visibility: KnowledgeVisibility; visibleDept: string | null }> {
  const { data } = await supabaseAdmin
    .from('knowledge_documents')
    .select('visibility, visible_dept')
    .eq('id', docId)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (!data) return { visibility: fallbackVisibility, visibleDept: fallbackVisibleDept };
  return {
    visibility: (data.visibility as KnowledgeVisibility | null) ?? fallbackVisibility,
    visibleDept: (data.visible_dept as string | null) ?? null,
  };
}

/** After chunks are stored, re-flip them to the document's CURRENT scope if it
 *  changed while we were embedding (the embed can take seconds, and a doc tightened
 *  during the pending window had no chunks for updateDocumentAccess to sync).
 *  Idempotent no-op when unchanged. Review HIGH-2. */
async function reconcileDocChunkScope(
  propertyId: string, docId: string,
  stamped: { visibility: KnowledgeVisibility; visibleDept: string | null },
): Promise<void> {
  const cur = await currentDocScope(propertyId, docId, stamped.visibility, stamped.visibleDept);
  if (cur.visibility === stamped.visibility && (cur.visibleDept ?? null) === (stamped.visibleDept ?? null)) return;
  const { error } = await supabaseAdmin
    .from('knowledge_chunks')
    .update({ visibility: cur.visibility, visible_dept: cur.visibleDept })
    .eq('document_id', docId)
    .eq('property_id', propertyId);
  if (error) log.warn('knowledge.reconcileDocChunkScope failed', { err: error.message });
}

async function setDocStatus(
  propertyId: string,
  docId: string,
  status: ExtractionStatus,
  patch: { extractedText?: string | null; error?: string | null } = {},
): Promise<void> {
  const update: Record<string, unknown> = { extraction_status: status, extracted_at: new Date().toISOString() };
  if ('extractedText' in patch) update.extracted_text = patch.extractedText;
  if ('error' in patch) update.extract_error = patch.error ?? null;
  // Retry the status write — a terminal status that fails to persist would
  // strand the doc in pending/processing forever (Codex review MED-4). Up to
  // 3 attempts with short backoff before giving up loudly.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabaseAdmin
      .from('knowledge_documents')
      .update(update)
      .eq('id', docId)
      .eq('property_id', propertyId);
    if (!error) return;
    log.warn('knowledge.setDocStatus failed', { err: error.message, extractionStatus: status });
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt === 1 ? 150 : 500));
  }
}

// ── Public: index a document (called from the upload route's after() hook) ───

export interface IndexDocumentInput {
  propertyId: string;
  docId: string;
  filePath: string;
  mime: string;
  accountId: string;
  visibility: KnowledgeVisibility;
  /** Department for visibility='dept' docs; null otherwise. Stamped on chunks. */
  visibleDept: string | null;
  embedder?: Embedder;
}

/**
 * Full document pipeline. Idempotent: re-running re-extracts and replaces
 * the doc's chunks. Never throws — terminal failures are written to the row's
 * extraction_status so the UI/agent always sees a definite state.
 */
export async function indexDocument(input: IndexDocumentInput): Promise<ExtractionStatus> {
  const { propertyId, docId, filePath, mime, accountId, visibility, visibleDept } = input;
  try {
    await setDocStatus(propertyId, docId, 'processing');
    // Clear any prior chunks (idempotent re-index).
    await deleteChunksForDocument(docId);

    // Download bytes.
    let bytes: Uint8Array;
    try {
      const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(filePath);
      if (error || !data) throw error ?? new Error('no data');
      bytes = new Uint8Array(await data.arrayBuffer());
    } catch (e) {
      log.warn('knowledge.indexDocument download failed', { err: e instanceof Error ? e.message : String(e) });
      await setDocStatus(propertyId, docId, 'failed', { extractedText: null, error: 'Could not read the uploaded file.' });
      return 'failed';
    }

    const outcome = await extractDocumentText(bytes, mime);

    if (outcome.text === null) {
      // failed | unsupported — no text to index.
      await setDocStatus(propertyId, docId, outcome.status, { extractedText: null, error: outcome.error });
      return outcome.status;
    }

    // Store the (capped) text for keyword fallback + fetch_document_section.
    const chunks = chunkText(outcome.text);
    // Re-read the CURRENT scope right before stamping chunks — a manager may have
    // changed the doc's access during the (possibly long) pending window, where
    // updateDocumentAccess's chunk-sync is a no-op (0 chunks yet). Then reconcile
    // once more after the embed in case access changed while embedding. HIGH-2.
    const scope0 = await currentDocScope(propertyId, docId, visibility, visibleDept);
    const emb = await embedAndStoreChunks({
      propertyId, accountId, visibility: scope0.visibility, visibleDept: scope0.visibleDept,
      sourceType: 'document', documentId: docId, articleId: null,
      chunks, embedder: input.embedder,
    });
    await reconcileDocChunkScope(propertyId, docId, scope0);

    // If chunking hit the hard cap, the tail wasn't indexed → honest `partial`
    // (don't show a green "ready" badge the doc didn't earn).
    const hitChunkCap = chunks.length >= DEFAULT_MAX_CHUNKS;
    const finalStatus: ExtractionStatus = outcome.status === 'partial' || emb.partial || hitChunkCap ? 'partial' : 'ready';
    const finalError = outcome.error ?? emb.error ?? (hitChunkCap ? 'Document is very large — only the first part is indexed for search.' : null);
    await setDocStatus(propertyId, docId, finalStatus, { extractedText: outcome.text, error: finalError });
    return finalStatus;
  } catch (e) {
    log.error('knowledge.indexDocument unexpected', { err: e instanceof Error ? e.message : String(e) });
    await setDocStatus(propertyId, docId, 'failed', { error: 'Indexing failed unexpectedly.' });
    return 'failed';
  }
}

// ── Public: index an SOP article (typed text — no extraction step) ───────────

export interface IndexArticleInput {
  propertyId: string;
  articleId: string;
  title: string;
  body: string;
  category: string | null;
  accountId: string;
  visibility: KnowledgeVisibility;
  embedder?: Embedder;
}

/**
 * (Re)index an SOP. Deletes the article's existing chunks and re-embeds the
 * current title+body. Never throws (background hook).
 */
export async function indexArticle(input: IndexArticleInput): Promise<void> {
  try {
    await deleteChunksForArticle(input.articleId);
    // Seed each chunk's searchable text with the title + category so a passage
    // is retrievable by the SOP's name, then the body.
    const header = [input.title, input.category].filter(Boolean).join(' — ');
    const text = `${header}\n\n${input.body}`.trim();
    const chunks = chunkText(text);
    if (chunks.length === 0) return;
    await embedAndStoreChunks({
      propertyId: input.propertyId, accountId: input.accountId, visibility: input.visibility,
      visibleDept: null, // SOPs never use the 'dept' tier.
      sourceType: 'article', documentId: null, articleId: input.articleId,
      chunks, embedder: input.embedder,
    });
  } catch (e) {
    log.warn('knowledge.indexArticle failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

