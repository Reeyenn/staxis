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
import { log } from '../log.js';
import type { TieredSelector } from '../types.js';

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

// ─── feature/cua-semantic-columns — header-anchored column resolution ────────
//
// The robot historically pins each column by POSITION (`td:nth-child(3)`). When
// a PMS reorders or renames columns that silently grabs the wrong cell. The
// durable per-column shape (TableRowHint.columnsTiered) adds a HEADER anchor
// {roleName:{role,name:<header text>}} beside the positional css. At poll we
// resolve the header text → its live column index ONCE per scrape, REBASE the
// css's nth-child integer onto it, and read the cell with the SAME `$$eval`
// reader the positional path uses (no fork → "verified at mapping, blank at
// poll" can't re-open). The positional css is always the fallback, so a feed
// with no header / an ambiguous header / a structurally-misaligned header reads
// EXACTLY as today.

/** Normalize header/role text for matching: collapse whitespace, trim, lowercase. */
export function normalizeHeaderText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** First positional pseudo-class integer in a column selector, or null when the
 *  selector is non-positional (class/attr/'.'/row-attribute based). Only a bare
 *  integer arg counts — `:nth-child(2n+1)` is intentionally NOT rebaseable. */
const FIRST_NTH_RE = /:nth-(child|of-type)\(\s*(\d+)\s*\)/;
export function parseFirstNthIndex(selector: string): number | null {
  const m = FIRST_NTH_RE.exec(selector);
  return m ? parseInt(m[2]!, 10) : null;
}

/** Rebase a positional column selector onto a NEW column index — replaces ONLY
 *  the first `:nth-child(K)` / `:nth-of-type(K)` integer, leaving any within-cell
 *  refinement and the trailing `@attr` convention untouched. Returns the input
 *  unchanged when there is no rebaseable integer. */
export function rebaseNthIndex(selector: string, index: number): string {
  return selector.replace(FIRST_NTH_RE, (_full, kind: string) => `:nth-${kind}(${index})`);
}

/** A table's header row as read from the live DOM — shared by the mapper's
 *  finalize-time capture (to author roleName anchors) and the poll-time resolver
 *  (to re-anchor on reorder). */
export interface CapturedTableHeaders {
  /** Header cells in DOM order, each with its 1-based element position among its
   *  parent's children (matching how `:nth-child` counts body cells), the
   *  normalized text (for matching) and the raw text (for authoring roleName). */
  cells: Array<{ index: number; text: string; raw: string }>;
  /** 'gridcell' for ARIA grids/treegrids, else 'cell' (HTML tables / role=table). */
  roleKind: 'cell' | 'gridcell';
  /** True when ANY header cell spans (colSpan/rowSpan/aria-colspan > 1) →
   *  positions can't be trusted; callers must NOT header-anchor. */
  hasSpan: boolean;
  /** Element-child count of the header row. */
  headerChildCount: number;
  /** Element-child count of the first body row matched by rowSelector. */
  bodyChildCount: number;
}

/**
 * Read the header row for the table that `rowSelector` rows live in. Best-effort:
 * returns null on any failure (caller falls back to positional css). NEVER
 * throws. One `page.evaluate` — call ONCE per scrape, never per row/cell.
 */
export async function readTableHeaders(
  page: Page,
  rowSelector: string,
  opts?: { isXpath?: boolean },
): Promise<CapturedTableHeaders | null> {
  try {
    const raw = await page.evaluate(
      (args: { rowSelector: string; isXpath: boolean }) => {
        // Inline-only (no closures / arrow helpers) — same esbuild `__name`
        // gotcha set-of-mark.ts documents. Locate the first body row.
        let firstRow: Element | null = null;
        if (args.isXpath) {
          try {
            const r = document.evaluate(args.rowSelector, document, null, 9, null);
            firstRow = (r.singleNodeValue as Element | null) ?? null;
          } catch { firstRow = null; }
        } else {
          try { firstRow = document.querySelector(args.rowSelector); } catch { firstRow = null; }
        }
        if (!firstRow) return null;

        const table = firstRow.closest('table, [role="table"], [role="grid"], [role="treegrid"]');
        const tableRole = table ? table.getAttribute('role') : null;
        const roleKind: 'cell' | 'gridcell' =
          tableRole === 'grid' || tableRole === 'treegrid' ? 'gridcell' : 'cell';

        let headerCells: Element[] = [];
        let headerRow: Element | null = null;
        if (table) {
          const theadCells = Array.from(table.querySelectorAll('thead th, thead [role="columnheader"]'));
          if (theadCells.length > 0) {
            headerCells = theadCells;
            headerRow = theadCells[0]!.parentElement;
          }
          if (headerCells.length === 0) {
            const roleHeaders = Array.from(table.querySelectorAll('[role="columnheader"]'));
            if (roleHeaders.length > 0) {
              headerCells = roleHeaders;
              headerRow = roleHeaders[0]!.parentElement;
            }
          }
          if (headerCells.length === 0) {
            const firstTr = table.querySelector('tr');
            if (firstTr) {
              const ths = Array.from(firstTr.querySelectorAll(':scope > th'));
              if (ths.length > 0) {
                headerCells = ths;
                headerRow = firstTr;
              }
            }
          }
        }

        const bodyChildCount = firstRow.children.length;
        if (headerCells.length === 0) {
          return { cells: [], roleKind, hasSpan: false, headerChildCount: 0, bodyChildCount };
        }

        let hasSpan = false;
        const cells: Array<{ index: number; text: string; raw: string }> = [];
        for (const c of headerCells) {
          const cs = (c as HTMLTableCellElement).colSpan;
          const rs = (c as HTMLTableCellElement).rowSpan;
          if ((typeof cs === 'number' && cs > 1) || (typeof rs === 'number' && rs > 1)) hasSpan = true;
          const ariaCol = c.getAttribute('aria-colspan');
          if (ariaCol && parseInt(ariaCol, 10) > 1) hasSpan = true;
          // 1-based position among parent's element children (matches nth-child).
          let index = -1;
          const parent = c.parentElement;
          if (parent) {
            let i = 0;
            for (const ch of Array.from(parent.children)) { i++; if (ch === c) { index = i; break; } }
          }
          const raw = (c.textContent || '').replace(/\s+/g, ' ').trim();
          const text = raw.toLowerCase();
          cells.push({ index, text, raw });
        }
        return {
          cells,
          roleKind,
          hasSpan,
          headerChildCount: headerRow ? headerRow.children.length : 0,
          bodyChildCount,
        };
      },
      { rowSelector, isXpath: !!opts?.isXpath },
    );
    return (raw as CapturedTableHeaders | null) ?? null;
  } catch (err) {
    log.warn('readTableHeaders: evaluate failed', { message: (err as Error).message });
    return null;
  }
}

/** Header positions are trustworthy for rebasing only when the table has a real
 *  header row, no spanning header cell, and the header/body cell counts agree
 *  (rejects the "body has a checkbox column the header lacks" misalignment). */
export function headerGateOk(h: CapturedTableHeaders | null): boolean {
  return !!h
    && h.cells.length > 0
    && !h.hasSpan
    && h.headerChildCount > 0
    && h.headerChildCount === h.bodyChildCount;
}

/** Which tier resolved a column this scrape (telemetry for CSS-drift watch). */
export type ColumnTier = 'roleName' | 'css' | 'xpath' | 'legacy';

export interface ColumnTierResolution {
  field: string;
  tier: ColumnTier;
  /** true when header-anchoring pointed at a DIFFERENT column index than the css
   *  fallback encodes — i.e. a real column reorder self-healed this poll. */
  drift: boolean;
  fromIndex?: number;
  toIndex?: number;
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
  /** feature/cua-semantic-columns — present ONLY when tiered selectors were
   *  supplied. Per-column tier that resolved + whether a reorder self-healed.
   *  Surfaced for CSS-drift observability (dom-table logs the feed-scoped line). */
  resolution?: ColumnTierResolution[];
  /** Which rowSelector tier actually matched ('css' unless an xpath fallback fired). */
  rowSelectorTier?: 'css' | 'xpath';
}

export interface ExtractDomRowsOptions {
  /** Hard cap on rows scraped (DEADNESS_ROW_CAP / maxRows). */
  cap: number;
  /** feature/cua-semantic-columns — per-column HEADER anchors. When present (and
   *  non-empty) the reader resolves each anchored column by header text first,
   *  rebasing its positional css onto the LIVE column index; absent ⟹ the legacy
   *  positional path (byte-identical replay). */
  columnsTiered?: Record<string, TieredSelector>;
  /** feature/cua-semantic-columns — tiered alternative for the rowSelector
   *  (css → xpath). The flat `rowSelector` arg stays authoritative. */
  rowSelectorTiered?: TieredSelector;
}

/**
 * THE single positional reader body. Both the legacy fast path AND the
 * header-anchored tiered path funnel their resolved CSS selectors through this
 * exact `$$eval` — so there is ONE cell-reading implementation, never a fork
 * (the "verified at mapping, blank at poll" bug class stays dead). `rowSelector`
 * may be a plain CSS selector or a Playwright `xpath=…` selector (row-xpath
 * fallback); the per-column selectors are always CSS here.
 */
async function scrapeCssRows(
  page: Page,
  rowSelector: string,
  pairs: ColumnPair[],
  cap: number,
): Promise<{ rows: Array<Record<string, string>>; totalMatched: number }> {
  return page.$$eval(
    rowSelector,
    (els: Element[], args: { pairs: Array<{ field: string; css: string; attr: string | null }>; cap: number }) => {
      const rows = els.slice(0, args.cap).map((el: Element) => {
        const out: Record<string, string> = {};
        for (const p of args.pairs) {
          // Per-selector fault isolation: one syntactically-invalid CSS
          // selector (querySelector throws) must read as a blank CELL, not
          // kill the whole feed's extraction — the blank then classifies as
          // a dead column while the good columns keep working.
          let target: Element | null = null;
          try {
            target = p.css === '.' ? el : el.querySelector(p.css);
          } catch {
            target = null;
          }
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
    { pairs, cap },
  );
}

/** Read row-scoped XPATH columns (the column xpath tier — rarely populated; used
 *  only for columns with no usable css). Relative to each matched row; supports
 *  attribute selection (an `…/@attr` xpath returns the attribute value). */
async function scrapeXpathColumns(
  page: Page,
  rowSelector: string,
  xpathColumns: Record<string, string>,
  cap: number,
): Promise<Array<Record<string, string>>> {
  const entries = Object.entries(xpathColumns).filter(([, xp]) => typeof xp === 'string' && xp.trim() !== '');
  if (entries.length === 0) return [];
  return page.$$eval(
    rowSelector,
    (els: Element[], args: { entries: Array<[string, string]>; cap: number }) => {
      return els.slice(0, args.cap).map((el: Element) => {
        const out: Record<string, string> = {};
        for (const [field, xp] of args.entries) {
          let val = '';
          try {
            // Force a row-scoped relative xpath so it reads THIS row, not the doc.
            const rel = xp.startsWith('.') ? xp : '.' + (xp.startsWith('/') ? xp : '/' + xp);
            const res = document.evaluate(rel, el, null, 9, null);
            const node = res.singleNodeValue as Node | null;
            if (node) {
              val = (node.nodeType === 2 ? (node.nodeValue ?? '') : (node.textContent ?? '')).trim();
            }
          } catch { val = ''; }
          out[field] = val;
        }
        return out;
      });
    },
    { entries, cap },
  );
}

/**
 * Scrape rows from the CURRENT page with learned table selectors. Never
 * navigates. Throws on an invalid rowSelector (callers decide whether that is
 * fatal — the runtime extractor fails the feed; the mapper probe degrades to
 * string-only verification).
 *
 * Back-compat: when `opts.columnsTiered` is absent/empty and there's no row
 * xpath, this is the EXACT legacy path (same pairs, same reader, same rows).
 */
export async function extractDomRows(
  page: Page,
  rowSelector: string,
  columns: Record<string, string>,
  opts: ExtractDomRowsOptions,
): Promise<ExtractDomRowsResult> {
  const hasColumnTier = !!opts.columnsTiered && Object.keys(opts.columnsTiered).length > 0;
  const hasRowXpath = !!opts.rowSelectorTiered?.xpath;

  // FAST PATH — nothing tiered to do → byte-identical legacy behavior.
  if (!hasColumnTier && !hasRowXpath) {
    const pairs = toColumnPairs(columns);
    return scrapeCssRows(page, rowSelector, pairs, opts.cap);
  }

  return extractDomRowsTiered(page, rowSelector, columns, opts);
}

/** Header-anchored read with positional fallback. Resolves the column index per
 *  header text ONCE per scrape, rebases each column's css, then funnels through
 *  the SAME `scrapeCssRows` reader. */
async function extractDomRowsTiered(
  page: Page,
  rowSelector: string,
  columns: Record<string, string>,
  opts: ExtractDomRowsOptions,
): Promise<ExtractDomRowsResult> {
  // 1. Resolve the ROW selector tier (css → xpath). The flat css stays primary;
  //    xpath fires only when css matches nothing (a real selector break). An
  //    empty feed legitimately matches 0 too — retrying via xpath is harmless
  //    there (also 0) and only happens when an xpath tier was authored.
  let effectiveRowSelector = rowSelector;
  let rowSelectorTier: 'css' | 'xpath' = 'css';
  let rowIsXpath = false;
  if (opts.rowSelectorTiered?.xpath) {
    let cssCount = -1;
    try { cssCount = await page.$$eval(rowSelector, (els: Element[]) => els.length); } catch { cssCount = -1; }
    if (cssCount <= 0) {
      effectiveRowSelector = `xpath=${opts.rowSelectorTiered.xpath}`;
      rowSelectorTier = 'xpath';
      rowIsXpath = true;
    }
  }

  // 2. Header analysis — ONCE per scrape, only if some column carries a roleName.
  const anyRoleName = !!opts.columnsTiered && Object.values(opts.columnsTiered).some((t) => !!t?.roleName);
  const headers = anyRoleName ? await readTableHeaders(page, effectiveRowSelector, { isXpath: rowIsXpath }) : null;
  const gateOk = headerGateOk(headers);
  const headerIndexByText = new Map<string, number[]>();
  if (gateOk && headers) {
    for (const c of headers.cells) {
      if (c.index < 1) continue;
      const arr = headerIndexByText.get(c.text);
      if (arr) arr.push(c.index); else headerIndexByText.set(c.text, [c.index]);
    }
  }

  // 3. Per-column resolution — decide the effective css (or xpath) up front.
  const resolution: ColumnTierResolution[] = [];
  const cssEffective: Record<string, string> = {};
  const xpathOnly: Record<string, string> = {};
  for (const [field, flatCssRaw] of Object.entries(columns)) {
    const flatCss = (flatCssRaw ?? '').trim();
    const tiered = opts.columnsTiered?.[field];

    if (!tiered) {
      cssEffective[field] = flatCss;
      resolution.push({ field, tier: 'legacy', drift: false });
      continue;
    }

    // roleName tier — resolve header text → live index, rebase the css.
    const origIdx = parseFirstNthIndex(flatCss);
    if (tiered.roleName && gateOk && origIdx != null) {
      const matches = headerIndexByText.get(normalizeHeaderText(tiered.roleName.name)) ?? [];
      let targetIdx: number | null = null;
      if (matches.length === 1) targetIdx = matches[0]!;
      // Duplicate/ambiguous header (two "Date" columns): disambiguate by the
      // original css index — never guess. If origIdx isn't among the matches,
      // fall through to css verbatim.
      else if (matches.length > 1 && matches.includes(origIdx)) targetIdx = origIdx;
      if (targetIdx != null) {
        cssEffective[field] = rebaseNthIndex(flatCss, targetIdx);
        resolution.push({ field, tier: 'roleName', drift: targetIdx !== origIdx, fromIndex: origIdx, toIndex: targetIdx });
        continue;
      }
    }

    // css tier — the working positional selector verbatim.
    const css = (tiered.css ?? flatCss).trim();
    if (css !== '') {
      cssEffective[field] = css;
      resolution.push({ field, tier: 'css', drift: false });
      continue;
    }

    // xpath tier — only when no css is available for this column.
    if (tiered.xpath && tiered.xpath.trim() !== '') {
      xpathOnly[field] = tiered.xpath;
      resolution.push({ field, tier: 'xpath', drift: false });
      continue;
    }

    cssEffective[field] = '';
    resolution.push({ field, tier: 'css', drift: false });
  }

  // 4. Main read — the UNCHANGED reader body (no fork).
  const pairs = toColumnPairs(cssEffective);
  const main = await scrapeCssRows(page, effectiveRowSelector, pairs, opts.cap);
  let rows = main.rows;

  // 5. Column xpath tier — fill xpath-only columns, plus a genuine css→xpath
  //    fallback for tiered columns whose css came back blank in EVERY row. The
  //    durable shape rarely populates column xpath, so this almost never runs;
  //    bounded to ONE extra pass and gated on xpath presence.
  const xpathToRead: Record<string, string> = { ...xpathOnly };
  if (rows.length > 0) {
    for (const r of resolution) {
      if (r.tier === 'xpath') continue;
      const xp = opts.columnsTiered?.[r.field]?.xpath;
      if (!xp || xp.trim() === '') continue;
      if (rows.every((row) => !(row[r.field] ?? '').trim())) xpathToRead[r.field] = xp;
    }
  }
  if (Object.keys(xpathToRead).length > 0 && rows.length > 0) {
    const xrows = await scrapeXpathColumns(page, effectiveRowSelector, xpathToRead, opts.cap);
    rows = rows.map((row, i) => ({ ...row, ...(xrows[i] ?? {}) }));
    for (const r of resolution) {
      if (xpathToRead[r.field] && (xrows[0]?.[r.field] ?? '') !== '') r.tier = 'xpath';
    }
  }

  // 6. Telemetry (resolver side) — surface a self-heal the moment it happens.
  const drifted = resolution.filter((r) => r.drift);
  if (drifted.length > 0) {
    log.info('dom-rows: column self-heal — header re-anchored reordered column(s)', {
      drifted: drifted.map((d) => ({ field: d.field, from: d.fromIndex, to: d.toIndex })),
    });
  }

  return { rows, totalMatched: main.totalMatched, resolution, rowSelectorTier };
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
        // Same per-selector fault isolation as the row reader.
        let target: Element | null = null;
        try {
          target = document.querySelector(p.css);
        } catch {
          target = null;
        }
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
