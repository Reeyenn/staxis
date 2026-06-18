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
 *
 * feature/cua-feed-replay — replay-fidelity fixes so a feed the vision mapper
 * learned actually extracts on deterministic replay:
 *   1. Row pre-wait uses state:'attached' (NOT 'visible'). The reader
 *      (dom-rows scrapeCssRows) reads textContent off attached nodes with no
 *      visibility filter, so 'visible' was strictly stronger than the reader
 *      and timed out on present-but-hidden rows (e.g. CA's collapsed HK table —
 *      this is the bug that left room_status at 0 rows).
 *   2. A re-auth bounce after navigation/interaction fails the feed with
 *      bounced_to_reauth (the next poll's logged-out probe re-logs-in) instead
 *      of scraping login chrome — and never lets a reconcile feed auto-resolve
 *      live rows from a 0-row read that was really a bounce. The guard runs
 *      BEFORE the preSteps replay too, so we never click/fill login chrome.
 *   (Note: pre-step clicks resolve by ARIA role+name first — see pre-steps.ts.)
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { safeGoto, detectReauthBounce } from '../browser-utils/navigate.js';
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

  // Re-auth guard (post-goto, BEFORE preSteps): if navigation bounced us to a
  // login screen, fail loudly with bounced_to_reauth rather than replaying
  // clicks/fills onto login chrome (and never let a reconcile feed treat this
  // as "all rows disappeared").
  if (await detectReauthBounce(page)) {
    return { ok: false, rows: [], reason: 'bounced_to_reauth' };
  }

  // feature/cua-feed-extract — replay the in-page interaction flow the mapper
  // recorded to reach this feed (an SPA route swap, or an in-page
  // "Generate"/filter click). recipe-adapter carries these on extra.preSteps;
  // directly-navigable feeds have none. Pre-step clicks resolve by ARIA
  // role+name first (pre-steps.clickRecorded). A malformed list or a failed
  // replay fails the feed loudly rather than scraping a half-navigated page.
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
    // Re-auth guard (post-preSteps): an interaction can also bounce to login.
    if (await detectReauthBounce(page)) {
      return { ok: false, rows: [], reason: 'bounced_to_reauth' };
    }
  }

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  // feature/cua-semantic-columns — the durable per-column header anchors (and an
  // optional rowSelector xpath fallback) ride feedSpec.extra. Absent ⟹ the
  // reader takes its byte-identical legacy path.
  const columnsTiered = feedSpec.extra?.columnsTiered as Record<string, TieredSelector> | undefined;
  const rowSelectorTiered = feedSpec.extra?.rowSelectorTiered as TieredSelector | undefined;

  // Wait for the rows to materialize. state:'attached' (see header #1) aligns
  // the gate with the presence-reader; the css rowSelector is primary, with an
  // xpath tier fallback so the reader's row-xpath tier can engage.
  try {
    await page.waitForSelector(rowSelector, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
  } catch (err) {
    if (rowSelectorTiered?.xpath) {
      try {
        await page.waitForSelector(`xpath=${rowSelectorTiered.xpath}`, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
      } catch {
        return { ok: false, rows: [], reason: `row selector did not appear (css + xpath): ${(err as Error).message}` };
      }
    } else {
      return { ok: false, rows: [], reason: `row selector did not appear: ${(err as Error).message}` };
    }
  }

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

    // Tier telemetry — CSS-drift / self-heal observability over weeks.
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
