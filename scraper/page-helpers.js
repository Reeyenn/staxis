/**
 * Page helpers — safe page.evaluate + page settle utilities.
 *
 * Why this file exists:
 *   On 2026-04-27 the scraper went into a 2+ hour outage with this Playwright
 *   error on every page.evaluate call:
 *     "page.evaluate: Execution context was destroyed, most likely because
 *      of a navigation"
 *
 *   Root cause: Choice Advantage uses JS-based redirects after page load
 *   (e.g. Login.init redirects to /Welcome.init redirects to
 *   /user_authenticated.jsp). page.goto() with waitUntil:'domcontentloaded'
 *   returns once DOMContentLoaded fires, but BEFORE the JS redirects fire.
 *   The scraper would then call page.evaluate() while the page was navigating,
 *   and the Playwright execution context died mid-call. Because EVERY pull
 *   (login, dashboard, OOO) uses page.evaluate, a single transient redirect
 *   cascaded into a total scraper outage that could only recover via a
 *   process restart.
 *
 *   This module fixes that with two things:
 *     • safeEval — wraps page.evaluate and retries up to N times on the
 *       specific "Execution context was destroyed" error. Each retry waits
 *       for the page to settle first.
 *     • settlePage — an after-goto helper that waits for 'load' AND
 *       'networkidle' (both with bounded timeouts) so the page has a real
 *       chance to finish any chained redirects before we touch its DOM.
 *
 *   Both are intentionally tolerant of timeout — we always proceed after the
 *   timeout window because some CA pages legitimately keep network alive
 *   (long-poll, websocket) and would never reach 'networkidle'. The retry
 *   loop in safeEval is the actual safety net.
 */

const EXECUTION_CONTEXT_DESTROYED_RE =
  /Execution context (was|is) destroyed|context was destroyed/i;

function isExecutionContextDestroyed(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return EXECUTION_CONTEXT_DESTROYED_RE.test(msg);
}

/**
 * Wait for the page to settle after a navigation. Both states are best-effort
 * (.catch(() => {})) — we proceed even if the timeout hits, because the
 * downstream caller is expected to wrap its page.evaluate in safeEval, which
 * will retry on the transient "Execution context was destroyed" race.
 *
 * Two waits in sequence matter:
 *   1. 'load'        — fires after window.onload, i.e. all images/scripts loaded.
 *                       Catches the case where CA does a synchronous JS
 *                       redirect during initial page load.
 *   2. 'networkidle' — 500ms of no in-flight requests. Catches the case where
 *                       CA does an async fetch + redirect on first paint.
 */
async function settlePage(page, { loadTimeout = 15000, idleTimeout = 5000 } = {}) {
  await page.waitForLoadState('load', { timeout: loadTimeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: idleTimeout }).catch(() => {});
}

/**
 * page.evaluate with retry on "Execution context was destroyed".
 *
 * Up to N attempts; between each attempt we waitForLoadState to give the page
 * a chance to settle. If the error is anything OTHER than execution-context-
 * destroyed, we throw immediately — the caller's existing error handling
 * (typed ScraperError, etc.) takes over.
 *
 * Usage:
 *   const ok = await safeEval(page, () => !!document.querySelector('input'));
 *   const counts = await safeEval(page, (label) => readCount(label), 'Room Count:');
 *
 * Why retries help: "Execution context destroyed" means the page navigated
 * mid-evaluate. It's transient — by the time we try again the new page
 * is loaded and the same DOM query succeeds.
 */
async function safeEval(page, fn, ...args) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (err) {
      lastErr = err;
      if (!isExecutionContextDestroyed(err)) {
        // Not a context-destroyed error — bubble up immediately.
        throw err;
      }
      // Context destroyed — page navigated mid-evaluate. Wait for the new
      // page to settle, then retry.
      if (attempt < MAX_ATTEMPTS) {
        await settlePage(page, { loadTimeout: 8000, idleTimeout: 3000 });
        // Tiny pause to let any async post-load JS finish dispatching.
        await page.waitForTimeout(250);
      }
    }
  }
  throw lastErr;
}

/**
 * Like safeEval but for page.waitForFunction — same retry on context destroyed.
 * Used by dashboard-pull's "wait for Room Count to be present" check.
 */
async function safeWaitForFunction(page, fn, options = {}, ...args) {
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await page.waitForFunction(fn, options, ...args);
    } catch (err) {
      lastErr = err;
      if (!isExecutionContextDestroyed(err)) throw err;
      if (attempt < MAX_ATTEMPTS) {
        await settlePage(page, { loadTimeout: 8000, idleTimeout: 3000 });
        await page.waitForTimeout(250);
      }
    }
  }
  throw lastErr;
}

/**
 * The single correct way to navigate Choice Advantage in this scraper.
 *
 * `goWithSettle` = page.goto + waitForLoadState('load') + waitForLoadState
 * ('networkidle'), with sensible bounded timeouts and tolerant on each
 * step. CA does chained JS redirects after DOMContentLoaded fires (e.g.
 * Login.init → Welcome.init → user_authenticated.jsp), so the pre-2026-04-27
 * default of `waitUntil:'domcontentloaded'` was racing those redirects and
 * tearing down execution contexts mid-page.evaluate.
 *
 * Use this everywhere instead of raw page.goto. It encodes:
 *   - waitUntil:'load' (waits for window.onload, runs scripts to completion)
 *   - then 'load' state again as belt-and-suspenders
 *   - then 'networkidle' (500ms of no in-flight requests)
 * Each waitForLoadState swallows its own timeout so we proceed even if CA
 * keeps a long-poll connection open. The downstream safeEval retry on
 * 'execution context was destroyed' is the actual safety net for the
 * tail-end race conditions.
 *
 * Throws a vanilla Error on navigation failure (timeout / DNS / 5xx). The
 * caller is expected to wrap in ScraperError if it wants typed handling
 * (see scraper/dashboard-pull.js for the CA_UNREACHABLE pattern).
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.gotoTimeout=30000] page.goto timeout
 * @param {number} [options.loadTimeout=15000] waitForLoadState('load') timeout
 * @param {number} [options.idleTimeout=5000] waitForLoadState('networkidle') timeout
 */
async function goWithSettle(page, url, options = {}) {
  const gotoTimeout = options.gotoTimeout ?? 30000;
  const loadTimeout = options.loadTimeout ?? 15000;
  const idleTimeout = options.idleTimeout ?? 5000;
  await page.goto(url, { waitUntil: 'load', timeout: gotoTimeout });
  await settlePage(page, { loadTimeout, idleTimeout });
}

module.exports = {
  safeEval,
  safeWaitForFunction,
  settlePage,
  goWithSettle,
  isExecutionContextDestroyed,
};
