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
 * A frame attaching / navigating / detaching DURING a capture is caught via
 * page events and discards the frame (retry). Accepted residual (non-
 * adversarial threat model): a sensitive ELEMENT added/moved WITHIN an existing
 * frame in the sub-millisecond window of Playwright's own capture emits no frame
 * event and could be unmasked — an irreducible TOCTOU for live-DOM screenshot
 * redaction. The mapper screenshots settled pages and the PMS is not an active
 * attacker; `animations: 'disabled'` removes the common (CSS animation /
 * transition) geometry-churn cause. Closing the rest would need a per-frame
 * MutationObserver, which over-withholds on actively-updating pages.
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

import { performance } from 'node:perf_hooks';
import type { Page, Locator, Frame } from 'playwright';
import { log } from './log.js';

/**
 * Credential / PII field selector. These classes must NEVER reach Claude or
 * Supabase storage unredacted. This is the ONE definition — imported by the
 * mask builder here AND by `set-of-mark.ts` (which EXCLUDES these from
 * Set-of-Mark badges so a `#N` click can't focus + type into a credential
 * field). A single const means the redaction list cannot drift between sites.
 */
const SENSITIVE_PARTS = [
  'input[type="password"]',
  '[data-sensitive]',
  '.ssn',
  '.credit-card',
] as const;

export const SENSITIVE_FIELD_SELECTOR = SENSITIVE_PARTS.join(', ');

/** Solid black mask box (Playwright default is pink #FF00FF). */
const MASK_COLOR = '#000000';

/**
 * CSS injected (atomically, by Playwright) ONLY during the screenshot. The
 * native mask covers each sensitive element's bounding box; this stops the
 * element from painting credential pixels OUTSIDE that box — overflowing text,
 * text/box shadows, filters (glow), and ::before/::after pseudo-content — so
 * the box-shaped mask is actually sufficient. Playwright's `style` pierces the
 * Shadow DOM AND inner frames, so the suppression applies in sub-frames too
 * (verified empirically against a cross-origin iframe).
 */
const REDACTION_STYLE =
  `${SENSITIVE_FIELD_SELECTOR}{overflow:hidden !important;text-shadow:none !important;` +
  `box-shadow:none !important;filter:none !important;}` +
  SENSITIVE_PARTS.map((p) => `${p}::before,${p}::after`).join(',') +
  `{content:none !important;}`;
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
function sensitiveMaskLocators(frames: ReadonlyArray<Frame>): Locator[] {
  return frames.map((frame) => frame.locator(SENSITIVE_FIELD_SELECTOR));
}

async function captureHardenedScreenshotInner(page: Page, deadlineAt: number): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Cooperative deadline: never START a new attempt past the hard cap, so the
    // loop can't keep taking screenshots in the background after withTimeout
    // already returned null to the caller.
    if (performance.now() >= deadlineAt) break;

    // Frame-mutation guard (TOCTOU): watch the whole frame tree for the entire
    // capture. If any frame attaches / navigates / detaches while the screenshot
    // is being taken, we can't prove the image is fully masked (an iframe not in
    // the mask set, or a frame that rendered a credential mid-navigation, could
    // be in the pixels) — so discard and retry. This catches attach-paint-detach
    // and same-frame navigation, which a before/after frame-list diff misses.
    let frameMutated = false;
    const onMutate = () => {
      frameMutated = true;
    };
    page.on('frameattached', onMutate);
    page.on('framenavigated', onMutate);
    page.on('framedetached', onMutate);
    try {
      // The mask + style are intrinsic to this single page.screenshot call —
      // there is no code path that takes a screenshot WITHOUT them, so either we
      // get a redacted image or we throw / discard and retry/withhold.
      const buf = await page.screenshot({
        fullPage: false,
        mask: sensitiveMaskLocators(page.frames()),
        maskColor: MASK_COLOR,
        style: REDACTION_STYLE,
        // Freeze CSS animations/transitions to their end state for the capture
        // so a field can't be MID-MOVE when Playwright computes the mask boxes —
        // removes the most realistic same-document geometry-churn vector.
        animations: 'disabled',
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      if (!frameMutated) return buf;
      log.warn('screenshot-privacy: frame tree mutated during capture — discarding for retry');
    } catch (err) {
      log.warn('screenshot-privacy: masked screenshot failed — will retry/withhold', {
        attempt,
        message: (err as Error).message,
      });
    } finally {
      page.off('frameattached', onMutate);
      page.off('framenavigated', onMutate);
      page.off('framedetached', onMutate);
    }
    if (attempt < MAX_ATTEMPTS && performance.now() < deadlineAt) {
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
  const deadlineMs = opts?.deadlineMs ?? DEADLINE_MS;
  try {
    // The inner loop honours `deadlineAt` cooperatively (won't start a new
    // attempt past it); withTimeout is the hard backstop that guarantees the
    // CALLER gets `null` promptly even if one in-flight screenshot is finishing.
    return await withTimeout(
      captureHardenedScreenshotInner(page, performance.now() + deadlineMs),
      deadlineMs,
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
