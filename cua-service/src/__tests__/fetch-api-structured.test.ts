/**
 * fetch_api structured-endpoint plumbing (Chat 1) — offline, no Playwright.
 *
 * The fake Page's evaluate() runs the extractor's in-page function in THIS
 * process against a stubbed globalThis.fetch, so the test exercises the real
 * request-building + response-handling code paths:
 *
 *   1. An api-mode recipe → adapter → fetch_api source replays with the URL
 *      and POST body RE-TEMPLATED to the CURRENT date (stale-date guard).
 *   2. jsonPath resolves nested row arrays; missing/odd paths fail LOUDLY.
 *   3. Non-2xx / non-JSON responses fail with structured reasons.
 *   4. End-to-end: recipeToTableTemplates → runSingleSourceTemplate returns
 *      canonical parsed rows (columns + parsers wired by the adapter).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import { extractFetchApi, resolveJsonPath } from '../extractors/fetch-api.js';
import { runSingleSourceTemplate } from '../extractors/template-runner.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import { todayParts } from '../extractors/date-template.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { Recipe } from '../types.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** Page whose evaluate() runs the callback locally (Node 20 has fetch). */
function fakePage(): Page {
  return {
    evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args),
  } as unknown as Page;
}

interface RecordedRequest { url: string; init: RequestInit }

/** Swap globalThis.fetch for a recorder returning a canned response. */
async function withFetchStub<T>(
  respond: (url: string) => { status?: number; json?: unknown; textBody?: string },
  run: () => Promise<T>,
): Promise<{ result: T; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const r = respond(String(url));
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (r.json === undefined) throw new SyntaxError('Unexpected token < in JSON');
        return r.json;
      },
      text: async () => r.textBody ?? '',
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, requests };
  } finally {
    globalThis.fetch = original;
  }
}

/** Today's date in the default render timezone, for assertions. */
function isoToday(): string {
  const p = todayParts(process.env.CUA_PMS_TZ || 'America/Chicago');
  return `${p.year}-${p.month}-${p.day}`;
}
function mdyTodayEncoded(): string {
  const p = todayParts(process.env.CUA_PMS_TZ || 'America/Chicago');
  return encodeURIComponent(`${p.month}/${p.day}/${p.year}`);
}

const feedSpec = (over: Partial<FeedSpec> & { url: string }): FeedSpec => ({
  mode: 'fetch_api',
  ...over,
});

// ─── resolveJsonPath unit ──────────────────────────────────────────────────

describe('resolveJsonPath', () => {
  const doc = { data: { reservations: [{ id: 1 }], count: 2, empty: null }, list: [{ rows: [1, 2] }] };

  test('nested object path resolves', () => {
    const r = resolveJsonPath(doc, 'data.reservations');
    assert.deepEqual(r, { found: true, value: [{ id: 1 }] });
  });

  test('numeric segments index arrays', () => {
    const r = resolveJsonPath(doc, 'list.0.rows');
    assert.deepEqual(r, { found: true, value: [1, 2] });
  });

  test('missing segment reports WHERE it stopped', () => {
    const r = resolveJsonPath(doc, 'data.bookings.rows');
    assert.deepEqual(r, { found: false, stoppedAt: 'data.bookings' });
  });

  test('descending through null/scalars stops safely', () => {
    assert.deepEqual(resolveJsonPath(doc, 'data.empty.x'), { found: false, stoppedAt: 'data.empty.x' });
    assert.deepEqual(resolveJsonPath(doc, 'data.count.x'), { found: false, stoppedAt: 'data.count.x' });
    assert.deepEqual(resolveJsonPath(null, 'a'), { found: false, stoppedAt: 'a' });
  });
});

// ─── extractFetchApi behavior ──────────────────────────────────────────────

describe('extractFetchApi', () => {
  test('re-templates {today} in URL at fetch time (stale-date guard)', async () => {
    const { result, requests } = await withFetchStub(
      () => ({ json: [] }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: 'https://pms.example/api/arrivals?date={today}' }),
      }),
    );
    assert.equal(result.ok, true);
    // Frozen template, current date on the wire.
    assert.equal(requests[0]!.url, `https://pms.example/api/arrivals?date=${isoToday()}`);
  });

  test('re-templates with the LEARNED format (extra.dateRender), encoded in URL', async () => {
    const { requests } = await withFetchStub(
      () => ({ json: [] }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({
          url: 'https://pms.example/api?d={today}',
          extra: { dateRender: { order: 'MDY', separator: '/', confidence: 'high' } },
        }),
      }),
    );
    assert.equal(requests[0]!.url, `https://pms.example/api?d=${mdyTodayEncoded()}`);
  });

  test('re-templates the POST bodyTemplate too (form-encoded)', async () => {
    const { requests } = await withFetchStub(
      () => ({ json: { rows: [] } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({
          url: 'https://pms.example/api/report',
          extra: { method: 'POST', body: 'start={today}&scope=all' },
        }),
      }),
    );
    const init = requests[0]!.init;
    assert.equal(init.method, 'POST');
    assert.equal(init.body, `start=${isoToday()}&scope=all`);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
  });

  test('JSON bodyTemplate renders raw and is sent as application/json', async () => {
    const { requests } = await withFetchStub(
      () => ({ json: [] }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({
          url: 'https://pms.example/api/q',
          extra: { method: 'POST', body: '{"date":"{today}"}' },
        }),
      }),
    );
    assert.equal(requests[0]!.init.body, `{"date":"${isoToday()}"}`);
    assert.equal((requests[0]!.init.headers as Record<string, string>)['content-type'], 'application/json');
  });

  test('jsonPath resolves the row array', async () => {
    const { result } = await withFetchStub(
      () => ({ json: { data: { reservations: [{ id: 'A' }, { id: 'B' }] } } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({
          url: 'https://pms.example/api/r',
          extra: { jsonPath: 'data.reservations' },
        }),
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [{ id: 'A' }, { id: 'B' }]);
  });

  test('jsonPath resolving to a single object wraps it as one row', async () => {
    const { result } = await withFetchStub(
      () => ({ json: { data: { counts: { occupied: 12 } } } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: 'https://x.example/api', extra: { jsonPath: 'data.counts' } }),
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [{ occupied: 12 }]);
  });

  test('MISSING jsonPath fails LOUDLY (no silent empty success)', async () => {
    const { result } = await withFetchStub(
      () => ({ json: { data: {} } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: 'https://x.example/api', extra: { jsonPath: 'data.reservations' } }),
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /jsonPath "data\.reservations" did not resolve/);
    assert.match(result.reason!, /stopped at "data\.reservations"/);
  });

  test('jsonPath resolving to a scalar fails with a typed reason', async () => {
    const { result } = await withFetchStub(
      () => ({ json: { data: { reservations: 42 } } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: 'https://x.example/api', extra: { jsonPath: 'data.reservations' } }),
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /resolved to number/);
  });

  test('non-2xx fails with HTTP status', async () => {
    const { result } = await withFetchStub(
      () => ({ status: 500, json: {} }),
      () => extractFetchApi({ page: fakePage(), feedSpec: feedSpec({ url: 'https://x.example/api' }) }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HTTP 500');
  });

  test('non-JSON 200 (login wall) fails with a structured reason', async () => {
    const { result } = await withFetchStub(
      () => ({ json: undefined, textBody: '<html>login</html>' }),
      () => extractFetchApi({ page: fakePage(), feedSpec: feedSpec({ url: 'https://x.example/api' }) }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /not valid JSON/);
  });

  test('missing url fails fast', async () => {
    const result = await extractFetchApi({ page: fakePage(), feedSpec: { mode: 'fetch_api' } });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /missing url/);
  });
});

// ─── End-to-end: api recipe → adapter → template-runner → canonical rows ──

describe('api recipe end-to-end replay', () => {
  function apiRecipe(): Recipe {
    return {
      schema: 1,
      login: { startUrl: 'https://pms.example/login', steps: [], successSelectors: ['.dash'] },
      // The PMS-wide learned date format rides the recipe (mapper output).
      dateFormat: { order: 'MDY', separator: '/', confidence: 'high' },
      actions: {
        getArrivals: {
          // Clicking around triggered the capture during mapping; runtime
          // must NOT need these steps (and must not flag incomplete).
          steps: [
            { kind: 'goto', url: 'https://pms.example/arrivals' },
            { kind: 'click', selector: '#load-arrivals' },
          ],
          parse: {
            mode: 'api',
            hint: {
              url: 'https://pms.example/api/arrivals?date={today}',
              method: 'GET',
              jsonPath: 'data.reservations',
              columns: {
                pms_reservation_id: 'confirmationNumber',
                guest_name: 'guest.name',           // nested → dot-path fallback
                arrival_date: 'arrivalDate',
                departure_date: 'departureDate',
                room_number: 'roomNumber',
              },
            },
          },
        },
      },
    };
  }

  test('adapter wires url/method/jsonPath/dateRender and does NOT flag incomplete', () => {
    const { templates } = recipeToTableTemplates(apiRecipe());
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations');
    assert.ok(tmpl, 'expected a pms_reservations template');
    assert.equal(tmpl!.incomplete, undefined, 'api recipes must not be flagged incomplete');
    const src = tmpl!.sources[0]!;
    assert.equal(src.mode, 'fetch_api');
    assert.equal(src.url, 'https://pms.example/api/arrivals?date={today}');
    assert.equal(src.extra?.jsonPath, 'data.reservations');
    assert.deepEqual(src.extra?.dateRender, { order: 'MDY', separator: '/', confidence: 'high' });
    assert.equal(src.extra?.method, 'GET');
  });

  test('runSingleSourceTemplate replays the endpoint and returns canonical parsed rows', async () => {
    const p = todayParts(process.env.CUA_PMS_TZ || 'America/Chicago');
    const mdyToday = `${p.month}/${p.day}/${p.year}`;
    const { templates } = recipeToTableTemplates(apiRecipe());
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations')!;

    const { result, requests } = await withFetchStub(
      () => ({
        json: {
          data: {
            reservations: [{
              confirmationNumber: 'CONF-77',
              guest: { name: 'Sam Lee' },
              arrivalDate: mdyToday,
              departureDate: mdyToday,
              roomNumber: '204',
            }],
          },
        },
      }),
      () => runSingleSourceTemplate({
        page: fakePage(),
        template: tmpl,
        allowedHost: 'pms.example',
        signal: new AbortController().signal,
      }),
    );

    // Date went out re-templated to TODAY in the learned MDY format.
    assert.equal(requests[0]!.url, `https://pms.example/api/arrivals?date=${encodeURIComponent(mdyToday)}`);

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.pms_reservation_id, 'CONF-77');
    assert.equal(row.guest_name, 'Sam Lee');           // nested JSON via dot-path
    assert.equal(row.room_number, '204');
    // generic_date parsed the learned-MDY value to ISO.
    assert.equal(row.arrival_date, `${p.year}-${p.month}-${p.day}`);
  });

  test('a drifted response shape fails the FEED, not silently 0 rows', async () => {
    const { templates } = recipeToTableTemplates(apiRecipe());
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations')!;
    const { result } = await withFetchStub(
      () => ({ json: { totallyDifferent: true } }),
      () => runSingleSourceTemplate({
        page: fakePage(),
        template: tmpl,
        allowedHost: 'pms.example',
        signal: new AbortController().signal,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason!, /jsonPath/);
  });
});
