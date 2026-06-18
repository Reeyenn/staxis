/**
 * feature/cua-feed-replay — locks in the deterministic-replay fidelity fixes
 * that took 3 Choice Advantage feeds from 0 rows to real data, and the
 * adversarial-review hardening on top:
 *
 *   1. detectReauthBounce — a VISIBLE password / j_username field means the feed
 *      navigation bounced to a login screen; a bare `username` field does NOT
 *      (filter/profile pages have one). Missing Page methods → false (never throw).
 *   2. clickRecorded (via replayPreSteps) — prefer an EXACT, UNIQUE role+name;
 *      on ambiguity (count !== 1) fall through to css selector, then coordinate.
 *   3. extractDomTable — a re-auth bounce returns `bounced_to_reauth` and never
 *      scrapes (so a reconcile feed can't auto-resolve from login chrome).
 */

import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Page } from 'playwright';
import { detectReauthBounce } from '../browser-utils/navigate.js';
import { replayPreSteps, type PreStep } from '../extractors/pre-steps.js';
import { extractDomTable } from '../extractors/dom-table.js';
import type { FeedSpec } from '../knowledge-file.js';

// ─── 1. detectReauthBounce ───────────────────────────────────────────────────

function pageWithLoginFieldCount(count: number): Page {
  return {
    locator: (_sel: string) => ({ count: async () => count }),
  } as unknown as Page;
}

describe('detectReauthBounce', () => {
  test('true when a visible password / j_username field is present', async () => {
    assert.equal(await detectReauthBounce(pageWithLoginFieldCount(1)), true);
  });
  test('false when no visible login field is present', async () => {
    assert.equal(await detectReauthBounce(pageWithLoginFieldCount(0)), false);
  });
  test('false (never throws) when the page lacks locator (defensive)', async () => {
    assert.equal(await detectReauthBounce({} as unknown as Page), false);
  });
});

// ─── 2. clickRecorded (exercised through replayPreSteps) ─────────────────────

/** Records which click path fired: role / css / coordinate. `roleCount` is what
 *  page.getByRole(...).count() returns (1 = unique → click by role). */
function clickTrackingPage(roleCount: number) {
  const calls: string[] = [];
  const page = {
    calls,
    getByRole: (role: string, opts: { name: string; exact: boolean }) => ({
      count: async () => roleCount,
      click: async () => { calls.push(`role:${role}/${opts.name}/exact=${opts.exact}`); },
    }),
    click: async (sel: string) => { calls.push(`css:${sel}`); },
    mouse: { click: async (x: number, y: number) => { calls.push(`xy:${x},${y}`); } },
  };
  return page as unknown as Page & { calls: string[] };
}

describe('clickRecorded tiers (via replayPreSteps)', () => {
  test('unique role+name → clicks by role (exact match)', async () => {
    const page = clickTrackingPage(1);
    const steps: PreStep[] = [{ kind: 'click_at', x: 5, y: 6, roleName: { role: 'link', name: 'View Arrivals' } }];
    const res = await replayPreSteps(page, steps);
    assert.equal(res.ok, true);
    assert.deepEqual(page.calls, ['role:link/View Arrivals/exact=true']);
  });

  test('ambiguous role+name (count !== 1) → falls through to recorded coordinate', async () => {
    const page = clickTrackingPage(2);
    const steps: PreStep[] = [{ kind: 'click_at', x: 5, y: 6, roleName: { role: 'link', name: 'Report' } }];
    const res = await replayPreSteps(page, steps);
    assert.equal(res.ok, true);
    assert.deepEqual(page.calls, ['xy:5,6']); // not the wrong role match
  });

  test('ambiguous role+name on a click step → falls through to css selector', async () => {
    const page = clickTrackingPage(0);
    const steps: PreStep[] = [{ kind: 'click', selector: '#go', roleName: { role: 'button', name: 'Go' } }];
    const res = await replayPreSteps(page, steps);
    assert.equal(res.ok, true);
    assert.deepEqual(page.calls, ['css:#go']);
  });

  test('no roleName → uses the css selector directly', async () => {
    const page = clickTrackingPage(99);
    const steps: PreStep[] = [{ kind: 'click', selector: '#menu' }];
    const res = await replayPreSteps(page, steps);
    assert.equal(res.ok, true);
    assert.deepEqual(page.calls, ['css:#menu']);
  });
});

// ─── 3. extractDomTable re-auth guard ────────────────────────────────────────

describe('extractDomTable re-auth guard', () => {
  test('a login bounce returns bounced_to_reauth and never waits/scrapes', async () => {
    const calls: string[] = [];
    const page = {
      calls,
      locator: (_sel: string) => ({ count: async () => 1 }), // visible login field present
      async waitForSelector(sel: string) { calls.push(`wait:${sel}`); },
      async $$eval(sel: string) { calls.push(`scrape:${sel}`); return { rows: [], totalMatched: 0 }; },
    } as unknown as Page & { calls: string[] };
    const feedSpec: FeedSpec = {
      mode: 'dom_table',
      // no url → safeGoto skipped; the re-auth guard runs against the current page
      selectors: { rowSelector: 'tr.res' },
      columns: { guest_name: 'td.name' },
    };
    const res = await extractDomTable({ page, feedSpec, allowedHost: 'pms.example' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bounced_to_reauth');
    assert.deepEqual(page.calls, []); // never reached the row wait or scrape
  });
});
