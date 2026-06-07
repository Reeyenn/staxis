// ═══════════════════════════════════════════════════════════════════════════
// Knowledge embeddings — cheap, multilingual text → vector.
//
// Model: OpenAI `text-embedding-3-small` (1536 dims). Picked because it is
//   - CHEAP ($0.02 / 1M tokens — a 100 KB doc ≈ 25k tokens ≈ $0.0005),
//   - MULTILINGUAL (a Spanish question embeds near an English passage and
//     vice-versa — required: EN↔ES cross-match), and
//   - already keyed: OPENAI_API_KEY is a required prod env var (env.ts) that
//     today only powers Whisper STT, so no new secret to provision.
//
// The pipeline is built behind the `Embedder` INTERFACE so the chunk/index/
// search code never imports OpenAI directly. Unit tests inject a deterministic
// fake embedder (the test env only has a placeholder OPENAI_API_KEY and must
// never hit the network). Production uses `getDefaultEmbedder()`.
//
// server-only: embeds run in API routes / the agent tool, never the browser.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { env } from '@/lib/env';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

/** $/1M tokens for text-embedding-3-small (OpenAI pricing, 2026-05). Pinned
 *  next to the model so a future model/price change moves together. */
export const EMBEDDING_PRICE_PER_MTOK_USD = 0.02;

export function estimateEmbeddingCostUsd(totalTokens: number): number {
  return (totalTokens / 1_000_000) * EMBEDDING_PRICE_PER_MTOK_USD;
}

export interface EmbeddingResult {
  /** One vector per input text, in input order. */
  vectors: number[][];
  /** Total tokens billed by the provider (for cost metering). */
  totalTokens: number;
  /** Exact model id reported by the provider (audit). */
  model: string;
}

/** The seam every chunk/search path depends on. Swap a fake in tests. */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** Embed a batch. MUST return one vector per input, in order. */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

// ── Request shaping ──────────────────────────────────────────────────────────
// OpenAI accepts up to 2048 inputs / request, but very large batches risk the
// per-request token ceiling. 96 keeps each request comfortably small while
// still amortizing the round-trip across a whole document's chunks.
const MAX_INPUTS_PER_REQUEST = 96;
const EMBED_REQUEST_TIMEOUT_MS = 30_000;
// Hard cap on a single input's characters before we send it. A chunk is
// ~1k chars (chunking.ts); this is a defensive ceiling so an oversized input
// can't blow the per-input 8192-token model limit and 400 the whole batch.
const MAX_INPUT_CHARS = 24_000;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Production embedder — OpenAI REST (`/v1/embeddings`). No SDK dependency:
 * a single fetch keeps the cold-start light and avoids pulling the openai
 * package into every knowledge route's bundle.
 */
export class OpenAIEmbedder implements Embedder {
  readonly model = EMBEDDING_MODEL;
  readonly dims = EMBEDDING_DIMS;
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'OPENAI_API_KEY is not set. Knowledge document search requires it for embeddings. ' +
        'Set it in Vercel → Project Settings → Environment Variables and redeploy.',
      );
    }
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [], totalTokens: 0, model: this.model };

    const vectors: number[][] = [];
    let totalTokens = 0;
    let reportedModel = this.model;

    for (const batch of chunkArray(texts, MAX_INPUTS_PER_REQUEST)) {
      // OpenAI rejects empty-string inputs. Substitute a single space so the
      // returned vector array stays index-aligned with the caller's inputs.
      const input = batch.map((t) => {
        const s = (t ?? '').slice(0, MAX_INPUT_CHARS);
        return s.length ? s : ' ';
      });
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, input, encoding_format: 'float' }),
        signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Embedding request failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data?: { embedding: number[]; index: number }[];
        usage?: { total_tokens?: number };
        model?: string;
      };
      const data = json.data ?? [];
      if (data.length !== batch.length) {
        throw new Error(
          `Embedding response count mismatch: sent ${batch.length}, got ${data.length}`,
        );
      }
      // Provider guarantees `index` matches input order, but sort defensively
      // so a vector is never associated with the wrong chunk.
      const sorted = [...data].sort((a, b) => a.index - b.index);
      for (const d of sorted) vectors.push(d.embedding);
      totalTokens += json.usage?.total_tokens ?? 0;
      if (json.model) reportedModel = json.model;
    }

    return { vectors, totalTokens, model: reportedModel };
  }
}

let _default: Embedder | null = null;
/** Lazily-built production embedder singleton. */
export function getDefaultEmbedder(): Embedder {
  if (!_default) _default = new OpenAIEmbedder();
  return _default;
}

// ── Pure vector math (used for fallback ranking + tests) ─────────────────────

/** Serialize a float vector to the pgvector text input literal `[a,b,c]`.
 *  Stored/sent as a string so supabase-js doesn't coerce the array to a
 *  Postgres `{}` array (which a `vector` column rejects). */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Cosine similarity in [-1, 1]. Returns 0 for a zero-magnitude vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
