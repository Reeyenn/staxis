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

/** First `:nth-child(K)` integer in a column selector, or null when the selector
 *  is non-positional (class/attr/'.'/row-attribute based). Only a bare integer
 *  arg counts — `:nth-child(2n+1)` is intentionally NOT rebaseable.
 *
 *  Deliberately `:nth-child` ONLY — NOT `:nth-of-type`. We rebase against header
 *  positions counted among ALL element children (readTableHeaders), which is the
 *  `:nth-child` basis. `:nth-of-type` counts among same-TAG siblings, so on a row
 *  that mixes element types (e.g. a leading `<th scope=row>` + `<td>`s) the two
 *  index spaces diverge and a rebase would read the wrong/blank cell. The mapper
 *  prompts only ever emit `:nth-child`; an `:nth-of-type` column simply isn't
 *  header-anchored (it stays on the positional css tier — exactly as today). */
const FIRST_NTH_RE = /:nth-child\(\s*(\d+)\s*\)/;
export function parseFirstNthIndex(selector: string): number | null {
  const m = FIRST_NTH_RE.exec(selector);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Rebase a positional column selector onto a NEW column index — replaces ONLY
 *  the first `:nth-child(K)` integer, leaving any within-cell refinement and the
 *  trailing `@attr` convention untouched. Returns the input unchanged when there
 *  is no rebaseable `:nth-child` integer. */
export function rebaseNthIndex(selector: string, index: number): string {
  return selector.replace(FIRST_NTH_RE, `:nth-child(${index})`);
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
  /** feature/cua-read-integrity — a durable IDENTITY for the chosen table:
   *  'id:<id>' | 'aria:<label>' | 'hdr:<header-text-fingerprint>'. Lets a poll
   *  confirm it is reading the SAME table the map learned (vs a different table a
   *  generic rowSelector also matches). Empty when no table ancestor. */
  tableKey?: string;
  /** fix/cua-header-offset — body rows often carry a few LEADING cells the header
   *  row lacks (a checkbox / "Check In" action column, status icons), so a body
   *  cell sits `bodyOffset` positions to the RIGHT of its header cell. Detected as
   *  bodyChildCount − headerChildCount when small (1..MAX) AND uniform across the
   *  sampled rows. Header-anchoring adds it when rebasing (header index → body
   *  index = headerIndex + bodyOffset) and authoring subtracts it. 0/undefined =
   *  aligned table (byte-identical to before). The runtime re-derives it each poll
   *  (never persisted), so a layout change can't leave a stale offset. */
  bodyOffset?: number;
}

/**
 * Read the header row for the table that `rowSelector` rows live in. Best-effort:
 * returns null on any failure (caller falls back to positional css). NEVER
 * throws. One `page.evaluate` — call ONCE per scrape, never per row/cell.
 */
export async function readTableHeaders(
  page: Page,
  rowSelector: string,
  opts?: { isXpath?: boolean; expectedHeaders?: string[] },
): Promise<CapturedTableHeaders | null> {
  try {
    const raw = await page.evaluate(
      (args: { rowSelector: string; isXpath: boolean; expectedHeaders: string[] }) => {
        // Inline-only (no closures / arrow helpers) — same esbuild `__name`
        // gotcha set-of-mark.ts documents.
        //
        // feature/cua-read-integrity — TABLE DISAMBIGUATION: a generic rowSelector
        // (e.g. "tbody tr") can match rows in MORE THAN ONE table on the page. The
        // old code took the FIRST matching row then closest() — silently the wrong
        // table on multi-table pages. Now: gather EVERY candidate table the
        // selector matches, and when the caller passed the header labels it
        // expects (expectedHeaders), pick the table whose header row best matches
        // them. With no expectedHeaders OR a single candidate table, this is
        // byte-identical to the old first-match behaviour.
        let allRows: Element[] = [];
        if (args.isXpath) {
          try {
            const it = document.evaluate(args.rowSelector, document, null, 7, null); // ORDERED_NODE_SNAPSHOT_TYPE
            for (let i = 0; i < it.snapshotLength; i++) { const n = it.snapshotItem(i); if (n) allRows.push(n as Element); }
          } catch { allRows = []; }
        } else {
          try { allRows = Array.from(document.querySelectorAll(args.rowSelector)); } catch { allRows = []; }
        }
        if (allRows.length === 0) return null;

        // Distinct candidate tables, in DOM order (candidates[0] === old behaviour).
        const candidates: Element[] = [];
        for (let i = 0; i < allRows.length; i++) {
          const t = allRows[i]!.closest('table, [role="table"], [role="grid"], [role="treegrid"]');
          if (t && candidates.indexOf(t) === -1) candidates.push(t);
        }

        let table: Element | null = candidates.length > 0 ? candidates[0]! : allRows[0]!.closest('table, [role="table"], [role="grid"], [role="treegrid"]');

        // Disambiguate ONLY when there is a real choice + an expectation to match.
        if (table && args.expectedHeaders.length > 0 && candidates.length > 1) {
          let bestScore = -1;
          let best = table;
          for (let ti = 0; ti < candidates.length; ti++) {
            const cand = candidates[ti]!;
            let hdrEls: Element[] = Array.from(cand.querySelectorAll('thead th, thead [role="columnheader"]'));
            if (hdrEls.length === 0) hdrEls = Array.from(cand.querySelectorAll('[role="columnheader"]'));
            if (hdrEls.length === 0) { const ftr = cand.querySelector('tr'); if (ftr) hdrEls = Array.from(ftr.querySelectorAll(':scope > th')); }
            let score = 0;
            for (let hi = 0; hi < hdrEls.length; hi++) {
              const txt = (hdrEls[hi]!.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              if (txt === '') continue;
              for (let ei = 0; ei < args.expectedHeaders.length; ei++) {
                const exp = args.expectedHeaders[ei]!;
                if (exp !== '' && (txt === exp || txt.indexOf(exp) !== -1 || exp.indexOf(txt) !== -1)) { score++; break; }
              }
            }
            if (score > bestScore) { bestScore = score; best = cand; }
          }
          table = best;
        }

        // Representative body row INSIDE the chosen table (for bodyChildCount).
        let firstRow: Element | null = null;
        for (let i = 0; i < allRows.length; i++) { if (table && table.contains(allRows[i]!)) { firstRow = allRows[i]!; break; } }
        if (!firstRow) firstRow = allRows[0]!;

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
          let tk = '';
          if (table) {
            const tid = table.getAttribute('id');
            const tal = table.getAttribute('aria-label');
            if (tid && tid.trim() !== '') tk = 'id:' + tid.trim();
            else if (tal && tal.trim() !== '') tk = 'aria:' + tal.trim();
          }
          return { cells: [], roleKind, hasSpan: false, headerChildCount: 0, bodyChildCount, tableKey: tk };
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
          // Header text: visible text, then aria-label, then title — so an
          // icon-only header (no textContent) still anchors via its accessible
          // name. Authoring (finalize) and poll both read this same way, so the
          // match is apples-to-apples.
          let raw = (c.textContent || '').replace(/\s+/g, ' ').trim();
          if (raw === '') {
            const al = c.getAttribute('aria-label');
            if (al && al.trim()) raw = al.replace(/\s+/g, ' ').trim();
          }
          if (raw === '') {
            const ti = c.getAttribute('title');
            if (ti && ti.trim()) raw = ti.replace(/\s+/g, ' ').trim();
          }
          const text = raw.toLowerCase();
          cells.push({ index, text, raw });
        }
        // Durable table identity — id / aria-label win; else a header-text
        // fingerprint (plain loop, no closures per the esbuild gotcha above).
        let tableKey = '';
        if (table) {
          const tid = table.getAttribute('id');
          const tal = table.getAttribute('aria-label');
          if (tid && tid.trim() !== '') tableKey = 'id:' + tid.trim();
          else if (tal && tal.trim() !== '') tableKey = 'aria:' + tal.trim();
          else { let fp = ''; for (let i = 0; i < cells.length; i++) { fp += (i ? '|' : '') + cells[i]!.text; } tableKey = 'hdr:' + fp.slice(0, 200); }
        }
        // fix/cua-header-offset — LEADING-cell offset: the body has a few more
        // cells than the header (checkbox / action / icon columns at the front).
        // Accept only a SMALL (1..4) offset that is UNIFORM across the sampled
        // rows of the chosen table — else 0 (treat as misaligned, gate fails).
        const headerCount = headerRow ? headerRow.children.length : 0;
        let bodyOffset = 0;
        const off = bodyChildCount - headerCount;
        if (headerCount > 0 && off >= 1 && off <= 4 && firstRow) {
          // (a) the gap must be UNIFORM across the chosen table's sampled rows.
          let uniform = true; let counted = 0;
          for (let i = 0; i < allRows.length && counted < 5; i++) {
            if (table && table.contains(allRows[i]!)) {
              counted++;
              if (allRows[i]!.children.length !== bodyChildCount) { uniform = false; break; }
            }
          }
          // (b) the extra cells must be LEADING ACTION/ICON cells (button / input /
          //     checkbox / link / icon / empty) — NOT real data columns. This is
          //     what makes the offset safe + general: it only fires for the common
          //     "checkbox/action column at the front" shape, and refuses a table
          //     whose front cells hold actual data (where the gap is trailing /
          //     interleaved and a +offset shift would read the WRONG cell).
          let leadingAreControls = uniform;
          if (uniform) {
            const kids = firstRow.children;
            for (let i = 0; i < off; i++) {
              const cell = kids[i];
              if (!cell) { leadingAreControls = false; break; }
              const txt = (cell.textContent || '').replace(/\s+/g, ' ').trim();
              const hasControl = cell.querySelector('button, input, a, svg, img, i, [role="button"], [type="checkbox"]') !== null;
              if (txt !== '' && !hasControl) { leadingAreControls = false; break; }
            }
          }
          if (uniform && leadingAreControls) bodyOffset = off;
        }
        return {
          cells,
          roleKind,
          hasSpan,
          headerChildCount: headerCount,
          bodyChildCount,
          tableKey,
          bodyOffset,
        };
      },
      { rowSelector, isXpath: !!opts?.isXpath, expectedHeaders: (opts?.expectedHeaders ?? []).map((h) => h.toLowerCase()) },
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
  if (!h || h.cells.length === 0 || h.hasSpan || h.headerChildCount <= 0) return false;
  // Aligned table — the original gate (byte-identical).
  if (h.headerChildCount === h.bodyChildCount) return true;
  // fix/cua-header-offset — tolerate a small, validated LEADING offset (body has
  // a few extra front cells the header lacks). Only when readTableHeaders proved
  // it uniform (bodyOffset>0) AND it exactly accounts for the count gap — so a
  // genuine colspan/structural misalignment still fails the gate.
  const off = h.bodyOffset ?? 0;
  return off >= 1 && off === h.bodyChildCount - h.headerChildCount;
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
      // Skip NON-RENDERED rows BEFORE the cap. A PMS commonly keeps a hidden
      // JS template/prototype row as the first child of the tbody (e.g. Choice
      // Advantage's <tr id="roomConditionRow"> display:none) — reading it would
      // inject a blank junk row AND consume a cap slot. Drop display:none /
      // visibility:hidden / [hidden] / zero-box rows. A rect-only check misses
      // visibility:hidden (it keeps a layout box), so check computed style too.
      // Never drop on a predicate error (fault-isolate, like the per-cell try).
      const rendered = els.filter((el: Element) => {
        try {
          if (el.hasAttribute('hidden')) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        } catch { return true; }
      });
      const rows = rendered.slice(0, args.cap).map((el: Element) => {
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
      // Report the VISIBLE count so the over-cap (too_many_rows) branch and the
      // mapper's deadness/row-count telemetry classify on real rows, not a phantom
      // inflated by hidden template rows.
      return { rows, totalMatched: rendered.length };
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
      // Same visible-row filter as scrapeCssRows so the xpath read stays index-
      // aligned with the css read (the two are merged by row index downstream).
      const rendered = els.filter((el: Element) => {
        try {
          if (el.hasAttribute('hidden')) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        } catch { return true; }
      });
      return rendered.slice(0, args.cap).map((el: Element) => {
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
    // Count VISIBLE rows, not raw matches: if the css matches ONLY a hidden
    // template/prototype row (raw 1, visible 0), the reader would filter it to 0 —
    // so the xpath tier must engage to self-heal, exactly as on a real css break.
    try {
      cssCount = await page.$$eval(rowSelector, (els: Element[]) => els.filter((el: Element) => {
        try {
          if (el.hasAttribute('hidden')) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        } catch { return true; }
      }).length);
    } catch { cssCount = -1; }
    if (cssCount <= 0) {
      effectiveRowSelector = `xpath=${opts.rowSelectorTiered.xpath}`;
      rowSelectorTier = 'xpath';
      rowIsXpath = true;
    }
  }

  // 2. Header analysis — ONCE per scrape, only if some column carries a roleName.
  //    readTableHeaders evaluates the selector inside the page with
  //    document.evaluate (xpath) or querySelector (css), so it needs the RAW
  //    xpath, NOT Playwright's `xpath=`-prefixed form.
  const anyRoleName = !!opts.columnsTiered && Object.values(opts.columnsTiered).some((t) => !!t?.roleName);
  const headerSelector = rowIsXpath ? opts.rowSelectorTiered!.xpath! : effectiveRowSelector;
  // feature/cua-read-integrity — feed the LEARNED header labels so a generic
  // rowSelector that matches several tables resolves to the RIGHT one (the table
  // whose headers match what we learned), not just the first in DOM order.
  const expectedHeaders = opts.columnsTiered
    ? Object.values(opts.columnsTiered).map((t) => t?.roleName?.name).filter((n): n is string => !!n)
    : [];
  const headers = anyRoleName ? await readTableHeaders(page, headerSelector, { isXpath: rowIsXpath, expectedHeaders }) : null;
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

    // roleName tier — resolve header text → live index, rebase the css. We
    // self-heal ONLY on a UNIQUE header match. Duplicate headers (two "Date"
    // columns) and a missing/renamed header fall through to the positional css
    // tier — i.e. exactly today's behavior. Crucially we do NOT claim a roleName
    // resolution we didn't actually make: header anchoring can't distinguish two
    // identical headers, so reporting a self-heal there would be a telemetry lie
    // AND could silently read the wrong cell if those duplicates were reordered.
    const origIdx = parseFirstNthIndex(flatCss);
    if (tiered.roleName && gateOk && origIdx != null) {
      const matches = headerIndexByText.get(normalizeHeaderText(tiered.roleName.name)) ?? [];
      if (matches.length === 1) {
        // fix/cua-header-offset — the header cell sits at header-index matches[0];
        // the matching BODY cell is bodyOffset positions to its right (leading
        // action/icon cells). 0 for aligned tables (byte-identical).
        const targetIdx = matches[0]! + (headers!.bodyOffset ?? 0);
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
    // Identity guard: the css read and this xpath read are two SEPARATE DOM
    // snapshots merged purely by array index. If the page mutated between them
    // (auto-refresh, a still-rendering table, a row removed/reordered), their
    // visible-row filters no longer align and index i in one is a DIFFERENT row
    // in the other — attaching an xpath-column value to the wrong record. A
    // row-count mismatch is the cheap, reliable signal that the snapshots
    // diverged; drop the xpath columns for THIS poll rather than mis-align
    // (the next clean poll fills them). Mirrors the re-anchor probe's guard in
    // session-driver (`if (cext.rows.length !== rows.length) continue`).
    if (xrows.length === rows.length) {
      rows = rows.map((row, i) => ({ ...row, ...(xrows[i] ?? {}) }));
      for (const r of resolution) {
        if (xpathToRead[r.field] && (xrows[0]?.[r.field] ?? '') !== '') r.tier = 'xpath';
      }
    } else {
      log.warn('dom-rows: xpath-column read row-count mismatch — dropping xpath columns this poll (page shifted mid-read)', {
        cssRowCount: rows.length,
        xpathRowCount: xrows.length,
        fields: Object.keys(xpathToRead),
      });
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
