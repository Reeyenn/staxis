// ═══════════════════════════════════════════════════════════════════════════
// Knowledge search — PURE helpers (no I/O, no server-only). Split out so the
// ranking + permission + sanitize logic unit-tests without the supabaseAdmin /
// agent-cost import chain.
// ═══════════════════════════════════════════════════════════════════════════

import { canManageTeam, type AppRole } from '@/lib/roles';
import type { KnowledgeVisibility } from './types';

/**
 * Can this role see `managers`-visibility knowledge? True only for the
 * management roles (admin / owner / general_manager). This is THE permission
 * gate — used to set the SQL `p_include_manager_only` flag for vector search
 * AND to build the keyword/list WHERE clauses. A housekeeper/front_desk/
 * maintenance role gets false → manager-only rows are invisible everywhere.
 */
export function canRoleSeeManagerOnly(role: AppRole): boolean {
  return canManageTeam(role);
}

/** Whether a role may see a row of the given visibility. */
export function roleCanSeeVisibility(role: AppRole, visibility: KnowledgeVisibility): boolean {
  return visibility === 'all_staff' || canRoleSeeManagerOnly(role);
}

/**
 * Strip everything that isn't a letter, number, space, dot, or hyphen — removes
 * LIKE wildcards (`%`, `_`) and PostgREST-meaningful chars so a query can't
 * widen the match or break out of the filter. The result is passed only as a
 * VALUE to `.ilike()`, never interpolated into a filter string.
 */
export function sanitizeSearchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N}\s.\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Build a context snippet around the first occurrence of `term`, or the head. */
export function makeSnippet(text: string | null | undefined, term: string, max = 240): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const idx = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (idx < 0) {
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(flat.length, idx + max - 60);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// ── Chunk-hit blending (vector arm ⊕ keyword arm) ────────────────────────────

export interface ChunkHit {
  id: string;
  documentId: string | null;
  articleId: string | null;
  sourceType: 'document' | 'article';
  content: string;
  section: string | null;
  /** Cosine similarity from the vector arm (0..1), or null for keyword-only. */
  similarity: number | null;
}

export interface BlendedPassage extends ChunkHit {
  /** Combined relevance score used for the final ranking. */
  score: number;
  /** True when the keyword arm also matched this chunk. */
  keyword: boolean;
}

export interface BlendOptions {
  /** Drop vector-only hits below this cosine similarity (noise floor). */
  minSimilarity?: number;
  /** Boost added when the keyword arm matched a chunk. */
  keywordBoost?: number;
  /** Max passages returned. */
  limit?: number;
}

/**
 * Merge vector-similarity hits with keyword (ILIKE) hits into a single ranked,
 * de-duplicated passage list. A chunk found by BOTH arms ranks highest; a pure
 * keyword hit (exact part number the embedding ranked low) still surfaces; a
 * weak vector-only hit below the floor is dropped so an unrelated query returns
 * nothing rather than a misleading "closest" passage.
 *
 * Pure + deterministic (stable sort by score, then sourceId+index proxy via id).
 */
export function blendChunkHits(
  vectorHits: ChunkHit[],
  keywordHits: ChunkHit[],
  opts: BlendOptions = {},
): BlendedPassage[] {
  const minSimilarity = opts.minSimilarity ?? 0.2;
  const keywordBoost = opts.keywordBoost ?? 0.3;
  const limit = opts.limit ?? 6;

  const keywordIds = new Set(keywordHits.map((h) => h.id));
  const byId = new Map<string, BlendedPassage>();

  // Vector hits first (carry similarity).
  for (const h of vectorHits) {
    const sim = h.similarity ?? 0;
    if (sim < minSimilarity) continue;
    byId.set(h.id, {
      ...h,
      keyword: keywordIds.has(h.id),
      score: sim + (keywordIds.has(h.id) ? keywordBoost : 0),
    });
  }
  // Keyword-only hits (not already present from the vector arm).
  for (const h of keywordHits) {
    if (byId.has(h.id)) continue;
    byId.set(h.id, {
      ...h,
      keyword: true,
      similarity: h.similarity ?? null,
      // Keyword-only baseline: enough to surface, below a strong vector match.
      score: keywordBoost + 0.15,
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
