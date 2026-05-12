/**
 * Shared selector helpers for Choice Advantage scrapers.
 *
 * WHY THIS FILE EXISTS:
 * The same selector-fallback pattern was hand-rolled in 4+ places:
 *   - scraper.js login button (12 selectors, click → force → JS)
 *   - csv-scraper.js HK Check-off List link (7 selectors)
 *   - csv-scraper.js CSV export checkbox (8 selectors)
 *   - csv-scraper.js Submit button (12 selectors)
 *
 * Every CA UX change meant editing all of them. The 2026-04-27 outage
 * exposed how brittle that is: when CA renamed selectors, the layout drift
 * cascaded across all four sites and we had to grep-replace per spot.
 *
 * Consolidating means:
 *   - One implementation of the click-with-fallbacks pattern.
 *   - One implementation of the diagnostics dump (visible inventory + HTML).
 *   - When CA changes again, we add ONE selector to the matching site's
 *     candidates array — not edit four fallback chains.
 *   - The pattern is named, so future readers don't have to reverse-engineer
 *     why click-then-force-then-JS is necessary (CA renders custom buttons
 *     that can intercept normal click events; force bypasses overlays; JS
 *     bypasses Playwright's actionability checks).
 */

const fs = require('fs');
const path = require('path');

/**
 * Try a list of selectors in order. For each match, escalate through:
 *   1. Plain Playwright click with timeout
 *   2. Force-click (bypass actionability checks)
 *   3. JS-direct .click() via locator.evaluate
 * First successful click wins.
 *
 * On total miss, optionally dumps a JSON inventory of visible <a> / <button>
 * / <input[type=submit]> on the page + saves the HTML for diagnosis.
 *
 * Why escalate through three click modes:
 *   - CA renders custom-styled <a> elements that aren't always "actionable"
 *     by Playwright's strict interpretation (they're not visible-and-stable
 *     by the time we arrive). Force-click bypasses that gate.
 *   - Some CA pages overlay loading shims or custom z-index drama.
 *     JS-direct click ignores overlays since it dispatches the event from
 *     inside the page's JS context.
 *   - Plain click first because it correctly clears the overlay handlers
 *     (waits for transition, fires hover events, etc.) — the more robust
 *     path when the page is healthy.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors candidates in priority order
 * @param {string} label human description for log lines + error message
 * @param {(msg: string) => void} log logger from scraper.js
 * @param {object} [options]
 * @param {string} [options.dumpFile] basename for the saved HTML on miss; if
 *   set, the page HTML is written to scraper/{dumpFile}.html when no
 *   selector matches
 * @param {string} [options.inventoryQuery] CSS selector for inventory dump
 *   on total miss; default is 'a, button, input[type="submit"]'
 * @returns {Promise<string>} the selector that worked
 * @throws {Error} on total miss, with a debuggable message that includes
 *   the visible-element inventory and current URL
 */
async function clickFirstMatching(page, selectors, label, log, options = {}) {
  for (const sel of selectors) {
    let count = 0;
    try { count = await page.locator(sel).count(); } catch { continue; }
    if (count === 0) continue;
    const loc = page.locator(sel).first();
    // Tier 1: plain click with timeout.
    try { await loc.click({ timeout: 5000 }); log(`Clicked ${label} (selector: ${sel})`); return sel; } catch {}
    // Tier 2: force-click (bypasses actionability gate).
    try { await loc.click({ timeout: 3000, force: true }); log(`Clicked ${label} via force (selector: ${sel})`); return sel; } catch {}
    // Tier 3: JS-direct click (bypasses overlays).
    try {
      const ok = await loc.evaluate((el) => {
        if (el && typeof el.click === 'function') { el.click(); return true; }
        return false;
      });
      if (ok) { log(`Clicked ${label} via JS (selector: ${sel})`); return sel; }
    } catch {}
  }
  // Total miss — produce a debuggable error.
  let inventory = [];
  try {
    const query = options.inventoryQuery ?? 'a, button, input[type="submit"]';
    inventory = await page.evaluate((q) =>
      Array.from(document.querySelectorAll(q)).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || el.value || '').trim().slice(0, 80),
        id: el.id || null,
        href: el.getAttribute ? (el.getAttribute('href') || '').slice(0, 120) : '',
        visible: !!(el.offsetWidth || el.offsetHeight),
      })).filter(b => b.text && b.visible).slice(0, 40),
      query
    );
  } catch { /* ignore */ }
  if (options.dumpFile) {
    try {
      const html = await page.content();
      const fp = path.join(__dirname, `${options.dumpFile}.html`);
      fs.writeFileSync(fp, html);
      log(`saved ${options.dumpFile}.html for selector diagnosis`);
    } catch (e) {
      log(`could not dump page HTML for ${label}: ${e.message}`);
    }
  }
  throw new Error(
    `Could not click ${label}. Tried ${selectors.length} selectors. ` +
    `Visible elements on page: ${JSON.stringify(inventory)}. ` +
    `Current URL: ${page.url()}.` +
    (options.dumpFile ? ` See ${options.dumpFile}.html for full HTML.` : '')
  );
}

/**
 * Fill the first matching <input> with a value. Falls through silently on
 * miss (returns null) unless `required: true`, in which case it throws with
 * an inventory of visible inputs.
 *
 * @returns {Promise<string|null>} the selector that worked, or null
 */
async function fillFirstMatching(page, selectors, value, label, log, options = {}) {
  for (const sel of selectors) {
    let count = 0;
    try { count = await page.locator(sel).count(); } catch { continue; }
    if (count === 0) continue;
    try {
      await page.fill(sel, value, { timeout: 5000 });
      log(`Filled ${label} (selector: ${sel})`);
      return sel;
    } catch (e) {
      log(`Fill failed for ${label} on ${sel}: ${e.message}`);
    }
  }
  if (options.required) {
    let inventory = [];
    try {
      inventory = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map((el) => ({
          name: el.name || null,
          id: el.id || null,
          type: el.type,
          visible: !!(el.offsetWidth || el.offsetHeight),
        })).slice(0, 30)
      );
    } catch { /* ignore */ }
    throw new Error(
      `Could not fill ${label}. Tried ${selectors.length} selectors. ` +
      `Visible inputs on page: ${JSON.stringify(inventory)}. ` +
      `Current URL: ${page.url()}.`
    );
  }
  return null;
}

/**
 * Select an option in the first matching <select>. By default, falls through
 * silently on miss (returns null) — the caller is responsible for deciding
 * whether a missing dropdown is fatal. CA's report forms often have sensible
 * defaults, so missing a "Select All" gesture isn't always a hard error.
 *
 * 2026-05-12 (Codex audit, re-applied after first edit didn't persist):
 * added options.required. When true, throws on miss instead of warning.
 * Use for filters where falling through to CA's sticky last-used value
 * would corrupt the data downstream (status/condition/housekeeper on the
 * Housekeeping Check-off List CSV report).
 *
 * @returns {Promise<string|null>}
 */
async function selectFirstMatching(page, selectors, value, label, log, options = {}) {
  for (const sel of selectors) {
    let count = 0;
    try { count = await page.locator(sel).count(); } catch { continue; }
    if (count === 0) continue;
    try {
      await page.selectOption(sel, value, { timeout: 5000 });
      log(`Set ${label} → ${value} (selector: ${sel})`);
      return sel;
    } catch (e) {
      // CA sometimes wraps select in a custom dropdown — fall through.
      log(`selectOption failed on ${sel} for ${label}: ${e.message}`);
    }
  }
  if (options.required) {
    throw new Error(
      `Could not set required filter "${label}". Tried ${selectors.length} selectors on ${page.url()}.`,
    );
  }
  log(`WARNING: Could not set ${label}. Continuing with whatever default CA used.`);
  return null;
}

module.exports = {
  clickFirstMatching,
  fillFirstMatching,
  selectFirstMatching,
};
