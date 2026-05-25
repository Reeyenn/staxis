/**
 * Tests for Plan v9 F1 — Set-of-Mark visual grounding.
 *
 * Spins up Chromium against an in-memory data: URL with a handful of
 * clickable elements; asserts:
 *   - applySetOfMark places one badge per visible clickable element
 *   - the returned BadgeInfo map points to each element's center
 *   - role + accessible name are populated from ARIA / tag / text
 *   - clearSetOfMark removes all badges from the DOM
 *   - browser-tool-vision's `screenshot` action populates the per-page
 *     badge store; subsequent `left_click` with text "#N" resolves to
 *     the badge's coord
 *
 * Skip when CHROMIUM_AVAILABLE is unset — the headless run is part of
 * CI / dev test pass.
 */

// Env shims (env.ts validates at module load — same pattern as policy.test.ts).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { applySetOfMark, clearSetOfMark } from '../set-of-mark.js';
import {
  executeVisionAction,
  resolveBadgeReference,
} from '../browser-tool-vision.js';

// All anchors use href="#" and all buttons type="button" so a successful
// click doesn't trigger navigation — keeps tests deterministic and lets
// the same page survive multiple consecutive vision actions.
const FIXTURE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>SoM fixture</title></head>
  <body style="margin:0;padding:0;font-family:sans-serif;">
    <header style="background:#222;color:#fff;padding:12px;">
      <a href="javascript:void(0)" id="home-link">Home</a>
      <button type="button" id="signout-btn">Sign Out</button>
    </header>
    <main style="padding:24px;">
      <input type="text" id="search" placeholder="Search rooms" style="width:200px;" />
      <button type="button" id="search-btn" aria-label="Run search">🔍</button>
      <ul>
        <li><a href="javascript:void(0)" id="r1">Room 101</a></li>
        <li><a href="javascript:void(0)" id="r2">Room 102</a></li>
      </ul>
      <div role="button" tabindex="0" id="custom-btn" style="display:inline-block;padding:8px;background:#eee;">Custom Action</div>
      <input type="password" id="pw" style="margin-top:12px;" />
      <input type="hidden" id="should-not-mark" value="x" />
      <div id="not-clickable-div">Plain text — not clickable</div>
    </main>
  </body>
</html>
`;

const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.goto(FIXTURE_URL);
});

after(async () => {
  if (browser) await browser.close();
});

describe('Set-of-Mark — DOM marking + map', () => {
  test('applySetOfMark draws one badge per clickable element', async () => {
    const map = await applySetOfMark(page!);
    // Expected clickables: home-link, signout-btn, search input, search-btn,
    // r1, r2, custom-btn, pw input. NOT marked: hidden input, plain div.
    assert.ok(
      map.size >= 7,
      `expected at least 7 clickable badges, got ${map.size}`,
    );
    // Badge DOM was placed.
    const badgeCount = await page!.locator('[data-staxis-som-badge]').count();
    assert.equal(badgeCount, map.size, 'badge DOM count must match returned map size');
    await clearSetOfMark(page!);
  });

  test('clearSetOfMark removes all badges', async () => {
    await applySetOfMark(page!);
    await clearSetOfMark(page!);
    const count = await page!.locator('[data-staxis-som-badge]').count();
    assert.equal(count, 0, 'clearSetOfMark must purge every [data-staxis-som-badge] node');
  });

  test('BadgeInfo includes role + accessible name where available', async () => {
    const map = await applySetOfMark(page!);
    const badges = Array.from(map.values());
    // Find the Home link.
    const home = badges.find((b) => b.name === 'Home');
    assert.ok(home, 'expected a badge for the Home link');
    assert.equal(home!.role, 'link');
    // The Sign Out button.
    const signout = badges.find((b) => b.name === 'Sign Out');
    assert.ok(signout, 'expected a badge for Sign Out');
    assert.equal(signout!.role, 'button');
    // The custom-btn (div with role=button + tabindex=0).
    const custom = badges.find((b) => b.name === 'Custom Action');
    assert.ok(custom, 'expected a badge for the custom button');
    assert.equal(custom!.role, 'button');
    // The search input — accessible name should come from placeholder.
    const search = badges.find((b) => b.role === 'textbox' && b.name?.includes('Search'));
    assert.ok(search, `expected a badge for the search input — got names: ${badges.map((b) => b.name).join(', ')}`);
    await clearSetOfMark(page!);
  });

  test('badge centers point at the element center (within a few pixels)', async () => {
    const map = await applySetOfMark(page!);
    const home = Array.from(map.values()).find((b) => b.name === 'Home');
    assert.ok(home);
    // Look up the actual rect of #home-link.
    const rect = await page!.evaluate(() => {
      const el = document.getElementById('home-link')!;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert.ok(
      Math.abs(home!.x - rect.x) < 3 && Math.abs(home!.y - rect.y) < 3,
      `badge center (${home!.x},${home!.y}) drifted from element center (${rect.x},${rect.y})`,
    );
    await clearSetOfMark(page!);
  });

  test('privacy-sensitive inputs are excluded from SoM marking (adversarial P1)', async () => {
    await page!.goto(FIXTURE_URL);
    const map = await applySetOfMark(page!);
    // The fixture has an input[type="password"] (#pw). It must NOT be
    // enrolled as a badge — otherwise an attacker-induced #N click could
    // focus the password field.
    const badgeIds = await page!.$$eval(
      '[data-staxis-som-badge]',
      (els: Element[]) => els.map((e) => (e as HTMLElement).dataset.staxisSomBadge),
    );
    // Find the password input's center; assert no badge sits over it.
    const pwRect = await page!.evaluate(() => {
      const el = document.getElementById('pw')!;
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    const badgesOverPw = Array.from(map.values()).filter(
      (b) => Math.abs(b.x - pwRect.cx) < 4 && Math.abs(b.y - pwRect.cy) < 4,
    );
    assert.equal(
      badgesOverPw.length,
      0,
      `no badge should target the password field's center; got ${badgesOverPw.length}`,
    );
    // Sanity: badges still exist for the other clickables.
    assert.ok(badgeIds.length >= 5, `expected ≥5 non-password badges, got ${badgeIds.length}`);
    await clearSetOfMark(page!);
  });

  test('badges have pointer-events: none so underlying clicks still register', async () => {
    await applySetOfMark(page!);
    // Click the home link by pixel coord; the badge sits on top but
    // shouldn't intercept the click. Successful navigation = anchor's
    // href fires. We test by checking the underlying element via hit-test.
    const result = await page!.evaluate(() => {
      const home = document.getElementById('home-link')!;
      const r = home.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return { topTag: top?.tagName.toLowerCase(), topId: (top as HTMLElement)?.id };
    });
    // Pointer-events:none on the badge means elementFromPoint returns the
    // underlying anchor, not the badge.
    assert.notEqual(result.topTag, 'div', 'topmost element under badge must NOT be the badge div');
    await clearSetOfMark(page!);
  });
});

describe('Set-of-Mark — vision-tool integration (screenshot + #N click)', () => {
  test('screenshot action populates the badge store, left_click #N resolves', async () => {
    const creds = {
      loginUrl: 'https://example.com/login',
      username: 'u',
      password: 'p',
    };
    await page!.goto(FIXTURE_URL);

    // Take a screenshot via the vision tool — should apply SoM and stash
    // the badge map under the page key.
    const ssResult = await executeVisionAction(page!, { action: 'screenshot' }, creds);
    assert.equal(ssResult.isError, undefined, 'screenshot must not error');
    assert.ok(ssResult.screenshotB64, 'screenshot must return a base64 PNG');
    assert.ok(
      (ssResult.output || '').includes('Set-of-Mark applied'),
      `screenshot output should mention SoM: ${ssResult.output}`,
    );

    // resolveBadgeReference exercises the per-page WeakMap stash.
    const id1 = (ssResult.output || '').match(/(\d+) clickable element/);
    assert.ok(id1, 'screenshot output should report the badge count');
    const badgeCount = parseInt(id1![1]!, 10);
    assert.ok(badgeCount >= 1, 'expected at least one badge');

    // Try every badge ID; at least one should resolve. (We pick the
    // first that maps to a sensible non-zero coordinate.)
    let resolved: { x: number; y: number } | null = null;
    for (let id = 1; id <= badgeCount; id++) {
      const r = resolveBadgeReference(page!, `#${id}`);
      if (r && r.x > 0 && r.y > 0) {
        resolved = { x: r.x, y: r.y };
        break;
      }
    }
    assert.ok(resolved, 'resolveBadgeReference should return a coord for at least one badge');

    // Issue a left_click with text=#N (use ID 1). The recorded coord
    // should match the badge's center, not the dummy [0,0] coord we passed.
    const id1Resolved = resolveBadgeReference(page!, '#1');
    assert.ok(id1Resolved, '#1 must resolve to a badge');
    const click = await executeVisionAction(
      page!,
      { action: 'left_click', coordinate: [0, 0], text: '#1' },
      creds,
    );
    assert.equal(click.isError, undefined);
    assert.ok(click.recordedStep, 'click must record a step');
    assert.equal(click.recordedStep!.kind, 'click_at');
    if (click.recordedStep!.kind === 'click_at') {
      assert.equal(click.recordedStep!.x, id1Resolved!.x);
      assert.equal(click.recordedStep!.y, id1Resolved!.y);
    }
  });

  test('resolveBadgeReference returns null for unknown badge / missing text', () => {
    assert.equal(resolveBadgeReference(page!, undefined), null);
    assert.equal(resolveBadgeReference(page!, ''), null);
    assert.equal(resolveBadgeReference(page!, 'not-a-badge'), null);
    assert.equal(resolveBadgeReference(page!, '#9999'), null);
  });

  test('left_click WITHOUT #N still works (raw coordinate path)', async () => {
    const creds = {
      loginUrl: 'https://example.com/login',
      username: 'u',
      password: 'p',
    };
    await page!.goto(FIXTURE_URL);
    // Take a screenshot to set up the store, then click at a "dead" coordinate
    // (the bottom-right corner of the viewport, below all interactive elements
    // in the fixture) so the click doesn't trigger navigation. We're testing
    // that the recorded coord is preserved verbatim, not that the click hits
    // a particular target.
    await executeVisionAction(page!, { action: 'screenshot' }, creds);
    const click = await executeVisionAction(
      page!,
      { action: 'left_click', coordinate: [1100, 700] },
      creds,
    );
    assert.equal(click.isError, undefined);
    assert.ok(click.recordedStep);
    assert.equal(click.recordedStep!.kind, 'click_at');
    if (click.recordedStep!.kind === 'click_at') {
      assert.equal(click.recordedStep!.x, 1100);
      assert.equal(click.recordedStep!.y, 700);
    }
  });

  test('screenshot clears stale badges before applying new ones', async () => {
    const creds = {
      loginUrl: 'https://example.com/login',
      username: 'u',
      password: 'p',
    };
    await page!.goto(FIXTURE_URL);
    // Two consecutive screenshots — second should not double the badge DOM.
    await executeVisionAction(page!, { action: 'screenshot' }, creds);
    const after1 = await page!.locator('[data-staxis-som-badge]').count();
    await executeVisionAction(page!, { action: 'screenshot' }, creds);
    const after2 = await page!.locator('[data-staxis-som-badge]').count();
    assert.equal(after2, after1, 'badge count must stay stable across consecutive screenshots');
  });

  test('non-screenshot action clears badges (defense-in-depth)', async () => {
    const creds = {
      loginUrl: 'https://example.com/login',
      username: 'u',
      password: 'p',
    };
    await page!.goto(FIXTURE_URL);
    await executeVisionAction(page!, { action: 'screenshot' }, creds);
    const beforeAct = await page!.locator('[data-staxis-som-badge]').count();
    assert.ok(beforeAct > 0, 'expected badges to exist after a screenshot');
    // Mouse move at an empty location — non-interactive but goes through
    // the action dispatch and should clear SoM at the top of the switch.
    await executeVisionAction(
      page!,
      { action: 'mouse_move', coordinate: [1100, 700] },
      creds,
    );
    const afterAct = await page!.locator('[data-staxis-som-badge]').count();
    assert.equal(afterAct, 0, 'badges must be cleared by the next non-screenshot action');
  });
});
