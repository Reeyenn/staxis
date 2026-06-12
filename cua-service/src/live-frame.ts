/**
 * live-frame.ts — continuous "robot's screen" tee for the admin Learning
 * Board (feature/cua-live-view).
 *
 * The Learning Board used to show the robot's screen only at a help moment
 * (pending mapping_help_requests row). This module gives the board a LIVE
 * view the whole run: each vision screenshot the mapper already takes is
 * tee'd here and stored as the single "latest frame" object for the job —
 * `${jobId}/live.png` in the private `mapping-screenshots` bucket — then a
 * metadata-only `live_frame` event nudges the board to re-fetch a fresh
 * signed URL (mapping-driver wires `notify`). The image itself NEVER rides
 * the realtime channel: the board subscribes to `mapping:{jobId}` with the
 * anon client, so that channel must be treated as anon-readable.
 *
 * PRIVACY CONTRACT
 * ────────────────
 * `publish()` input MUST be `exec.screenshotB64` from executeVisionAction's
 * `screenshot` action — i.e. the output of `captureHardenedScreenshot`
 * (screenshot-privacy.ts), which masks credential/SSN/CC fields in every
 * frame (all sub-frames included) and withholds the image entirely when a
 * reliably-masked capture can't be produced. Never feed this module a raw
 * `page.screenshot()`.
 *
 * CONTENTION CONTRACT
 * ───────────────────
 * This module never touches Page/Browser — it only re-uses an in-memory
 * buffer the mapper already produced, so it cannot compete for the
 * single-flight browser mutex. `publish()` is synchronous fire-and-forget
 * (never throws, returns void); all I/O happens on a detached promise
 * chain the mapper never awaits.
 *
 * COST GATE (zero-cost when nobody's looking)
 * ───────────────────────────────────────────
 * Frames upload ONLY while an admin heartbeat is fresh: `accounts` rows
 * with role='admin' and last_seen_at within the last 2 minutes (the board
 * + /admin/property-sessions ping /api/admin/heartbeat every 30s while
 * visible). The check is cached for 15s per publisher and FAILS CLOSED on
 * query errors — no provable audience, no upload. Same query shape as
 * human-assist.ts isAnyAdminOnline(), narrower window (that one gates
 * help-requests at 5 min and is deliberately untouched).
 *
 * STORAGE HYGIENE
 * ───────────────
 * One object per job, overwritten in place (`upsert: true`); `close()` —
 * called from runMappingJob's finally on success, failure, throw and abort
 * — awaits any in-flight pipeline, then removes the object. A hard crash
 * that skips finally leaks at most one ~200KB redacted object per job; the
 * expire-help-requests cron sweeps those for terminal jobs.
 */

import { log } from './log.js';

// supabase.js is imported LAZILY inside the default deps (first real use)
// rather than at module load: the realtime stack inside the client requires
// a WebSocket implementation that local Node 20 test runs don't have, and
// the unit tests inject all I/O via deps anyway. Production order is
// unchanged — mapping-driver (the only prod caller) already imports
// supabase.js at boot.

/** Bucket shared with the help-card flow (human-assist.ts). */
const BUCKET = 'mapping-screenshots';
/** Admin heartbeat freshness window — "someone is actually watching". */
const WATCH_WINDOW_MS = 2 * 60_000;
/** Watch-gate result (true OR false) cache TTL. */
const WATCH_CACHE_MS = 15_000;
/** Floor between accepted frames — bounds upload bandwidth. */
const MIN_PUBLISH_INTERVAL_MS = 1_200;
/** Quiet period after a storage failure before trying again. */
const FAILURE_BACKOFF_MS = 15_000;

/**
 * Test injection points (matches the critic.ts optional-deps convention —
 * no module mocking needed). Production callers pass only `notify`.
 */
export interface LiveFrameDeps {
  /** Count admins whose last_seen_at >= cutoffIso. Throws on query error. */
  countWatchingAdmins?: (cutoffIso: string) => Promise<number>;
  /** Upload (overwrite) the frame at objectKey. Throws on failure. */
  upload?: (objectKey: string, png: Buffer) => Promise<void>;
  /** Remove the frame object. Throws on failure. */
  remove?: (objectKey: string) => Promise<void>;
  /** Fired after each successful upload (driver broadcasts `live_frame`). */
  notify?: () => void;
  /** Clock override for deterministic interval/backoff tests. */
  now?: () => number;
}

export interface LiveFramePublisher {
  /** Fire-and-forget; NEVER throws; the mapper must not await anything. */
  publish(pngBase64: string): void;
  /** Stop accepting frames, await in-flight work, delete the object. */
  close(): Promise<void>;
}

async function defaultCountWatchingAdmins(cutoffIso: string): Promise<number> {
  const { supabase } = await import('./supabase.js');
  const { count, error } = await supabase
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .gte('last_seen_at', cutoffIso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function defaultUpload(objectKey: string, png: Buffer): Promise<void> {
  const { supabase } = await import('./supabase.js');
  // cacheControl '0': the key is overwritten in place, so the storage CDN
  // must never hold a frame (the signed-URL route also varies a cacheNonce).
  const { error } = await supabase.storage.from(BUCKET).upload(objectKey, png, {
    contentType: 'image/png',
    cacheControl: '0',
    upsert: true,
  });
  if (error) throw new Error(error.message);
}

async function defaultRemove(objectKey: string): Promise<void> {
  const { supabase } = await import('./supabase.js');
  const { error } = await supabase.storage.from(BUCKET).remove([objectKey]);
  if (error) throw new Error(error.message);
}

export function createLiveFramePublisher(
  jobId: string,
  deps?: LiveFrameDeps,
): LiveFramePublisher {
  const now = deps?.now ?? Date.now;
  const countWatchingAdmins = deps?.countWatchingAdmins ?? defaultCountWatchingAdmins;
  const upload = deps?.upload ?? defaultUpload;
  const remove = deps?.remove ?? defaultRemove;
  const objectKey = `${jobId}/live.png`;

  let closed = false;
  /**
   * The WHOLE in-flight pipeline (gate query + decode + upload), tracked as
   * one promise. Set synchronously at publish-acceptance — before any await
   * — so a frame parked in a slow watch-gate query also blocks later
   * publishes (prevents out-of-order overwrites where an older frame lands
   * last). close() awaits this, so teardown can't race a partial upload.
   */
  let busy: Promise<void> | null = null;
  /**
   * 1-deep latest-frame slot: a frame arriving while busy REPLACES any
   * waiting frame instead of queueing. A multi-screenshot burst therefore
   * ends showing the newest frame, and the last frame before a long pause
   * still lands — at most 2 uploads per burst.
   */
  let pendingB64: string | null = null;
  let lastAcceptedAt = Number.NEGATIVE_INFINITY;
  let lastFailureAt = Number.NEGATIVE_INFINITY;
  let watchCache: { at: number; watching: boolean } | null = null;

  async function isAdminWatching(): Promise<boolean> {
    const t = now();
    if (watchCache && t - watchCache.at < WATCH_CACHE_MS) return watchCache.watching;
    let watching = false;
    try {
      const cutoffIso = new Date(t - WATCH_WINDOW_MS).toISOString();
      watching = (await countWatchingAdmins(cutoffIso)) > 0;
    } catch (err) {
      // Fail closed: if we can't prove an audience, don't spend the upload.
      log.warn('live-frame: watch query failed — treating as not watching', {
        jobId, err: (err as Error).message,
      });
    }
    watchCache = { at: t, watching };
    return watching;
  }

  /** One frame through gate → decode → upload → notify. Never throws. */
  async function runPipeline(b64: string): Promise<void> {
    if (now() - lastFailureAt < FAILURE_BACKOFF_MS) return;
    // Gate BEFORE the base64 decode — a dropped frame costs nothing.
    if (!(await isAdminWatching())) return;
    const png = Buffer.from(b64, 'base64');
    try {
      await upload(objectKey, png);
    } catch (err) {
      lastFailureAt = now();
      log.warn('live-frame: upload failed (non-fatal, backing off)', {
        jobId, err: (err as Error).message,
      });
      return;
    }
    try {
      deps?.notify?.();
    } catch {
      // notify is best-effort — a broadcast hiccup must not cost the frame.
    }
  }

  function publish(pngBase64: string): void {
    try {
      if (closed) return;
      if (busy) {
        // Latest-wins: replace, never queue.
        pendingB64 = pngBase64;
        return;
      }
      const t = now();
      if (t - lastAcceptedAt < MIN_PUBLISH_INTERVAL_MS) return;
      lastAcceptedAt = t;
      busy = (async () => {
        // Drain loop: the pending slot is flushed after the current frame
        // settles. The flush deliberately bypasses the min-interval (it IS
        // the newest frame) but re-runs the gate + backoff checks.
        let current: string | null = pngBase64;
        while (current !== null) {
          await runPipeline(current);
          if (closed) break;
          current = pendingB64;
          pendingB64 = null;
          if (current !== null) lastAcceptedAt = now();
        }
      })()
        .catch((err) => {
          // runPipeline never throws; this is a belt-and-braces guard so the
          // publisher can never produce an unhandled rejection.
          log.warn('live-frame: pipeline error swallowed', {
            jobId, err: (err as Error).message,
          });
        })
        .finally(() => {
          // Only one chain exists at a time (publish refuses to start a
          // second while busy is set), so clearing unconditionally is safe.
          busy = null;
        });
    } catch (err) {
      // publish() must never throw into the mapper loop.
      log.warn('live-frame: publish failed (frame dropped)', {
        jobId, err: (err as Error).message,
      });
    }
  }

  async function close(): Promise<void> {
    closed = true;
    pendingB64 = null;
    try {
      await (busy ?? Promise.resolve());
    } catch {
      // busy never rejects by construction; defensive only.
    }
    try {
      await remove(objectKey);
    } catch (err) {
      // Best-effort: a leaked object is one ~200KB redacted frame; the
      // expire-help-requests cron sweeps live.png for terminal jobs.
      log.warn('live-frame: cleanup remove failed (cron will sweep)', {
        jobId, err: (err as Error).message,
      });
    }
  }

  return { publish, close };
}
