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
  const { page, jobId, propertyId, pmsFamily, feedKey } = args;
  // A durable row needs all three NOT NULL columns; without them there is
  // nothing meaningful to persist, so skip the (paid) screenshot entirely.
  if (!jobId || !propertyId || !pmsFamily) return;

  const capture = deps?.capture ?? captureHardenedScreenshot;
  const clearMarks = deps?.clearMarks ?? ((p: Page) => clearSetOfMark(p));
  const upload = deps?.upload ?? defaultUpload;
  const insertRow = deps?.insertRow ?? defaultInsertRow;

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
  } catch (err) {
    log.warn('feed-capture: provenance capture failed (non-fatal)', {
      jobId, feedKey, err: (err as Error).message,
    });
  }
}
