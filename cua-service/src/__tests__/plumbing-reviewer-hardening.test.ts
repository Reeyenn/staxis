/**
 * Independent-reviewer hardening pass (Chat 1 plumbing, second session) —
 * offline, no DB, no Playwright. Pins the fixes layered on top of the
 * builder pass:
 *
 *   1. RUNNER-level blank-required-column guard (findBlankContractColumns).
 *      The writer's descriptor guard protects the DATA but not the SIGNAL:
 *      session-driver counts EXTRACTION rows for read-health + the zero-row
 *      self-repair streak BEFORE the write, so an all-blank feed had to
 *      fail at the runner or it would reset the drift streak every poll
 *      and self-repair could never fire.
 *   2. jsonPath resolving to an array of NON-OBJECTS fails loudly (wrong
 *      node — every column would otherwise parse to null "successfully").
 *   3. HTTP 401/403 carries an auth hint (session problem ≠ shape drift).
 *   4. %7Btoday%7D — the percent-encoded placeholder spelling renders too
 *      (network capture stores ENCODED urls; literal-only matching would
 *      ship braces to the server forever).
 *   5. normalizeNativeValuesForText: JSON-native numbers/booleans coerce to
 *      strings for TEXT descriptor columns only (a numeric reservation id
 *      must not reject every row of a healthy structured feed).
 *   6. drillDown forces dom_table — an api/csv parse hint must not leave
 *      fetch_api pointed at the HTML list page.
 */

// MUST be first: generic-table-writer transitively builds the Supabase client.
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import {
  runSingleSourceTemplate,
  findBlankContractColumns,
} from '../extractors/template-runner.js';
import { runMultiSourceTemplate } from '../extractors/multi-source-runner.js';
import { extractFetchApi } from '../extractors/fetch-api.js';
import {
  renderDatePlaceholders,
  hasDatePlaceholder,
  todayParts,
} from '../extractors/date-template.js';
import {
  validateRows,
  normalizeNativeValuesForText,
  type TableSchemaDescriptor,
} from '../persistence/generic-table-writer.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { Recipe, TableTemplate } from '../types.js';

// ─── Fakes (mirrors fetch-api-structured.test.ts conventions) ───────────────

/** Page whose evaluate() runs the callback locally (Node 20 has fetch). */
function fakePage(): Page {
  return {
    evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args),
  } as unknown as Page;
}

/** Swap globalThis.fetch for a stub returning a canned per-URL response. */
async function withFetchStub<T>(
  respond: (url: string) => { status?: number; json?: unknown },
  run: () => Promise<T>,
): Promise<T> {
  return (await withRecordingFetchStub(respond, run)).result;
}

interface RecordedRequest { url: string; init: RequestInit }

async function withRecordingFetchStub<T>(
  respond: (url: string) => { status?: number; json?: unknown },
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
        if (r.json === undefined) throw new SyntaxError('not json');
        return r.json;
      },
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, requests };
  } finally {
    globalThis.fetch = original;
  }
}

const feedSpec = (over: Partial<FeedSpec> & { url: string }): FeedSpec => ({
  mode: 'fetch_api',
  ...over,
});

const HOST = 'pms.example.com';

/** Minimal api-mode recipe for getArrivals (jsonPath + column map). */
function arrivalsApiRecipe(): Recipe {
  return {
    schema: 1,
    login: { startUrl: `https://${HOST}/login`, steps: [], successSelectors: [] },
    actions: {
      getArrivals: {
        steps: [{ kind: 'goto', url: `https://${HOST}/arrivals` }],
        parse: {
          mode: 'api',
          hint: {
            url: `https://${HOST}/api/arrivals`,
            method: 'GET',
            jsonPath: 'data.rows',
            columns: {
              pms_reservation_id: 'id',
              guest_name: 'guest',
              arrival_date: 'arrive',
              departure_date: 'depart',
            },
          },
        },
      },
    },
  };
}

function arrivalsTemplate(): TableTemplate {
  const { templates } = recipeToTableTemplates(arrivalsApiRecipe());
  assert.equal(templates.length, 1);
  return templates[0]!;
}

const apiRow = (id: string, n: number) => ({
  id,
  guest: `Guest ${n}`,
  arrive: '2026-06-10',
  depart: '2026-06-12',
});

// ─── 1. Runner-level contract guard ─────────────────────────────────────────

describe('findBlankContractColumns (runner-level signal guard)', () => {
  const rows = (id: string) => [
    { pms_reservation_id: id, guest_name: 'A', arrival_date: '2026-06-10', departure_date: '2026-06-12' },
    { pms_reservation_id: id, guest_name: 'B', arrival_date: '2026-06-10', departure_date: '2026-06-12' },
  ];

  test('required column blank in EVERY row is flagged', () => {
    assert.deepEqual(findBlankContractColumns(arrivalsTemplate(), rows('')), ['pms_reservation_id']);
  });

  test('one good value clears the column (partial blanks are per-row business)', () => {
    const mixed = [...rows(''), ...rows('R-1')];
    assert.deepEqual(findBlankContractColumns(arrivalsTemplate(), mixed), []);
  });

  test('zero rows never fire the guard (empty feed = healthy no-op)', () => {
    assert.deepEqual(findBlankContractColumns(arrivalsTemplate(), []), []);
  });

  test('templates without a sourceActionKey or non-core actions are exempt', () => {
    const t = arrivalsTemplate();
    const blankRows = rows('');
    assert.deepEqual(findBlankContractColumns({ ...t, sourceActionKey: undefined }, blankRows), []);
    // getGuests is not a CORE contract → requiredLearnedFor returns [].
    assert.deepEqual(findBlankContractColumns({ ...t, sourceActionKey: 'getGuests' }, blankRows), []);
  });
});

describe('runSingleSourceTemplate fails the FEED (not just the write) on all-blank required columns', () => {
  test('all-blank pms_reservation_id → ok:false with blank_required_columns reason', async () => {
    const result = await withFetchStub(
      () => ({ json: { data: { rows: [apiRow('', 1), apiRow('', 2)] } } }),
      () => runSingleSourceTemplate({
        page: fakePage(),
        template: arrivalsTemplate(),
        allowedHost: HOST,
        signal: new AbortController().signal,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /blank_required_columns/);
    assert.match(result.reason ?? '', /pms_reservation_id/);
    // The runner must report ZERO rows so session-driver's
    // `runResult.rows.length > 0` read-health/self-repair checks see a
    // FAILURE (streak builds) instead of a healthy extraction.
    assert.equal(result.rows.length, 0);
  });

  test('fence: healthy rows pass through untouched', async () => {
    const result = await withFetchStub(
      () => ({ json: { data: { rows: [apiRow('R-1', 1), apiRow('R-2', 2)] } } }),
      () => runSingleSourceTemplate({
        page: fakePage(),
        template: arrivalsTemplate(),
        allowedHost: HOST,
        signal: new AbortController().signal,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]!.pms_reservation_id, 'R-1');
  });
});

describe('runMultiSourceTemplate applies the same guard after aggregation', () => {
  test('concat_rows from a core action with all-blank ids → ok:false', async () => {
    const base = arrivalsTemplate();
    const src = (name: string, url: string) => ({
      ...base.sources[0]!, name, url,
    });
    const template: TableTemplate = {
      ...base,
      sources: [src('a', `https://${HOST}/api/a`), src('b', `https://${HOST}/api/b`)],
      aggregate: { strategy: 'concat_rows' },
    };
    const result = await withFetchStub(
      () => ({ json: { data: { rows: [apiRow('', 1)] } } }),
      () => runMultiSourceTemplate({
        page: fakePage(),
        template,
        allowedHost: HOST,
        signal: new AbortController().signal,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /blank_required_columns/);
  });
});

// ─── 2. jsonPath row-shape validation ───────────────────────────────────────

describe('jsonPath resolving to non-object rows fails loudly', () => {
  test('array of scalars → ok:false naming the offending element', async () => {
    const result = await withFetchStub(
      () => ({ json: { data: { rows: [101, 102, 103] } } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x`, extra: { jsonPath: 'data.rows' } }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /element 0 is number/);
  });

  test('fence: empty array at the path is a legitimate empty feed', async () => {
    const result = await withFetchStub(
      () => ({ json: { data: { rows: [] } } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x`, extra: { jsonPath: 'data.rows' } }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, []);
  });
});

// ─── 3. Auth-flavored HTTP failures ─────────────────────────────────────────

describe('401/403 carry an auth hint', () => {
  test('HTTP 401 → reason flags a session problem, not drift', async () => {
    const result = await withFetchStub(
      () => ({ status: 401 }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x` }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HTTP 401 (auth — session may have expired)');
  });

  test('other statuses stay bare', async () => {
    const result = await withFetchStub(
      () => ({ status: 500 }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x` }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.reason, 'HTTP 500');
  });
});

// ─── 3b. Transport hygiene (coordination-note items) ────────────────────────

describe('fetch transport hygiene', () => {
  test('every fetch is cache:no-store — browser cache must never serve a stale poll', async () => {
    const { requests } = await withRecordingFetchStub(
      () => ({ json: [] }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x` }),
        allowedHost: HOST,
      }),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.init.cache, 'no-store');
  });

  test('GET with a body drops the body instead of throwing a cryptic TypeError', async () => {
    const { result, requests } = await withRecordingFetchStub(
      () => ({ json: [] }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x`, extra: { method: 'GET', body: 'a=1' } }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(requests[0]!.init.body, undefined);
  });

  test('whitespace-only jsonPath is treated as absent (heuristic unwrap, not root-wrap)', async () => {
    const result = await withFetchStub(
      () => ({ json: { rows: [{ id: 'R-1' }] } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x`, extra: { jsonPath: '   ' } }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.ok, true);
    // Absent jsonPath → extractor returns the raw envelope; the runner's
    // heuristic unwraps .rows. A truthy-whitespace path would instead have
    // wrapped the WHOLE envelope as one garbage row.
    assert.deepEqual(result.data, { rows: [{ id: 'R-1' }] });
  });

  test('bracket path spellings normalize: data.rows[0] resolves', async () => {
    const result = await withFetchStub(
      () => ({ json: { data: { rows: [{ id: 'R-9' }] } } }),
      () => extractFetchApi({
        page: fakePage(),
        feedSpec: feedSpec({ url: `https://${HOST}/api/x`, extra: { jsonPath: 'data.rows[0]' } }),
        allowedHost: HOST,
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [{ id: 'R-9' }]);
  });
});

// ─── 3c. preStep values render {today} (stale-date guard for csv filters) ───

describe('replayPreSteps renders date placeholders in fill/select/type values', () => {
  test('a {today} fill value is typed as today, not as a literal brace string', async () => {
    const fills: Array<{ selector: string; value: string }> = [];
    const page = {
      fill: async (selector: string, value: string) => { fills.push({ selector, value }); },
    } as unknown as Page;
    const { replayPreSteps } = await import('../extractors/pre-steps.js');
    // Frozen clock: replay + assertion share one Date so the test can't
    // split across a Chicago midnight (Codex P2).
    const now = new Date('2026-06-10T18:00:00Z');
    const r = await replayPreSteps(page, [{ kind: 'fill', selector: '#start-date', value: '{today}' }], {
      learnedFormat: { order: 'MDY', separator: '/', confidence: 'high' },
      timezone: 'America/Chicago',
      now,
    });
    assert.equal(r.ok, true);
    const p = todayParts('America/Chicago', now);
    assert.deepEqual(fills, [{ selector: '#start-date', value: `${p.month}/${p.day}/${p.year}` }]);
  });
});

// ─── 4. Percent-encoded placeholder spelling ────────────────────────────────

describe('%7Btoday%7D — encoded placeholder spelling', () => {
  const now = new Date('2026-06-10T18:00:00Z');
  const p = todayParts('America/Chicago', now);

  test('renders with the substituted value percent-encoded', () => {
    const out = renderDatePlaceholders(`https://${HOST}/r?start=%7Btoday%7D&end=%7BDATE%7D`, {
      context: 'url',
      timezone: 'America/Chicago',
      learnedFormat: { order: 'MDY', separator: '/', confidence: 'high' },
      now,
    });
    const expected = encodeURIComponent(`${p.month}/${p.day}/${p.year}`);
    assert.equal(out, `https://${HOST}/r?start=${expected}&end=${expected}`);
  });

  test('hasDatePlaceholder sees the encoded spelling; render clears it', () => {
    assert.equal(hasDatePlaceholder('a=%7Btoday%7D'), true);
    const out = renderDatePlaceholders('a=%7Btoday%7D', {
      context: 'url', timezone: 'America/Chicago', now,
    });
    assert.equal(hasDatePlaceholder(out), false);
  });
});

// ─── 5. Native-type coercion for text columns ───────────────────────────────

describe('normalizeNativeValuesForText', () => {
  const descriptor: TableSchemaDescriptor = {
    table_name: 'pms_work_orders_v2',
    write_strategy: 'reconcile',
    snapshot_scope_default: 'full',
    natural_key: ['property_id', 'pms_work_order_id'],
    reconcile_key_field: 'pms_work_order_id',
    columns: [
      { name: 'pms_work_order_id', type: 'text', required: true, nullable: false },
      { name: 'description', type: 'text', required: true, nullable: false },
      { name: 'out_of_order', type: 'boolean', required: true, nullable: false },
      { name: 'priority_rank', type: 'integer', required: false, nullable: true },
    ],
  };

  test('JSON-native number/boolean coerce to strings for TEXT columns only', () => {
    const [row] = normalizeNativeValuesForText(
      [{ pms_work_order_id: 4471, description: true, out_of_order: false, priority_rank: 2 }],
      descriptor,
    );
    assert.equal(row!.pms_work_order_id, '4471');     // number → string (text col)
    assert.equal(row!.description, 'true');           // boolean → string (text col)
    assert.equal(row!.out_of_order, false);           // boolean col keeps native
    assert.equal(row!.priority_rank, 2);              // integer col keeps native
  });

  test('coerced rows pass validateRows where raw native values rejected', () => {
    const raw = [{ pms_work_order_id: 4471, description: 'leaky faucet', out_of_order: false }];
    assert.equal(validateRows(raw, descriptor).rejected.length, 1);
    const fixed = normalizeNativeValuesForText(raw, descriptor);
    const outcome = validateRows(fixed, descriptor);
    assert.equal(outcome.rejected.length, 0);
    assert.equal(outcome.valid.length, 1);
  });

  test('rows without native values are returned by reference (no churn)', () => {
    const rows = [{ pms_work_order_id: 'WO-1', description: 'x', out_of_order: true }];
    assert.equal(normalizeNativeValuesForText(rows, descriptor)[0], rows[0]);
  });

  test('UNSAFE integers and non-finite numbers are NOT coerced — they must reject loudly', () => {
    // 2^53 + 2: already precision-corrupted by JSON.parse — String() would
    // mint a plausible-but-wrong id (Codex P1). Leave native → type reject.
    const unsafe = 9007199254740994;
    const [row] = normalizeNativeValuesForText(
      [{ pms_work_order_id: unsafe, description: NaN, out_of_order: false }],
      descriptor,
    );
    assert.equal(row!.pms_work_order_id, unsafe);
    assert.ok(Number.isNaN(row!.description));
    const outcome = validateRows([row!], descriptor);
    assert.equal(outcome.rejected.length, 1);
    // Safe-range floats still coerce faithfully.
    const [ok] = normalizeNativeValuesForText(
      [{ pms_work_order_id: 3.5, description: 'x', out_of_order: false }],
      descriptor,
    );
    assert.equal(ok!.pms_work_order_id, '3.5');
  });
});

// ─── 6. drillDown forces dom_table ──────────────────────────────────────────

describe('drillDown + api parse hint', () => {
  test('the collapsed list-page source is dom_table, never fetch_api', () => {
    const recipe = arrivalsApiRecipe();
    const guests: Recipe['actions']['getGuests'] = {
      steps: [{ kind: 'goto', url: `https://${HOST}/guests` }],
      parse: {
        mode: 'api',
        hint: {
          url: `https://${HOST}/api/guests`,
          method: 'GET',
          columns: { pms_guest_id: 'id', name: 'n' },
        },
      },
      drillDown: {
        listUrl: `https://${HOST}/guests/list`,
        listRowSelector: 'tr.guest',
        listColumns: { pms_guest_id: '.id', name: '.nm' },
        detailUrlTemplate: `https://${HOST}/guests/{pms_guest_id}`,
        detailUrlParams: { pms_guest_id: 'pms_guest_id' },
        detailColumns: {},
        fieldCoverage: {},
        samplesDrilled: 4,
        templateVerified: true,
      },
    };
    recipe.actions = { getGuests: guests };
    const { templates } = recipeToTableTemplates(recipe);
    assert.equal(templates.length, 1);
    const source = templates[0]!.sources[0]!;
    assert.equal(source.mode, 'dom_table');
    assert.equal(source.url, `https://${HOST}/guests/list`);
    assert.equal(source.selectors?.rowSelector, 'tr.guest');
  });
});
