/**
 * Shared DOM row/cell reader (feature/cua-column-recovery).
 *
 * THE single implementation of "learned column selector → cell value", used by
 * BOTH the mapper's verification/probe scrapes (mapper.ts) and the runtime
 * dom_table extractor (extractors/dom-table.ts). Before this module the two
 * sides had hand-copied `$$eval` bodies; any semantic drift between them meant
 * "verified at mapping time, blank at poll time" — the exact bug class the
 * column-recovery work exists to kill. Do not fork this logic again.
 *
 * Selector convention (extends plain CSS, identically on both sides):
 *   - '<css>'            → querySelector(css) inside the row, textContent
 *   - '.'                → the row element itself, textContent
 *   - '<css>@<attr>'     → querySelector(css) inside the row, getAttribute(attr)
 *   - '@<attr>' / '.@<attr>' → the row element's own attribute
 * The attribute split happens on the LAST '@' and only when the suffix is a
 * bare attribute name ([A-Za-z_][A-Za-z0-9_-]*). A '@' inside an attribute
 * CSS selector (e.g. [data-x="a@b"]) never matches because the selector ends
 * with ']' / a quote, so plain CSS keeps its exact prior semantics.
 *
 * Values that PMSes hide from textContent — tooltip `title`s, `data-*` ids on
 * the row, the record link's `href` — become extractable, which is how the
 * mapper recovers required columns that render blank as text.
 */

import type { Page } from 'playwright';

export interface ParsedColumnSelector {
  /** CSS to resolve relative to the row ('.' = the row element itself). */
  css: string;
  /** Attribute to read instead of textContent; null = textContent. */
  attr: string | null;
}

const TRAILING_ATTR_RE = /^(.*)@([A-Za-z_][A-Za-z0-9_-]*)$/;

export function parseColumnSelector(selector: string): ParsedColumnSelector {
  const trimmed = selector.trim();
  const m = TRAILING_ATTR_RE.exec(trimmed);
  if (m) {
    const css = m[1]!.trim();
    return { css: css === '' ? '.' : css, attr: m[2]! };
  }
  return { css: trimmed === '' ? '.' : trimmed, attr: null };
}

/** Pre-parsed (field, css, attr) triple — built OUTSIDE the browser context.
 *  `$$eval` callbacks are serialized; parsing in Node keeps one regex, not two
 *  copies of it living inside stringified browser functions. */
interface ColumnPair {
  field: string;
  css: string;
  attr: string | null;
}

function toColumnPairs(columns: Record<string, string>): ColumnPair[] {
  return Object.entries(columns)
    .filter(([, sel]) => typeof sel === 'string' && sel.trim() !== '')
    .map(([field, sel]) => ({ field, ...parseColumnSelector(sel) }));
}

export interface ExtractDomRowsResult {
  /** Row objects keyed by canonical field name, capped at `cap`. Fields with
   *  blank selectors are OMITTED (not ''), matching the historical readers. */
  rows: Array<Record<string, string>>;
  /** Total elements the rowSelector matched (before the cap). */
  totalMatched: number;
}

/**
 * Scrape rows from the CURRENT page with learned table selectors. Never
 * navigates. Throws on an invalid rowSelector (callers decide whether that is
 * fatal — the runtime extractor fails the feed; the mapper probe degrades to
 * string-only verification).
 */
export async function extractDomRows(
  page: Page,
  rowSelector: string,
  columns: Record<string, string>,
  opts: { cap: number },
): Promise<ExtractDomRowsResult> {
  const pairs = toColumnPairs(columns);
  return page.$$eval(
    rowSelector,
    (els: Element[], args: { pairs: Array<{ field: string; css: string; attr: string | null }>; cap: number }) => {
      const rows = els.slice(0, args.cap).map((el: Element) => {
        const out: Record<string, string> = {};
        for (const p of args.pairs) {
          const target = p.css === '.' ? el : el.querySelector(p.css);
          if (!target) {
            out[p.field] = '';
            continue;
          }
          const raw = p.attr ? (target.getAttribute(p.attr) ?? '') : (target.textContent ?? '');
          out[p.field] = raw.trim();
        }
        return out;
      });
      return { rows, totalMatched: els.length };
    },
    { pairs, cap: opts.cap },
  );
}

/**
 * Read single-record fields from the CURRENT page (detail pages), rooted at
 * `document` instead of a row element. Same selector convention. '.' (the
 * "row itself") is meaningless at document level and reads as blank.
 */
export async function extractDetailFields(
  page: Page,
  columns: Record<string, string>,
): Promise<Record<string, string>> {
  const pairs = toColumnPairs(columns);
  return page.evaluate(
    (args: { pairs: Array<{ field: string; css: string; attr: string | null }> }) => {
      const out: Record<string, string> = {};
      for (const p of args.pairs) {
        if (p.css === '.') {
          out[p.field] = '';
          continue;
        }
        const target = document.querySelector(p.css);
        if (!target) {
          out[p.field] = '';
          continue;
        }
        const raw = p.attr ? (target.getAttribute(p.attr) ?? '') : (target.textContent ?? '');
        out[p.field] = raw.trim();
      }
      return out;
    },
    { pairs },
  );
}
