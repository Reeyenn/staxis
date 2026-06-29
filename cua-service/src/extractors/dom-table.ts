/**
 * DOM table extractor.
 *
 * Generic: navigate to the feed's URL (if specified), wait for the row
 * selector to materialize, scrape each row using the column map. Returns
 * an array of objects keyed by canonical field name.
 *
 * Used for Choice Advantage's Housekeeping Center page (room conditions,
 * HK assignments). Future PMSes' tabular views (Mews reservation list,
 * etc.) plug in here without any extractor changes — they just need a
 * matching FeedSpec in the knowledge file.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { safeGoto } from '../browser-utils/navigate.js';
import { extractDomRows } from './dom-rows.js';
import { parsePreSteps, replayPreSteps } from './pre-steps.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { LearnedDateFormat, TieredSelector } from '../types.js';

export interface DomTableExtractOptions {
  page: Page;
  feedSpec: FeedSpec;
  allowedHost: string;
  signal?: AbortSignal;
  /** Hard cap on rows to prevent runaway DOM scrape on a too-broad selector. */
  maxRows?: number;
}

export interface DomTableExtractResult {
  ok: boolean;
  rows: Array<Record<string, string>>;
  reason?: string;
}

const DEFAULT_MAX_ROWS = 5000;
const ROW_SELECTOR_KEY = 'rowSelector';
// Presence wait (how long to wait for ANY matching row to attach). Env-overridable
// as a live ops escape hatch (read at module load).
const WAIT_TIMEOUT_MS = Number(process.env.CUA_ROW_WAIT_MS) || 15_000;
// Bounded best-effort wait for a row to actually RENDER, after presence is
// confirmed. Degrades to a read attempt on timeout (the reader filters hidden rows).
const RENDER_SETTLE_MS = Number(process.env.CUA_ROW_RENDER_MS) || 5_000;

/** Best-effort, BOUNDED wait for at least one VISIBLE row matching `sel` (css or
 *  raw xpath) to paint — gives async-rendered rows a moment to settle after
 *  presence is confirmed (safeGoto only waits domcontentloaded). DEGRADES TO READ
 *  on timeout: the row-reader's visible filter is the real correctness guarantee,
 *  so a hidden-template-only or genuinely-empty feed simply reads 0 rows rather
 *  than hanging. Visible = not [hidden]/display:none/visibility:hidden/opacity:0
 *  and a non-zero box (matches the codebase's house predicate). */
async function settleForVisibleRow(page: Page, sel: string, isXpath: boolean): Promise<void> {
  await page.waitForFunction(
    (a: { sel: string; isXpath: boolean }) => {
      let els: Element[] = [];
      try {
        if (a.isXpath) {
          const snap = document.evaluate(a.sel, document, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
          for (let i = 0; i < snap.snapshotLength; i++) { const n = snap.snapshotItem(i); if (n && n.nodeType === 1) els.push(n as Element); }
        } else {
          els = Array.from(document.querySelectorAll(a.sel));
        }
      } catch { return true; }
      return els.some((el: Element) => {
        try {
          if (el.hasAttribute('hidden')) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        } catch { return true; }
      });
    },
    { sel, isXpath },
    { timeout: RENDER_SETTLE_MS },
  ).catch(() => { /* degrade to read — the reader filters hidden rows */ });
}

export async function extractDomTable(opts: DomTableExtractOptions): Promise<DomTableExtractResult> {
  const { page, feedSpec, allowedHost, signal } = opts;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  const rowSelector = feedSpec.selectors?.[ROW_SELECTOR_KEY];
  const columns = feedSpec.columns;

  if (!rowSelector || !columns || Object.keys(columns).length === 0) {
    return {
      ok: false,
      rows: [],
      reason: 'feedSpec missing selectors.rowSelector or columns map',
    };
  }

  if (feedSpec.url) {
    try {
      await safeGoto(page, feedSpec.url, {
        allowedHost,
        context: 'extractor:dom_table:goto',
      });
    } catch (err) {
      return { ok: false, rows: [], reason: `navigate failed: ${(err as Error).message}` };
    }
  }

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  // feature/cua-feed-extract — replay the in-page interaction flow the mapper
  // recorded to reach this feed WITHOUT a url change (an SPA route swap, or an
  // in-page "Generate"/filter click on a report page). recipe-adapter carries
  // these on extra.preSteps; directly-navigable feeds have none. Mirrors the
  // csv-download extractor's pre-step replay — same credential hygiene and
  // stale-date {today} rendering. A malformed list or a failed replay fails the
  // feed loudly rather than scraping a half-navigated page.
  const parsedPre = parsePreSteps(feedSpec.extra?.preSteps);
  if (!parsedPre.ok) {
    return { ok: false, rows: [], reason: `invalid preSteps: ${parsedPre.reason}` };
  }
  if (parsedPre.steps.length > 0) {
    const replay = await replayPreSteps(page, parsedPre.steps, {
      signal,
      learnedFormat: feedSpec.extra?.dateRender as LearnedDateFormat | undefined,
      timezone: feedSpec.extra?.timezone as string | undefined,
    });
    if (!replay.ok) {
      return { ok: false, rows: [], reason: replay.reason };
    }
  }

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  // feature/cua-semantic-columns — the durable per-column header anchors (and an
  // optional rowSelector xpath fallback) ride feedSpec.extra: the runtime
  // FeedSpec / template-runner bridge forwards only `extra` verbatim, so
  // recipe-adapter mirrors source.columnsTiered/rowSelectorTiered there. Absent
  // ⟹ the reader takes its byte-identical legacy path.
  const columnsTiered = feedSpec.extra?.columnsTiered as Record<string, TieredSelector> | undefined;
  const rowSelectorTiered = feedSpec.extra?.rowSelectorTiered as TieredSelector | undefined;

  // Wait for the rows to materialize. Gate on PRESENCE (state:'attached'), NOT
  // the default 'visible' state. A PMS commonly keeps a hidden template/prototype
  // row as the FIRST match (e.g. Choice Advantage's <tr id="roomConditionRow">),
  // and the default visible-wait gates on that first element → 15s timeout even
  // with dozens of real rows present (the PMS-agnostic 0-rows bug). The css
  // rowSelector is primary; if it never appears AND an xpath tier exists, wait on
  // the xpath instead — without this pre-wait fallback the reader's own row-xpath
  // tier could never engage on a broken css selector (it returns early here first).
  let presentSel: { sel: string; isXpath: boolean } | null = null;
  try {
    await page.waitForSelector(rowSelector, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
    presentSel = { sel: rowSelector, isXpath: false };
  } catch (err) {
    if (rowSelectorTiered?.xpath) {
      try {
        await page.waitForSelector(`xpath=${rowSelectorTiered.xpath}`, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
        presentSel = { sel: rowSelectorTiered.xpath, isXpath: true };
      } catch {
        return { ok: false, rows: [], reason: `row selector did not appear (css + xpath): ${(err as Error).message}` };
      }
    } else {
      return { ok: false, rows: [], reason: `row selector did not appear: ${(err as Error).message}` };
    }
  }

  // Best-effort render-settle on WHICHEVER selector attached (css or xpath): the
  // old visible-wait silently doubled as an async-render settle (safeGoto only
  // waits domcontentloaded). Give a real VISIBLE row a bounded moment to paint,
  // degrading to a read on timeout — the reader's visible-row filter is the real
  // correctness guarantee, and a genuinely-empty feed then reads 0 rows rather
  // than falsely hanging the full timeout.
  await settleForVisibleRow(page, presentSel.sel, presentSel.isXpath);

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  try {
    // Shared reader (extractors/dom-rows.ts) — the SAME implementation the
    // mapper verifies selectors with, including the '@attr' convention. Any
    // fork here re-opens the "verified at mapping, blank at poll" bug class.
    const extraction = await extractDomRows(page, rowSelector, columns, {
      cap: maxRows,
      ...(columnsTiered ? { columnsTiered } : {}),
      ...(rowSelectorTiered ? { rowSelectorTiered } : {}),
    });
    const { rows, totalMatched } = extraction;

    // Tier telemetry — CSS-drift / self-heal observability over weeks. One
    // compact line per poll, only when tiered selectors were actually in play.
    if (extraction.resolution && extraction.resolution.length > 0) {
      const tiers = { roleName: 0, css: 0, xpath: 0, legacy: 0 };
      for (const r of extraction.resolution) tiers[r.tier]++;
      const selfHealed = extraction.resolution
        .filter((r) => r.drift)
        .map((r) => `${r.field}:${r.fromIndex}->${r.toIndex}`);
      log.info('extractor:dom_table tier resolution', {
        rowSelector,
        rowSelectorTier: extraction.rowSelectorTier,
        tiers,
        ...(selfHealed.length > 0 ? { selfHealed } : {}),
      });
    }

    if (totalMatched > maxRows) {
      log.warn('extractor:dom_table: row count over cap, truncating', {
        rowSelector,
        rowCount: totalMatched,
        cap: maxRows,
      });
      return {
        ok: false,
        rows,
        reason: `too_many_rows: ${totalMatched} > ${maxRows} — refine rowSelector`,
      };
    }

    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], reason: `scrape failed: ${(err as Error).message}` };
  }
}
