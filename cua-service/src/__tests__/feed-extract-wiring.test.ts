/**
 * feature/cua-feed-extract — the #1 onboarding blocker: feeds reached by
 * CLICKING through menus extracted ZERO rows because the recipe never recorded
 * a `goto` for the page the click landed on, so the runtime navigated back to
 * the dashboard and waited for a row selector that never appeared.
 *
 * These tests pin the fix end-to-end across the three seams:
 *
 *   1. mapper.recordLandingGoto — at each turn top, a click-navigation to a NEW
 *      url records a `goto` for the landing page (direct nav); a same-url
 *      interaction (SPA route swap, in-page Generate/filter click) records NO
 *      goto, so the click survives as a replayable pre-step.
 *   2. recipe-adapter — a dom_table feed's source url = the last goto, and the
 *      residual in-page interactions ride source.extra.preSteps. `incomplete`
 *      now means "no source url at all", not "has interactions".
 *   3. extractors/dom-table — replays those preSteps after navigation and
 *      before scraping, so a click-reached feed returns real rows.
 *
 * Plus: the 3 net-new feeds (getRoomLayout / getDashboardCounts /
 * getHistoricalOccupancy) are enrolled in the learner loop AND route to the
 * correct write tables.
 */

// Node-20 WebSocket shim + env bootstrap — MUST precede any import that loads
// ../mapper.js (→ src/supabase.ts builds a RealtimeClient at module load). See
// __tests__/ws-polyfill.ts.
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordLandingGoto,
  lastRecordedGotoUrl,
  targetKeysForTests,
} from '../mapper.js';
import {
  actionRecipeToTableTemplate,
  recipeToTableTemplates,
  deriveDomPreStepsFromSteps,
} from '../recipe-adapter.js';
import { extractDomTable } from '../extractors/dom-table.js';
import type { Page } from 'playwright';
import type { Recipe, RecipeStep } from '../types.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { PreStep } from '../extractors/pre-steps.js';

const DASH = 'https://pms.example/dashboard';

// ─── 1. recordLandingGoto — the mapper's turn-top URL anchoring ──────────────

describe('recordLandingGoto (mapper)', () => {
  test('a click that navigates to a NEW url records a goto for the landing page', () => {
    const steps: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    steps.push({ kind: 'click_at', x: 10, y: 20 });
    recordLandingGoto(steps, 'https://pms.example/arrivals');
    assert.equal(lastRecordedGotoUrl(steps), 'https://pms.example/arrivals');
    assert.equal(steps.filter((s) => s.kind === 'goto').length, 2);
  });

  test('a same-url interaction (SPA route swap) records NO goto', () => {
    const steps: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    steps.push({ kind: 'click_at', x: 10, y: 20 });
    recordLandingGoto(steps, DASH); // url unchanged
    assert.equal(steps.filter((s) => s.kind === 'goto').length, 1);
  });

  test('a cache-buster query is NOT navigation; a semantic query IS', () => {
    const cb: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    recordLandingGoto(cb, `${DASH}?t=1718384000`); // epoch cache-buster → inert
    assert.equal(cb.filter((s) => s.kind === 'goto').length, 1);

    const sem: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    recordLandingGoto(sem, `${DASH}?view=arrivals`); // semantic → navigation
    assert.equal(sem.filter((s) => s.kind === 'goto').length, 2);
    assert.equal(lastRecordedGotoUrl(sem), `${DASH}?view=arrivals`);
  });

  test('unreadable / empty url is a no-op (best-effort)', () => {
    const steps: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    recordLandingGoto(steps, '');
    assert.equal(steps.length, 1);
  });

  test('nav-then-in-page-interaction: goto lands BEFORE the Generate click (sequencing)', () => {
    // Replays exactly what the mapper now does across turns for a report page
    // that needs a "Generate" click which keeps the URL the same.
    const steps: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    // Turn A: click the Reports menu → url changes to /reports.
    steps.push({ kind: 'click_at', x: 10, y: 20 });
    // Turn B top: anchor the landing url.
    recordLandingGoto(steps, 'https://pms.example/reports');
    // Turn B: click Generate → url stays /reports.
    steps.push({ kind: 'click_at', x: 30, y: 40 });
    // Turn C top (success turn): url unchanged → no extra goto.
    recordLandingGoto(steps, 'https://pms.example/reports');

    // The Generate click sits AFTER the landing goto → it survives as a preStep.
    const tmpl = actionRecipeToTableTemplate('getArrivals', {
      steps,
      parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
    });
    assert.equal(tmpl!.sources[0]!.url, 'https://pms.example/reports');
    assert.deepEqual(tmpl!.sources[0]!.extra?.preSteps, [{ kind: 'click_at', x: 30, y: 40 }]);
    assert.equal(tmpl!.incomplete, undefined);
  });

  test('SAME-turn batched nav+Generate: per-action anchoring keeps the Generate click as a preStep', () => {
    // The per-action recordLandingGoto call (in the tool loop) handles the case
    // where ONE agent turn batches a navigating click and an in-page click and
    // the nav commits synchronously (SPA pushState). Both clicks land in the
    // same turn; the goto must still slot between them.
    const steps: RecipeStep[] = [{ kind: 'goto', url: DASH }];
    steps.push({ kind: 'click_at', x: 10, y: 20 });          // open Reports
    recordLandingGoto(steps, 'https://pms.example/reports');  // per-action #1 (url changed)
    steps.push({ kind: 'click_at', x: 30, y: 40 });          // Generate (url stays)
    recordLandingGoto(steps, 'https://pms.example/reports');  // per-action #2 (no change)

    const tmpl = actionRecipeToTableTemplate('getArrivals', {
      steps,
      parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
    });
    assert.equal(tmpl!.sources[0]!.url, 'https://pms.example/reports');
    assert.deepEqual(tmpl!.sources[0]!.extra?.preSteps, [{ kind: 'click_at', x: 30, y: 40 }]);
  });
});

// ─── 2. recipe-adapter — dom_table pre-step derivation ───────────────────────

describe('deriveDomPreStepsFromSteps + dom_table template', () => {
  test('steps after the last goto become preSteps; credentials are dropped', () => {
    const steps: RecipeStep[] = [
      { kind: 'goto', url: DASH },
      { kind: 'click', selector: '#menu' },
      { kind: 'fill', selector: '#user', value: '$username' }, // credential → dropped
      { kind: 'fill', selector: '#search', value: 'rooms' },
      { kind: 'wait_for', selector: 'tr.res', timeoutMs: 4000 },
    ];
    const pre = deriveDomPreStepsFromSteps(steps);
    assert.deepEqual(pre, [
      { kind: 'click', selector: '#menu' },
      { kind: 'fill', selector: '#search', value: 'rooms' },
      { kind: 'wait_for', selector: 'tr.res', timeoutMs: 4000 },
    ]);
  });

  test('a directly-navigable feed (trailing goto, no later interaction) has no preSteps', () => {
    const t = actionRecipeToTableTemplate('getArrivals', {
      steps: [
        { kind: 'goto', url: DASH },
        { kind: 'click_at', x: 5, y: 5 },
        { kind: 'goto', url: 'https://pms.example/arrivals' },
      ],
      parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
    });
    assert.equal(t!.sources[0]!.url, 'https://pms.example/arrivals');
    assert.equal(t!.sources[0]!.extra?.preSteps, undefined);
    assert.equal(t!.incomplete, undefined);
  });

  test('learned dateRender still rides a dom_table source carrying preSteps', () => {
    const t = actionRecipeToTableTemplate(
      'getArrivals',
      {
        steps: [
          { kind: 'goto', url: DASH },
          { kind: 'click', selector: '#menu' },
        ],
        parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
      },
      { dateFormat: { order: 'MDY', separator: '/', confidence: 'high' } },
    );
    assert.deepEqual(t!.sources[0]!.extra?.preSteps, [{ kind: 'click', selector: '#menu' }]);
    assert.deepEqual(t!.sources[0]!.extra?.dateRender, { order: 'MDY', separator: '/', confidence: 'high' });
  });
});

// ─── 3. extractors/dom-table — replay preSteps then scrape ───────────────────

/** Fake Playwright page: records interactions, serves canned rows from $$eval.
 *  feedSpec.url is omitted in the tests so safeGoto is skipped — this isolates
 *  the new pre-step replay + scrape path. */
function fakeDomPage(rows: Array<Record<string, string>>) {
  const calls: string[] = [];
  const page = {
    calls,
    async click(sel: string) { calls.push(`click:${sel}`); },
    async selectOption(sel: string, value: string) { calls.push(`select:${sel}=${value}`); },
    async fill(sel: string, value: string) { calls.push(`fill:${sel}=${value}`); },
    async waitForSelector(sel: string) { calls.push(`wait_for:${sel}`); },
    async waitForTimeout(ms: number) { calls.push(`wait_ms:${ms}`); },
    keyboard: {
      async type(t: string) { calls.push(`type:${t}`); },
      async press(k: string) { calls.push(`press:${k}`); },
    },
    mouse: {
      async click(x: number, y: number) { calls.push(`mouse_click:${x},${y}`); },
    },
    async $$eval(sel: string) {
      calls.push(`scrape:${sel}`);
      return { rows, totalMatched: rows.length };
    },
  };
  return page as unknown as Page & { calls: string[] };
}

describe('extractDomTable preStep replay (end-to-end)', () => {
  test('SPA feed: preSteps replay in order BEFORE the row wait + scrape, rows returned', async () => {
    const page = fakeDomPage([{ guest_name: 'Ada' }, { guest_name: 'Lin' }]);
    const feedSpec: FeedSpec = {
      mode: 'dom_table',
      // no url → safeGoto skipped (navigation covered elsewhere)
      selectors: { rowSelector: 'tr.res' },
      columns: { guest_name: 'td.name' },
      extra: {
        preSteps: [
          { kind: 'click_at', x: 12, y: 34 },
          { kind: 'click', selector: '#tab-arrivals' },
        ] satisfies PreStep[],
      },
    };
    const res = await extractDomTable({ page, feedSpec, allowedHost: 'pms.example' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.rows, [{ guest_name: 'Ada' }, { guest_name: 'Lin' }]);
    // Order: pre-steps, THEN the row-selector wait, THEN the scrape.
    assert.deepEqual(page.calls, [
      'mouse_click:12,34',
      'click:#tab-arrivals',
      'wait_for:tr.res',
      'scrape:tr.res',
    ]);
  });

  test('a malformed preSteps payload fails the feed before any interaction', async () => {
    const page = fakeDomPage([{ guest_name: 'Ada' }]);
    const feedSpec: FeedSpec = {
      mode: 'dom_table',
      selectors: { rowSelector: 'tr.res' },
      columns: { guest_name: 'td.name' },
      extra: { preSteps: [{ kind: 'click' }] }, // missing selector
    };
    const res = await extractDomTable({ page, feedSpec, allowedHost: 'pms.example' });
    assert.equal(res.ok, false);
    assert.match(res.reason!, /invalid preSteps/);
    assert.deepEqual(page.calls, []); // nothing replayed, nothing scraped
  });

  test('no preSteps → behaves exactly as before (wait + scrape only)', async () => {
    const page = fakeDomPage([{ guest_name: 'Ada' }]);
    const feedSpec: FeedSpec = {
      mode: 'dom_table',
      selectors: { rowSelector: 'tr.res' },
      columns: { guest_name: 'td.name' },
    };
    const res = await extractDomTable({ page, feedSpec, allowedHost: 'pms.example' });
    assert.equal(res.ok, true);
    assert.deepEqual(page.calls, ['wait_for:tr.res', 'scrape:tr.res']);
  });
});

// ─── 4. the 3 net-new feeds are enrolled AND route correctly ─────────────────

describe('net-new feeds: getRoomLayout / getDashboardCounts / getHistoricalOccupancy', () => {
  test('all three are enrolled in the learner target loop', () => {
    const keys = targetKeysForTests();
    for (const k of ['getRoomLayout', 'getDashboardCounts', 'getHistoricalOccupancy'] as const) {
      assert.ok(keys.includes(k), `${k} must be in TARGETS so the learner learns it`);
    }
    // getInHouseSnapshot must NOT exist — getDashboardCounts IS the snapshot.
    assert.ok(!keys.includes('getInHouseSnapshot' as never));
  });

  test('each routes to its correct write table + keys via the adapter', () => {
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pms.example/login', steps: [], successSelectors: ['.dash'] },
      actions: {
        getRoomLayout: {
          steps: [{ kind: 'goto', url: 'https://pms.example/setup/rooms' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr.room', columns: { room_number: 'td.no' } } },
        },
        getDashboardCounts: {
          steps: [{ kind: 'goto', url: DASH }],
          parse: { mode: 'table', hint: { rowSelector: '#counters', columns: { total_occupied_rooms: '.occ' } } },
        },
        getHistoricalOccupancy: {
          steps: [{ kind: 'goto', url: 'https://pms.example/reports/occ' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr.day', columns: { date: 'td.d', occupied_rooms: 'td.o' } } },
        },
      },
    };
    const { templates, skipped } = recipeToTableTemplates(recipe);
    assert.equal(skipped.length, 0);
    const byTable = Object.fromEntries(templates.map((t) => [t.sourceActionKey, t]));

    assert.equal(byTable.getRoomLayout!.tableName, 'pms_rooms_inventory');
    assert.deepEqual(byTable.getRoomLayout!.keys, ['property_id', 'room_number']);

    assert.equal(byTable.getDashboardCounts!.tableName, 'pms_in_house_snapshot');
    assert.deepEqual(byTable.getDashboardCounts!.keys, ['property_id']);

    assert.equal(byTable.getHistoricalOccupancy!.tableName, 'pms_revenue_daily');
    assert.deepEqual(byTable.getHistoricalOccupancy!.keys, ['property_id', 'date']);

    // None flagged incomplete (each has a source url).
    for (const t of templates) assert.equal(t.incomplete, undefined);
  });
});
