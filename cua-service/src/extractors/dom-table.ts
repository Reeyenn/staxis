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
const WAIT_TIMEOUT_MS = 15_000;

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

  try {
    await page.waitForSelector(rowSelector, { timeout: WAIT_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, rows: [], reason: `row selector did not appear: ${(err as Error).message}` };
  }

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  try {
    // Shared reader (extractors/dom-rows.ts) — the SAME implementation the
    // mapper verifies selectors with, including the '@attr' convention. Any
    // fork here re-opens the "verified at mapping, blank at poll" bug class.
    //
    // feature/cua-semantic-columns — the durable per-column header anchors (and
    // an optional rowSelector xpath fallback) ride feedSpec.extra: the runtime
    // FeedSpec / template-runner bridge forwards only `extra` verbatim, so
    // recipe-adapter mirrors source.columnsTiered/rowSelectorTiered there. Absent
    // ⟹ the reader takes its byte-identical legacy path.
    const columnsTiered = feedSpec.extra?.columnsTiered as Record<string, TieredSelector> | undefined;
    const rowSelectorTiered = feedSpec.extra?.rowSelectorTiered as TieredSelector | undefined;
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
