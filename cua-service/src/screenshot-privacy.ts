/**
 * Screenshot privacy — the SINGLE source of truth for redacting credential /
 * PII fields out of every screenshot the CUA mapper takes, before that image
 * reaches Claude (Anthropic) or Supabase storage.
 *
 * Security invariant
 * ──────────────────
 * A PMS screenshot is emitted ONLY when every credential / SSN / credit-card
 * field is blacked out — in the main document AND in every reachable sub-frame
 * (same- or cross-origin). If we can't produce such an image, we return `null`
 * and the caller MUST send / store nothing for that frame.
 *
 * How (and why this is robust)
 * ────────────────────────────
 * We use Playwright's native screenshot masking:
 *   page.screenshot({ mask: [frame.locator(SEL), …], maskColor: '#000' })
 * Playwright resolves the locators in EVERY frame and paints an opaque box over
 * each matched element's bounding box DIRECTLY ON THE OUTPUT IMAGE, after the
 * page renders. That makes redaction:
 *   - atomic with the capture — there is no "paint overlays, then separately
 *     screenshot" gap, so the navigation race that motivated this rewrite
 *     (overlay-add throws but the screenshot still fires unredacted) is
 *     structurally impossible. The mask is part of the screenshot or there is
 *     no screenshot.
 *   - immune to page stacking / CSS: the box is drawn by Playwright over the
 *     final pixels, so a field in a top-layer <dialog>/popover/fullscreen
 *     element, behind a high z-index, or styled by hostile/broken page CSS is
 *     still covered (verified empirically: top-layer + cross-origin iframe
 *     password fields both render solid black).
 *   - frame-complete: a locator is built per frame, so credentials inside an
 *     embedded login / payment iframe are masked, which a top-frame-only DOM
 *     overlay missed.
 *
 * If page.screenshot throws (a frame navigated / detached mid-capture, or a
 * mask locator couldn't be resolved — exactly the cases where we could NOT have
 * produced a reliably-masked image) we NEVER fall back to a bare screenshot:
 * we settle briefly and retry, then withhold. Bounded by MAX_ATTEMPTS and a
 * hard wall-clock deadline so a stuck page can't hang the mapper. The exported
 * function never rejects — any unexpected throw resolves to `null` (withhold).
 *
 * INTENTIONAL EXPOSURE (policy boundary — deliberately NOT redacted):
 *   Guest names / emails / phones rendered as ordinary TABLE TEXT remain
 *   visible to Claude. The mapper has to read table headers + sample rows to
 *   learn each PMS's column layout, so blanket-blanking page text would break
 *   mapping. Only the credential/SSN/CC classes in SENSITIVE_FIELD_SELECTOR are
 *   masked. To hide specific guest cells in future, tag them with
 *   `[data-sensitive]` (already covered by the selector) during extraction.
 *   Note: a "show password" control that flips input[type=password] to
 *   type=text no longer matches the selector — a known selector limitation, not
 *   worsened here.
 */

import type { Page, Locator } from 'playwright';
import { log } from './log.js';

/**
 * Credential / PII field selector. These classes must NEVER reach Claude or
 * Supabase storage unredacted. This is the ONE definition — imported by the
 * mask builder here AND by `set-of-mark.ts` (which EXCLUDES these from
 * Set-of-Mark badges so a `#N` click can't focus + type into a credential
 * field). A single const means the redaction list cannot drift between sites.
 */
export const SENSITIVE_FIELD_SELECTOR =
  'input[type="password"], [data-sensitive], .ssn, .credit-card';

/** Solid black mask box (Playwright default is pink #FF00FF). */
const MASK_COLOR = '#000000';
/** Bounded retry: a navigation race usually clears within one settle. */
const MAX_ATTEMPTS = 3;
/** Pause between attempts to let an in-flight navigation commit + render. */
const SETTLE_MS = 250;
/** Per-screenshot timeout (< the overall deadline) so one slow capture leaves room to retry. */
const SCREENSHOT_TIMEOUT_MS = 5000;
/** Hard wall-clock cap on the whole primitive so one stuck page can't stall the job. */
const DEADLINE_MS = 8000;

/**
 * One mask locator per frame (main + every sub-frame, same- and cross-origin).
 * Playwright resolves each at capture time and masks all matched elements; a
 * frame with no sensitive field simply contributes nothing.
 */
function sensitiveMaskLocators(page: Page): Locator[] {
  return page.frames().map((frame) => frame.locator(SENSITIVE_FIELD_SELECTOR));
}

async function captureHardenedScreenshotInner(page: Page): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // The mask is intrinsic to this call — there is no code path that takes a
      // screenshot WITHOUT it. Either we get a masked image, or we throw and
      // retry/withhold.
      return await page.screenshot({
        fullPage: false,
        mask: sensitiveMaskLocators(page),
        maskColor: MASK_COLOR,
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
    } catch (err) {
      log.warn('screenshot-privacy: masked screenshot failed — will retry/withhold', {
        attempt,
        message: (err as Error).message,
      });
    }
    if (attempt < MAX_ATTEMPTS) {
      // Let an in-flight navigation commit + render before the next attempt.
      await page.waitForTimeout(SETTLE_MS).catch(() => {});
    }
  }
  return null;
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

/**
 * THE safe capture primitive. Returns a privacy-masked PNG `Buffer`, or `null`
 * when a reliably-masked image couldn't be produced — after bounded
 * retry-after-settle, on a screenshot error, or on the wall-clock deadline.
 * NEVER rejects (any unexpected throw ⇒ `null`); NEVER returns an unmasked
 * image. Callers MUST treat `null` as "no usable screenshot" and emit / upload
 * nothing.
 *
 * Used by all three capture paths that previously each owned a copy of the
 * (swallow-and-proceed) overlay logic: the vision tool's `screenshot` action,
 * the critic's pre/post capture, and the help-card snapshot.
 *
 * `opts.deadlineMs` overrides the wall-clock deadline (tests only).
 */
export async function captureHardenedScreenshot(
  page: Page,
  opts?: { deadlineMs?: number },
): Promise<Buffer | null> {
  try {
    return await withTimeout(
      captureHardenedScreenshotInner(page),
      opts?.deadlineMs ?? DEADLINE_MS,
      null,
    );
  } catch (err) {
    // Contract: NEVER reject. A throw from page.frames()/locator resolution on
    // a closed page, etc., must withhold rather than crash a caller.
    log.warn('screenshot-privacy: capture threw — withholding', {
      message: (err as Error).message,
    });
    return null;
  }
}
