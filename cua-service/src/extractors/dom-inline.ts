/**
 * DOM inline extractor.
 *
 * Reads specific elements from a page and returns a single object
 * mapping field name -> trimmed text content. Used for Choice
 * Advantage's three Dashboard pages (ViewInHouseList, ViewArrivalsList,
 * ViewDeparturesList) where each page has a single "Room Count: N" cell
 * and we just want that one number.
 *
 * For multi-page extraction (3 dashboard pages → 1 snapshot row),
 * caller invokes this once per page and aggregates the results.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { safeGoto } from '../browser-utils/navigate.js';
import type { FeedSpec } from '../knowledge-file.js';

export interface DomInlineOptions {
  page: Page;
  feedSpec: FeedSpec;
  allowedHost: string;
  signal?: AbortSignal;
}

export interface DomInlineResult {
  ok: boolean;
  data: Record<string, string | null>;
  reason?: string;
}

const WAIT_TIMEOUT_MS = Number(process.env.CUA_ROW_WAIT_MS) || 15_000;
const RENDER_SETTLE_MS = Number(process.env.CUA_ROW_RENDER_MS) || 5_000;

export async function extractDomInline(opts: DomInlineOptions): Promise<DomInlineResult> {
  const { page, feedSpec, allowedHost, signal } = opts;
  const fields = feedSpec.columns;
  if (!fields || Object.keys(fields).length === 0) {
    return { ok: false, data: {}, reason: 'feedSpec missing columns (field -> selector map)' };
  }

  if (feedSpec.url) {
    try {
      await safeGoto(page, feedSpec.url, {
        allowedHost,
        context: 'extractor:dom_inline:goto',
      });
    } catch (err) {
      return { ok: false, data: {}, reason: `navigate failed: ${(err as Error).message}` };
    }
  }

  if (signal?.aborted) return { ok: false, data: {}, reason: 'aborted' };

  // Wait for at least one of the requested selectors to materialize.
  const firstSelector = Object.values(fields)[0];
  if (firstSelector) {
    // Gate on PRESENCE (state:'attached'), not the default 'visible' — a hidden
    // template node first in the match set (PMS-agnostic, the dom-table twin) would
    // otherwise hang the full timeout. Then a bounded best-effort wait for a
    // visible node to render (degrade to read); the read below picks the first
    // visible node.
    try {
      await page.waitForSelector(firstSelector, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, data: {}, reason: `selector did not appear: ${(err as Error).message}` };
    }
    await page.waitForFunction(
      (sel: string) => {
        let els: Element[] = [];
        try { els = Array.from(document.querySelectorAll(sel)); } catch { return true; }
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
      firstSelector,
      { timeout: RENDER_SETTLE_MS },
    ).catch(() => { /* degrade to read */ });
  }

  if (signal?.aborted) return { ok: false, data: {}, reason: 'aborted' };

  try {
    const data = await page.evaluate((fieldsMap: Record<string, string>) => {
      // Pick the first VISIBLE matching node, not just the first match (which can
      // be a hidden template node), falling back to the first match if none render.
      const isRendered = (el: Element): boolean => {
        try {
          if (el.hasAttribute('hidden')) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        } catch { return true; }
      };
      const out: Record<string, string | null> = {};
      for (const [field, sel] of Object.entries(fieldsMap)) {
        let el: Element | null = null;
        try {
          const all = Array.from(document.querySelectorAll(sel));
          el = all.find(isRendered) ?? all[0] ?? null;
        } catch { el = null; }
        out[field] = el ? (el.textContent ?? '').trim() : null;
      }
      return out;
    }, fields);

    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: {}, reason: `evaluate failed: ${(err as Error).message}` };
  }
}
