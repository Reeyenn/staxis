/**
 * visual-state-dom — the Playwright (learn-time) half of visual-state auto-learn.
 *
 * `gatherCellSignals` reads, for each VISIBLE row, the stable key (room number)
 * plus the target cell's full signal set (textContent / every attribute / every
 * class) — the raw material `findDiscriminator` (visual-state.ts) diffs to locate
 * the readable signal that encodes the value. Kept apart from visual-state.ts so
 * that module stays pure and browser-free for unit testing.
 *
 * CRITICAL — row identity: the visible-row filter here is a byte-for-byte mirror
 * of extractors/dom-rows.ts (drop [hidden] / display:none / visibility:hidden /
 * opacity:0 / zero-box rows). The gathered rows MUST be the same set the runtime
 * reader and the vision labeler operate on, and every row is keyed by its room
 * number — never by row index — so a single shifted/hidden row can't bind a label
 * to the wrong cell (which would silently invert clean/dirty for every row below).
 */
import type { Page } from 'playwright';

/** One visible row's learn-time signals for the target column. `visionLabel` is
 *  filled in later by the caller, joining on `rowKey`. */
export interface CellDomSignals {
  rowKey: string;
  text: string;
  attrs: Record<string, string>;
  classes: string[];
}

/**
 * Gather per-row signals for `targetCellCss`, keyed by `keyCellCss`'s text.
 * css `rowSelector` only — an xpath row selector returns [] (caller abstains /
 * parks; the minimal slice's feeds use css). Rows with a blank key or a missing
 * key/target cell are skipped (can't bind safely).
 */
export async function gatherCellSignals(
  page: Page,
  rowSelector: string,
  keyCellCss: string,
  targetCellCss: string,
): Promise<CellDomSignals[]> {
  const trimmed = rowSelector.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('(') || trimmed.startsWith('xpath=')) return [];
  try {
    return await page.$$eval(
      rowSelector,
      // NB: no NAMED nested functions in here — esbuild/tsx wraps named function
      // expressions with a `__name` helper that is undefined once Playwright
      // serializes this into the browser. The visible-row check is inlined (same
      // style as extractors/dom-rows.ts) for exactly that reason.
      (els, sels) => {
        const [keySel, tgtSel] = sels as [string, string];
        const out: Array<{ rowKey: string; text: string; attrs: Record<string, string>; classes: string[] }> = [];
        for (const row of els) {
          let vis = true;
          try {
            if (row.hasAttribute('hidden')) vis = false;
            else {
              const s = getComputedStyle(row);
              if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') vis = false;
              else {
                const r = row.getBoundingClientRect();
                vis = r.width > 0 || r.height > 0;
              }
            }
          } catch {
            vis = true;
          }
          if (!vis) continue;
          let keyEl: Element | null;
          let tgtEl: Element | null;
          try {
            keyEl = row.querySelector(keySel);
            tgtEl = row.querySelector(tgtSel);
          } catch {
            continue;
          }
          if (!keyEl || !tgtEl) continue;
          // Collapse internal whitespace + trim — MUST match the vision-side key
          // normalization (mapper-visual-recover.ts) or the join silently shrinks.
          const rowKey = (keyEl.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (!rowKey) continue;
          const attrs: Record<string, string> = {};
          for (const a of Array.from(tgtEl.attributes)) attrs[a.name] = a.value;
          out.push({
            rowKey,
            text: (tgtEl.textContent ?? '').trim(),
            attrs,
            classes: Array.from(tgtEl.classList),
          });
        }
        return out;
      },
      [keyCellCss, targetCellCss],
    );
  } catch {
    return [];
  }
}
