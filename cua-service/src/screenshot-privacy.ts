/**
 * Screenshot privacy — the SINGLE source of truth for redacting credential /
 * PII fields out of every screenshot the CUA mapper takes, before that image
 * reaches Claude (Anthropic) or Supabase storage.
 *
 * Security invariant
 * ──────────────────
 * NO screenshot of a PMS page is emitted unless every VISIBLE credential /
 * SSN / credit-card field — in the main document AND in every reachable
 * sub-frame — is provably covered by an opaque overlay at capture time. If we
 * cannot prove that, `captureHardenedScreenshot` returns `null` and the caller
 * MUST send / store nothing for that frame.
 *
 * How it stays correct (this closes three real gaps the old per-file copies
 * had — see fix/cua-privacy-redaction):
 *   1. GATE, don't swallow. The old `hardenScreenshotPrivacy` painted overlays,
 *      swallowed "Execution context was destroyed … navigation" errors, and let
 *      `page.screenshot()` run UNCONDITIONALLY — emitting an unredacted frame
 *      whenever the overlay-add lost a race with a navigation. Here the capture
 *      is gated on the overlay paint succeeding, with bounded retry-after-settle.
 *   2. VERIFY after capture. Even a successful paint can be undone by a
 *      navigation / scroll / DOM swap in the microseconds before the pixels are
 *      grabbed. After the screenshot we re-check, geometrically, that each
 *      visible sensitive field's center still sits under one of our overlays.
 *      Any shortfall (or any frame we can't evaluate) ⇒ discard the frame.
 *   3. ALL FRAMES. `document.querySelectorAll` in the top frame never descends
 *      into iframes, so credentials inside an embedded login / payment frame
 *      were fully exposed. Playwright injects into every frame, so we paint +
 *      verify inside each one (same- and cross-origin).
 *
 * Fail-closed everywhere: a thrown evaluate, an undefined result, a missed
 * coverage check, or a wall-clock timeout all resolve to "withhold the frame",
 * never "send it anyway".
 *
 * INTENTIONAL EXPOSURE (policy boundary — deliberately NOT redacted):
 *   Guest names / emails / phones rendered as ordinary TABLE TEXT remain
 *   visible to Claude. The mapper has to read table headers + sample rows to
 *   learn each PMS's column layout, so blanket-blanking page text would break
 *   mapping. Only the credential/SSN/CC classes below are masked. If a future
 *   need arises to hide specific guest cells, tag them with `[data-sensitive]`
 *   (already covered by SENSITIVE_FIELD_SELECTOR) during extraction.
 *
 * Concurrency note: all overlays use the single marker attribute
 * `data-staxis-privacy-overlay`, and `clearOverlaysAllFrames` removes ALL of
 * them. This is safe because captures are SERIALIZED today — the per-hotel
 * single-flight read mutex plus the sequential mapper loop mean a critic
 * capture and a screenshot-action capture never touch the same page at the
 * same time (critic captures run only around click actions; the screenshot
 * action's capture runs only around screenshot actions; never the same
 * tool_use). If concurrent captures on one page are ever introduced, switch to
 * a per-call nonce marker so each capture clears only its own overlays.
 */

import type { Page } from 'playwright';
import { log } from './log.js';

/**
 * Credential / PII field selector. These classes must NEVER reach Claude or
 * Supabase storage unredacted. This is the ONE definition — imported by
 * `browser-tool-vision.ts`, `critic.ts` (via this module's capture primitive)
 * and `set-of-mark.ts` (which also EXCLUDES these from Set-of-Mark badges so a
 * `#N` click can't focus + type into a credential field). Keeping a single
 * const means the redaction list cannot drift between call sites.
 */
export const SENSITIVE_FIELD_SELECTOR =
  'input[type="password"], [data-sensitive], .ssn, .credit-card';

/** DOM marker for the overlays we add, so cleanup/verify can find exactly them. */
const OVERLAY_MARKER = 'data-staxis-privacy-overlay';

/** Bounded retry: a nav race usually clears within one settle. */
const MAX_ATTEMPTS = 3;
/** Pause between attempts to let an in-flight navigation commit + render. */
const SETTLE_MS = 250;
/** Hard wall-clock cap on the whole primitive so one hung page can't stall the job. */
const DEADLINE_MS = 8000;

/**
 * Paint opaque overlays over every visible sensitive field, in EVERY frame.
 * Best-effort per frame (a frame whose context just died is retried by the
 * caller). Returns whether the MAIN frame painted without throwing — the main
 * frame dying is the classic "Execution context was destroyed … navigation"
 * race, and there's no point screenshotting a main document we couldn't mask.
 */
async function paintOverlaysAllFrames(page: Page): Promise<boolean> {
  const main = page.mainFrame();
  let mainOk = false;
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((selector: string) => {
        document.querySelectorAll(selector).forEach((el) => {
          const h = el as HTMLElement;
          const rect = h.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const overlay = document.createElement('div');
          overlay.setAttribute('data-staxis-privacy-overlay', '1');
          overlay.style.position = 'fixed';
          overlay.style.left = `${rect.left}px`;
          overlay.style.top = `${rect.top}px`;
          overlay.style.width = `${rect.width}px`;
          overlay.style.height = `${rect.height}px`;
          overlay.style.background = '#000';
          overlay.style.zIndex = '2147483647';
          overlay.style.pointerEvents = 'none';
          document.body.appendChild(overlay);
        });
      }, SENSITIVE_FIELD_SELECTOR);
      if (frame === main) mainOk = true;
    } catch (err) {
      // Cross-origin frame mid-navigation, detached frame, etc. Sub-frame
      // failures are tolerated here and caught by the post-capture verify;
      // a main-frame failure makes mainOk stay false → caller retries.
      log.warn('screenshot-privacy: frame overlay-add failed', {
        message: (err as Error).message,
        isMain: frame === main,
      });
    }
  }
  return mainOk;
}

/**
 * Post-capture gate. For every frame, confirm each VISIBLE sensitive field's
 * center point sits inside one of our overlay rects (geometric coverage, so a
 * scroll / layout-shift / field-substitution between paint and capture is
 * caught — a plain overlay-vs-field count can't detect substitution). Returns
 * true ONLY if every reachable frame reports zero uncovered fields. Fails
 * closed: any thrown / malformed evaluate ⇒ false ⇒ the frame is discarded.
 */
async function verifyAllFramesCovered(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    let uncovered: number;
    try {
      const result = await frame.evaluate((selector: string) => {
        const overlays = Array.from(
          document.querySelectorAll('[data-staxis-privacy-overlay]'),
        ).map((o) => (o as HTMLElement).getBoundingClientRect());
        let unc = 0;
        document.querySelectorAll(selector).forEach((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return; // not visible → not in the pixels
          // Covered iff some overlay's rect fully CONTAINS the field's current
          // rect (1px tolerance for sub-pixel rounding). Containment — not a
          // center-point hit — so a field that moved, GREW, or was swapped for
          // a different field between paint and capture is treated as exposed.
          const covered = overlays.some(
            (o) =>
              o.left <= r.left + 1 &&
              o.right >= r.right - 1 &&
              o.top <= r.top + 1 &&
              o.bottom >= r.bottom - 1,
          );
          if (!covered) unc++;
        });
        return unc;
      }, SENSITIVE_FIELD_SELECTOR);
      // Fail closed on a non-numeric result (a frame that returned undefined,
      // e.g. its context was being torn down as we read it).
      if (typeof result !== 'number') {
        log.warn('screenshot-privacy: verify returned non-number — failing closed');
        return false;
      }
      uncovered = result;
    } catch (err) {
      log.warn('screenshot-privacy: frame verify failed — failing closed', {
        message: (err as Error).message,
      });
      return false;
    }
    if (uncovered > 0) {
      log.warn('screenshot-privacy: sensitive field(s) uncovered at capture — discarding frame', {
        uncovered,
      });
      return false;
    }
  }
  return true;
}

/** Remove our overlays from every frame. Per-frame best-effort. */
async function clearOverlaysAllFrames(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        document
          .querySelectorAll('[data-staxis-privacy-overlay]')
          .forEach((el) => el.remove());
      });
    } catch {
      // Frame gone (navigated / detached) → its overlays died with it. Nothing
      // to clean. Intentionally swallow: cleanup must never throw upward.
    }
  }
}

/** Race a promise against a wall-clock fallback without cancelling the loser. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

async function captureHardenedScreenshotInner(page: Page): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const mainOk = await paintOverlaysAllFrames(page);
      if (mainOk) {
        let buf: Buffer | null = null;
        try {
          buf = await page.screenshot({ fullPage: false });
        } catch (err) {
          // Navigation during capture, target closed, etc. → no usable buffer.
          log.warn('screenshot-privacy: screenshot failed', {
            message: (err as Error).message,
          });
        }
        if (buf && (await verifyAllFramesCovered(page))) {
          return buf; // overlays cleared by the finally below, after capture
        }
      }
    } finally {
      await clearOverlaysAllFrames(page);
    }
    if (attempt < MAX_ATTEMPTS) {
      // Let an in-flight navigation commit + render before the next attempt.
      await page.waitForTimeout(SETTLE_MS).catch(() => {});
    }
  }
  return null;
}

/**
 * THE safe capture primitive. Paints privacy overlays (every frame), and ONLY
 * if they provably cover every visible sensitive field does it return the
 * captured PNG `Buffer`. Returns `null` when redaction couldn't be guaranteed
 * — after bounded retry-after-settle, on a screenshot error, on a coverage
 * miss, or on the wall-clock deadline. Callers MUST treat `null` as "no usable
 * screenshot" and emit / upload nothing.
 *
 * Used by the three capture paths that previously each owned a copy of the
 * (swallow-and-proceed) overlay logic: the vision tool's `screenshot` action,
 * the critic's pre/post capture, and the help-card snapshot.
 */
export async function captureHardenedScreenshot(page: Page): Promise<Buffer | null> {
  return withTimeout(captureHardenedScreenshotInner(page), DEADLINE_MS, null);
}
