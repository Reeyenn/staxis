/**
 * feed-capture.ts — durable per-feed PROVENANCE screenshot
 * (feature/cua-mapper-phases-captures).
 *
 * When the mapper successfully extracts a feed, it captures ONE masked
 * screenshot of the screen it read the feed off — the provenance image the
 * admin live view shows next to "Arrivals: found 30 rows". Unlike the live
 * frame (`{jobId}/live.png`, a single overwrite-in-place object deleted on job
 * teardown), these are DURABLE: one object per feed at
 * `{jobId}/feeds/{feedKey}.png` (upsert), kept after the job ends so the board
 * can show "here's where this came from" long after the run.
 *
 * DURABILITY CONTRACT
 * ───────────────────
 * The feeds/ objects must survive job teardown. They do, because nothing
 * deletes them by prefix:
 *   - live-frame.ts close() removes ONLY the exact key `{jobId}/live.png`.
 *   - the expire-help-requests cron removes ONLY explicit keys (help-card
 *     screenshots + `{jobId}/live.png`), never a `{jobId}/` prefix list.
 *   - no `.list()` + bulk-remove exists anywhere on this bucket.
 * Do NOT add a prefix wipe of `{jobId}/` anywhere or it will take these out.
 *
 * PRIVACY CONTRACT
 * ────────────────
 * The image is produced by captureHardenedScreenshot (screenshot-privacy.ts),
 * which masks credential/SSN/CC fields in every frame and returns `null` when
 * it can't guarantee a masked image — in which case we upload + record NOTHING
 * for that feed (withhold, never a raw screenshot). The bucket is private
 * (service-role only).
 *
 * READER (companion, not in this unit): the worker only WRITES here. The admin
 * provenance UI and its supabaseAdmin/signed-URL read route are built by the
 * web app (parallel chat) to this contract; until that lands the rows + objects
 * are produced but not yet surfaced. The provenance view should treat "a found
 * feed with no capture row" as normal — drilldown-sample feeds deliberately
 * have none (see the dispatch note in mapper.ts).
 *
 * Best-effort: every path is wrapped so a capture/upload/insert failure can
 * never throw into — or stall fatally — the mapping run. Deps are injectable
 * (live-frame.ts convention) so unit tests exercise the logic with no real
 * Playwright/Supabase.
 */

import type { Page } from 'playwright';
import { log } from './log.js';
import { captureHardenedScreenshot } from './screenshot-privacy.js';
import { clearSetOfMark } from './set-of-mark.js';

/** Same private bucket the live frame / help cards / takeover share. */
const BUCKET = 'mapping-screenshots';

/** The mapping_feed_captures row shape (migration 0283). */
export interface FeedCaptureRow {
  job_id: string;
  property_id: string;
  pms_family: string;
  feed_key: string;
  screenshot_path: string;
}

export interface FeedCaptureArgs {
  page: Page;
  /** All three are required for a durable row; null in dev/test → no-op. */
  jobId: string | null;
  propertyId: string | null;
  pmsFamily: string | null;
  feedKey: string;
  /** feature/cua-click-to-map — when this is a table feed, the row selector lets
   *  us also capture each DATA column's on-screen box (aligned to the viewport
   *  screenshot), so the admin can drag-select a column on the screenshot to add
   *  it — no re-map. Omitted for non-table feeds → no geometry captured. */
  rowSelector?: string;
}

/** feature/cua-click-to-map — one DATA column's on-screen box, in viewport CSS
 *  px (same coordinate space as the fullPage:false provenance screenshot), plus
 *  the nth-child the runtime would read it with and the header label above it. */
export interface ColumnBox {
  /** 1-based body nth-child index — the selector is `td:nth-child(index)`. */
  index: number;
  /** Aligned header label for this column (''+ when headerless / unaligned). */
  header: string;
  x: number; y: number; w: number; h: number;
}

/** The sibling `{jobId}/feeds/{feedKey}.boxes.json` payload. The viewport dims
 *  are the box coordinate space — the UI scales boxes by renderedImg/viewport. */
export interface ColumnGeometry {
  viewport: { w: number; h: number };
  columns: ColumnBox[];
}

/** Injection points (mirrors LiveFrameDeps). Production passes none. */
export interface FeedCaptureDeps {
  /** Privacy-masked PNG (Buffer) or null when masking can't be guaranteed. */
  capture?: (page: Page) => Promise<Buffer | null>;
  /** Clear any Set-of-Mark badges so the provenance shot is clean. */
  clearMarks?: (page: Page) => Promise<void>;
  /** Upload (upsert) the durable feed object. Throws on failure. */
  upload?: (objectKey: string, png: Buffer) => Promise<void>;
  /** Insert the mapping_feed_captures row. Throws on failure. */
  insertRow?: (row: FeedCaptureRow) => Promise<void>;
  /** feature/cua-click-to-map — capture the per-column geometry (null = skip). */
  captureGeometry?: (page: Page, rowSelector: string) => Promise<ColumnGeometry | null>;
  /** Upload the sibling boxes JSON. Throws on failure. */
  uploadBoxes?: (objectKey: string, geometry: ColumnGeometry) => Promise<void>;
}

/** Storage keys must be filesystem-ish; feedKey is a recipe action name
 *  (getRoomStatus, …) but sanitize defensively, exactly like the help-card
 *  path in human-assist.ts. */
function sanitizeFeedKey(feedKey: string): string {
  return feedKey.replace(/[^a-z0-9_-]/gi, '_');
}

/** The durable object key for a feed's provenance screenshot. Exported so the
 *  web side (and tests) can reconstruct it deterministically. */
export function feedScreenshotPath(jobId: string, feedKey: string): string {
  return `${jobId}/feeds/${sanitizeFeedKey(feedKey)}.png`;
}

/** feature/cua-click-to-map — sibling key holding the column geometry JSON. */
export function feedColumnBoxesPath(jobId: string, feedKey: string): string {
  return `${jobId}/feeds/${sanitizeFeedKey(feedKey)}.boxes.json`;
}

/**
 * Capture each DATA column's on-screen box from the table `rowSelector` points
 * at, in viewport CSS px (the fullPage:false screenshot's coordinate space).
 * Uses the FIRST body row's cells for x-ranges (so a dragged box maps to the
 * real data column + its nth-child), the table for the vertical extent, and the
 * header row for labels (offset-aligned). Best-effort: returns null on anything
 * unexpected (caller just skips geometry). Inline-only (no closures) — esbuild
 * `__name` gotcha, same as readTableHeaders.
 */
async function captureColumnGeometry(page: Page, rowSelector: string): Promise<ColumnGeometry | null> {
  try {
    const raw = await page.evaluate((sel: string) => {
      let firstRow: Element | null = null;
      try { firstRow = document.querySelector(sel); } catch { firstRow = null; }
      if (!firstRow) return null;
      const table = firstRow.closest('table, [role="table"], [role="grid"], [role="treegrid"]');
      if (!table) return null;
      const tRect = table.getBoundingClientRect();
      // Header labels by header-cell index (1-based).
      let headerCells: Element[] = Array.from(table.querySelectorAll('thead th, thead [role="columnheader"]'));
      if (headerCells.length === 0) headerCells = Array.from(table.querySelectorAll('[role="columnheader"]'));
      if (headerCells.length === 0) { const ftr = table.querySelector('tr'); if (ftr) headerCells = Array.from(ftr.querySelectorAll(':scope > th')); }
      const headerText: string[] = [];
      for (let i = 0; i < headerCells.length; i++) headerText.push((headerCells[i]!.textContent || '').replace(/\s+/g, ' ').trim());
      const bodyKids = Array.from(firstRow.children);
      const off = bodyKids.length > headerText.length ? bodyKids.length - headerText.length : 0;
      const columns: Array<{ index: number; header: string; x: number; y: number; w: number; h: number }> = [];
      for (let i = 0; i < bodyKids.length; i++) {
        const r = bodyKids[i]!.getBoundingClientRect();
        if (r.width <= 0) continue;
        const hIdx = i - off; // header index aligned to this body cell (leading offset)
        const header = hIdx >= 0 && hIdx < headerText.length ? headerText[hIdx]! : '';
        columns.push({ index: i + 1, header, x: r.left, y: tRect.top, w: r.width, h: tRect.height });
      }
      if (columns.length === 0) return null;
      return { viewport: { w: window.innerWidth, h: window.innerHeight }, columns };
    }, rowSelector);
    return (raw as ColumnGeometry | null) ?? null;
  } catch (err) {
    log.warn('feed-capture: column geometry capture failed (non-fatal)', { rowSelector, message: (err as Error).message });
    return null;
  }
}

async function defaultUploadBoxes(objectKey: string, geometry: ColumnGeometry): Promise<void> {
  const { supabase } = await import('./supabase.js');
  const { error } = await supabase.storage.from(BUCKET).upload(objectKey, Buffer.from(JSON.stringify(geometry)), {
    contentType: 'application/json', cacheControl: '60', upsert: true,
  });
  if (error) throw new Error(error.message);
}

async function defaultUpload(objectKey: string, png: Buffer): Promise<void> {
  const { supabase } = await import('./supabase.js');
  const { error } = await supabase.storage.from(BUCKET).upload(objectKey, png, {
    contentType: 'image/png',
    // Durable (unlike live.png's '0') — the object is stable per feed; a short
    // cache is fine since upsert overwrites the same key only on a re-map.
    cacheControl: '60',
    upsert: true,
  });
  if (error) throw new Error(error.message);
}

async function defaultInsertRow(row: FeedCaptureRow): Promise<void> {
  const { supabase } = await import('./supabase.js');
  const { error } = await supabase.from('mapping_feed_captures').insert(row);
  if (error) throw new Error(error.message);
}

/**
 * Capture + upload + record a durable provenance screenshot for one feed.
 * No-op (returns) when jobId/propertyId/pmsFamily aren't all present (dev/test
 * or a no-board run), or when a reliably-masked image can't be produced.
 * Never throws.
 */
export async function captureFeedProvenanceScreenshot(
  args: FeedCaptureArgs,
  deps?: FeedCaptureDeps,
): Promise<void> {
  const { page, jobId, propertyId, pmsFamily, feedKey, rowSelector } = args;
  // A durable row needs all three NOT NULL columns; without them there is
  // nothing meaningful to persist, so skip the (paid) screenshot entirely.
  if (!jobId || !propertyId || !pmsFamily) return;

  const capture = deps?.capture ?? captureHardenedScreenshot;
  const clearMarks = deps?.clearMarks ?? ((p: Page) => clearSetOfMark(p));
  const upload = deps?.upload ?? defaultUpload;
  const insertRow = deps?.insertRow ?? defaultInsertRow;
  const captureGeometry = deps?.captureGeometry ?? captureColumnGeometry;
  const uploadBoxes = deps?.uploadBoxes ?? defaultUploadBoxes;

  try {
    // Remove Set-of-Mark badges first so the saved provenance image is the raw
    // PMS page, not the agent's click overlay (mirrors the help-card path).
    await clearMarks(page).catch(() => {});
    const png = await capture(page);
    if (!png) {
      log.warn('feed-capture: provenance screenshot withheld (could not guarantee redaction)', {
        jobId, feedKey,
      });
      return;
    }
    const objectKey = feedScreenshotPath(jobId, feedKey);
    await upload(objectKey, png);
    // Only record the row AFTER a successful upload, so a row can never point
    // at a missing object.
    await insertRow({
      job_id: jobId,
      property_id: propertyId,
      pms_family: pmsFamily,
      feed_key: feedKey,
      screenshot_path: objectKey,
    });
    log.info('feed-capture: durable provenance screenshot saved', {
      jobId, feedKey, objectKey,
    });
    // feature/cua-click-to-map — best-effort per-column geometry alongside the
    // screenshot, so the admin can drag-select a column on it. Captured AFTER
    // the screenshot (same viewport state); a failure here never affects the
    // screenshot/row above. Only for table feeds (rowSelector present).
    if (rowSelector) {
      try {
        const geometry = await captureGeometry(page, rowSelector);
        if (geometry && geometry.columns.length > 0) {
          await uploadBoxes(feedColumnBoxesPath(jobId, feedKey), geometry);
          log.info('feed-capture: column geometry saved', { jobId, feedKey, columns: geometry.columns.length });
        }
      } catch (gErr) {
        log.warn('feed-capture: column geometry upload failed (non-fatal)', { jobId, feedKey, err: (gErr as Error).message });
      }
    }
  } catch (err) {
    log.warn('feed-capture: provenance capture failed (non-fatal)', {
      jobId, feedKey, err: (err as Error).message,
    });
  }
}
