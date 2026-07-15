// Pure helpers for the CountSheet save flow's resume bookkeeping.
//
// Mirrors the scan flow's CommitProgress pattern (see scan-commit.ts): a count
// save runs three writes (count batch → auto stock-up orders → per-item stock
// updates). Before this existed, a retry after a partial failure re-ran the
// whole sequence from scratch, duplicating Physical-count history rows and
// stock-up order rows (which inflate month spend and feed phantom consumption
// into the AI's learning windows). The sheet now keeps a SaveProgress object
// across retries of the SAME entries and skips every step that already landed.
// When the user EDITS entries between attempts, per-item completion is carried
// forward for the entries that didn't change (see unchangedItemIds) so only
// the edited/new items re-run.

/** Value snapshot of the typed entries, so a retry can tell whether it is
 *  resuming the same count (resume: skip completed steps) or the user edited
 *  numbers after the failure (start a fresh attempt). Order-insensitive. */
export function entriesFingerprint(entries: Record<string, { value: string }>): string {
  return Object.keys(entries)
    .filter((id) => entries[id].value !== '')
    .sort()
    .map((id) => `${id}=${entries[id].value}`)
    .join('|');
}

/**
 * Item ids whose typed value is identical between two fingerprints. Used when
 * the user EDITS entries after a partial save failure: the new attempt must
 * not re-run steps that already landed for items she didn't touch (that would
 * duplicate count rows and stock-up orders — the same harm the resume
 * bookkeeping exists to prevent, just on the edit-then-retry path). Values are
 * numGuard-ed numeric strings (photo fills are `String(n)`), so they can never
 * contain the `=` / `|` delimiters.
 */
export function unchangedItemIds(prevFp: string, nextFp: string): Set<string> {
  const parse = (fp: string): Map<string, string> => {
    const m = new Map<string, string>();
    if (fp === '') return m;
    for (const part of fp.split('|')) {
      const eq = part.indexOf('=');
      m.set(part.slice(0, eq), part.slice(eq + 1));
    }
    return m;
  };
  const prev = parse(prevFp);
  const out = new Set<string>();
  for (const [id, value] of parse(nextFp)) {
    if (prev.get(id) === value) out.add(id);
  }
  return out;
}

/**
 * Which counted items need an auto "stock-up" order: counted stock HIGHER than
 * the freshly-fetched stored stock means someone received goods and forgot to
 * log them. `freshStock` wins over the page-load baseline; items missing from
 * the fetch (deleted mid-session) fall back to `pageLoadStock`.
 */
export function computeStockUps<T extends {
  id: string;
  pageLoadStock: number;
  countedStock: number;
  /** Explicit false for an initial baseline count, which is never a delivery. */
  stockUpEligible?: boolean;
}>(
  counted: T[],
  freshStock: Record<string, number>,
): Array<T & { delta: number }> {
  const out: Array<T & { delta: number }> = [];
  for (const c of counted) {
    if (c.stockUpEligible === false) continue;
    const baseline = c.id in freshStock ? freshStock[c.id] : c.pageLoadStock;
    const delta = c.countedStock - baseline;
    if (delta > 0) out.push({ ...c, delta });
  }
  return out;
}
