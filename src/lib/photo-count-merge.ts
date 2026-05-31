// ═══════════════════════════════════════════════════════════════════════════
// Photo shelf-count merge — map the /api/inventory/photo-count response (counts
// keyed by item NAME) back onto the count sheet's entries (keyed by item id).
//
// Pure + dependency-free. The route echoes back the exact catalog names we
// sent, so mapping is an exact (case/space-insensitive) name → id lookup — no
// fuzzy matching needed here (that's only for invoice lines).
//
// No-zero-fill guarantee: only items the photo actually returned appear in
// `filled`. Items the photo didn't see are simply absent, so the caller
// leaves their existing count untouched (never silently zeroed).
// ═══════════════════════════════════════════════════════════════════════════

export type PhotoConfidence = 'high' | 'medium' | 'low';

export interface PhotoCount {
  item_name: string;
  estimated_count: number;
  confidence: PhotoConfidence;
}

export interface MergedFill {
  itemId: string;
  /** String for the controlled count input; clamped to a non-negative int. */
  value: string;
  confidence: PhotoConfidence;
}

export interface MergeResult {
  filled: MergedFill[];
  /** Names the model returned that we couldn't map back (shouldn't happen, but surfaced). */
  unmatched: string[];
}

function canonical(name: string): string {
  return (name ?? '').trim().toLowerCase();
}

export function buildNameToIdMap(items: readonly { id: string; name: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of items) {
    const key = canonical(it.name);
    if (key) m.set(key, it.id); // last-wins on dup names (the unique index prevents dups anyway)
  }
  return m;
}

export function mergePhotoCounts(
  counts: readonly PhotoCount[],
  nameToId: Map<string, string>,
): MergeResult {
  const filled: MergedFill[] = [];
  const unmatched: string[] = [];
  for (const c of counts) {
    const id = nameToId.get(canonical(c.item_name));
    if (!id) {
      unmatched.push(c.item_name);
      continue;
    }
    const n = Number(c.estimated_count);
    const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    filled.push({ itemId: id, value: String(count), confidence: c.confidence });
  }
  return { filled, unmatched };
}
