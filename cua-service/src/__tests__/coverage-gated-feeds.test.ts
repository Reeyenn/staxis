/**
 * feature/coverage-gated-feeds (migration 0296) — WORKER half of per-feed
 * collection gating: `pms_knowledge_files.disabled_feeds`.
 *
 * The founder's Make-live only turns on feeds a preview capture proved readable;
 * the unproven feeds' action keys land in the sibling `disabled_feeds` jsonb
 * column (OUTSIDE the HMAC-signed knowledge envelope — toggling never needs a
 * re-sign). This suite pins the worker behaviours:
 *
 *   1. loadActiveDetailed surfaces disabledFeeds — present, missing → [], and
 *      junk entries dropped (defensive sanitize, since the value is un-signed).
 *   2. filterActionsForPolling excludes disabled feeds from the poll sweep and
 *      keeps the rest (the pure seam the session-driver builds templates from).
 *   3. disabledFeedsEqual — the pure hot-reload change detector: same set → no
 *      reload, changed set → reload (order-insensitive).
 *   4. autoEnableFeedOnCaptureSuccess — a successful Re-read removes the feed's
 *      key from the ACTIVE row's disabled_feeds; idempotent when absent; only
 *      touches the active row (status='active' guard captured on the UPDATE).
 *
 * DB is faked (chainable stub) via the injectable seams: knowledge-file exports
 * __setDbForTests for loadActiveDetailed's SELECT; autoEnableFeedOnCaptureSuccess
 * takes an injectable client argument. No live Supabase.
 */

// Env BEFORE any import that transitively loads env.ts / recipe-signing.ts, so
// signRecipe/verifyRecipe agree with package.json's test script.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-placeholder-for-tests';
process.env.RECIPE_SIGNING_KEY = process.env.RECIPE_SIGNING_KEY ?? 'test-recipe-key-32-bytes-or-more-padding';
process.env.RECIPE_SIGNING_KEY_PREVIOUS = process.env.RECIPE_SIGNING_KEY_PREVIOUS ?? 'previous-recipe-key-32-bytes-or-more!';

// supabase.ts builds a realtime client at module load → needs the WS shim.
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  loadActiveDetailed,
  sanitizeDisabledFeeds,
  __setDbForTests as __setKnowledgeDbForTests,
} from '../knowledge-file.js';
import { filterActionsForPolling, disabledFeedsEqual } from '../session-driver.js';
import { autoEnableFeedOnCaptureSuccess } from '../mapping-driver.js';
import { signRecipe } from '../recipe-signing.js';
import type { Recipe } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PMS_FAMILY = 'test-pms';

function tableAction(columns: Record<string, string>) {
  return {
    steps: [{ kind: 'goto', url: 'https://pms.example/x' }],
    parse: { mode: 'table', hint: { rowSelector: 'tbody tr', columns } },
  };
}

/** A gap-free knowledge envelope (all 4 core feeds present + complete). */
function fullKnowledge(): Record<string, unknown> {
  return {
    schema: 1,
    description: 'Test active',
    login: { startUrl: 'https://pms.example/login', steps: [{ kind: 'click', selector: 'b' }], successSelectors: ['.d'] },
    actions: {
      getRoomStatus: tableAction({ room_number: 'td:nth-child(1)', status: 'td:nth-child(2)', changed_by: 'td:nth-child(3)' }),
      getArrivals: tableAction({ pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)', arrival_date: 'td:nth-child(3)' }),
      getDepartures: tableAction({ pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)', departure_date: 'td:nth-child(3)' }),
      getWorkOrders: tableAction({ pms_work_order_id: 'td:nth-child(1)', description: 'td:nth-child(2)' }),
      getGuests: tableAction({ pms_guest_id: 'td:nth-child(1)', name: 'td:nth-child(2)' }),
    },
    hints: {},
  };
}

// ─── loadActiveDetailed SELECT stub ──────────────────────────────────────────
//
// The active-load chain is: from().select().eq('pms_family').eq('status').is().maybeSingle().

function makeActiveStub(row: Record<string, unknown> | null): SupabaseClient {
  return {
    from(_t: string) {
      return {
        select(_c?: string) {
          const chain: any = {
            eq(_c2: string, _v: unknown) { return chain; },
            is(_c2: string, _v: unknown) { return chain; },
            maybeSingle() { return Promise.resolve({ data: row, error: null }); },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
}

/** An ACTIVE row shaped for loadActiveDetailed's unwrap()/select (signed so it
 *  passes the signature gate), with an overridable disabled_feeds column. */
function makeActiveRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const stored = JSON.parse(JSON.stringify(fullKnowledge()));
  const sig = signRecipe(stored as unknown as Recipe);
  return {
    id: 'active-1', pms_family: PMS_FAMILY, version: 3, status: 'active',
    knowledge: stored, learned_at: new Date().toISOString(), created_by: 'mapper:test',
    signature: '\\x' + sig.signature.toString('hex'), signed_with_key_id: sig.signedWithKeyId,
    disabled_feeds: [],
    ...over,
  };
}

async function withActiveStub<T>(stub: SupabaseClient, fn: () => Promise<T>): Promise<T> {
  const restore = __setKnowledgeDbForTests(stub);
  try { return await fn(); } finally { restore(); }
}

describe('sanitizeDisabledFeeds — defensive coercion of the un-signed jsonb', () => {
  test('a clean array is preserved (deduped)', () => {
    assert.deepEqual(sanitizeDisabledFeeds(['getGuests', 'getWorkOrders', 'getGuests']).sort(), ['getGuests', 'getWorkOrders']);
  });
  test('a non-array (null / object / string) → []', () => {
    assert.deepEqual(sanitizeDisabledFeeds(null), []);
    assert.deepEqual(sanitizeDisabledFeeds(undefined), []);
    assert.deepEqual(sanitizeDisabledFeeds({ getGuests: true } as unknown), []);
    assert.deepEqual(sanitizeDisabledFeeds('getGuests' as unknown), []);
  });
  test('non-string + blank entries are dropped, valid ones kept', () => {
    assert.deepEqual(
      sanitizeDisabledFeeds(['getGuests', 42, null, '  ', { x: 1 }, 'getWorkOrders'] as unknown).sort(),
      ['getGuests', 'getWorkOrders'],
    );
  });
});

describe('loadActiveDetailed surfaces disabledFeeds', () => {
  test('present → sanitized array on the LoadedKnowledgeFile', async () => {
    const row = makeActiveRow({ disabled_feeds: ['getGuests', 'getWorkOrders'] });
    const out = await withActiveStub(makeActiveStub(row), () => loadActiveDetailed(PMS_FAMILY));
    assert.ok(out.file);
    assert.deepEqual(out.file!.disabledFeeds.sort(), ['getGuests', 'getWorkOrders']);
  });

  test('missing column (legacy row) → []', async () => {
    const row = makeActiveRow();
    delete (row as Record<string, unknown>).disabled_feeds;
    const out = await withActiveStub(makeActiveStub(row), () => loadActiveDetailed(PMS_FAMILY));
    assert.ok(out.file);
    assert.deepEqual(out.file!.disabledFeeds, []);
  });

  test('junk entries (numbers/nulls/blanks) are dropped', async () => {
    const row = makeActiveRow({ disabled_feeds: ['getGuests', 7, null, '', 'getGuests'] });
    const out = await withActiveStub(makeActiveStub(row), () => loadActiveDetailed(PMS_FAMILY));
    assert.ok(out.file);
    assert.deepEqual(out.file!.disabledFeeds, ['getGuests']);
  });

  test('a non-array disabled_feeds value degrades to [] (never crashes the load)', async () => {
    const row = makeActiveRow({ disabled_feeds: { getGuests: true } });
    const out = await withActiveStub(makeActiveStub(row), () => loadActiveDetailed(PMS_FAMILY));
    assert.ok(out.file);
    assert.deepEqual(out.file!.disabledFeeds, []);
  });
});

describe('filterActionsForPolling — poll sweep excludes disabled feeds', () => {
  const ALL = ['getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders', 'getGuests'];

  test('excludes the disabled keys, keeps the rest (order preserved)', () => {
    const { kept, skipped } = filterActionsForPolling(ALL, ['getGuests', 'getWorkOrders']);
    assert.deepEqual(kept, ['getRoomStatus', 'getArrivals', 'getDepartures']);
    assert.deepEqual(skipped.sort(), ['getGuests', 'getWorkOrders']);
  });

  test('empty disabled set → every action kept, nothing skipped', () => {
    const { kept, skipped } = filterActionsForPolling(ALL, []);
    assert.deepEqual(kept, ALL);
    assert.deepEqual(skipped, []);
  });

  test('a disabled key not in the recipe is a harmless no-op (absent from both lists)', () => {
    const { kept, skipped } = filterActionsForPolling(ALL, ['getRatesAndInventory']);
    assert.deepEqual(kept, ALL);
    assert.deepEqual(skipped, []);
  });

  test('all feeds disabled → nothing kept (poll sweep runs no templates)', () => {
    const { kept, skipped } = filterActionsForPolling(ALL, ALL);
    assert.deepEqual(kept, []);
    assert.deepEqual(skipped.sort(), [...ALL].sort());
  });
});

describe('disabledFeedsEqual — hot-reload change detection (pure)', () => {
  test('same set (different order) → equal → NO reload', () => {
    assert.equal(disabledFeedsEqual(['getGuests', 'getWorkOrders'], ['getWorkOrders', 'getGuests']), true);
  });
  test('both empty → equal', () => {
    assert.equal(disabledFeedsEqual([], []), true);
  });
  test('a key added → not equal → reload', () => {
    assert.equal(disabledFeedsEqual(['getGuests'], ['getGuests', 'getWorkOrders']), false);
  });
  test('a key removed (capture re-enabled it) → not equal → reload', () => {
    assert.equal(disabledFeedsEqual(['getGuests', 'getWorkOrders'], ['getWorkOrders']), false);
  });
  test('duplicates collapse (same underlying set) → equal', () => {
    assert.equal(disabledFeedsEqual(['getGuests', 'getGuests'], ['getGuests']), true);
  });
});

// ─── autoEnableFeedOnCaptureSuccess — capture-success re-enable ───────────────
//
// Chains modelled:
//   SELECT: from().select('disabled_feeds').eq('pms_family').eq('status').is().maybeSingle()
//   UPDATE: from().update(patch).eq('pms_family').eq('status').is()
// The stub records the update patch + the filters so a test can assert the key
// was removed AND that only the active row was targeted.

interface AutoEnableState {
  row: { disabled_feeds: unknown } | null;  // the active row the SELECT finds (null = none)
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
  // captured:
  updatePatch?: Record<string, unknown> | null;
  updateFilters?: Array<[string, unknown]>;
  updateCount: number;
}

function makeAutoEnableStub(state: AutoEnableState): SupabaseClient {
  state.updateCount = 0;
  return {
    from(_t: string) {
      return {
        select(_cols?: string) {
          const chain: any = {
            eq(_c: string, _v: unknown) { return chain; },
            is(_c: string, _v: unknown) { return chain; },
            maybeSingle() {
              if (state.selectError) return Promise.resolve({ data: null, error: state.selectError });
              return Promise.resolve({ data: state.row, error: null });
            },
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          state.updateCount++;
          state.updatePatch = patch;
          state.updateFilters = [];
          const chain: any = {
            eq(c: string, v: unknown) { state.updateFilters!.push([c, v]); return terminal(); },
            is(c: string, v: unknown) { state.updateFilters!.push([c, v]); return terminal(); },
          };
          // The UPDATE chain is awaited directly (no .select()), so the LAST
          // filter call must resolve to the { error } envelope. Model it as a
          // thenable that also keeps chaining.
          function terminal(): any {
            return {
              eq(c: string, v: unknown) { state.updateFilters!.push([c, v]); return terminal(); },
              is(c: string, v: unknown) { state.updateFilters!.push([c, v]); return terminal(); },
              then(resolve: (r: { error: unknown }) => void) {
                resolve({ error: state.updateError ?? null });
              },
            };
          }
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe('autoEnableFeedOnCaptureSuccess — a successful Re-read re-enables the feed', () => {
  test('removes the key from the ACTIVE row and writes back the reduced array', async () => {
    const state: AutoEnableState = { row: { disabled_feeds: ['getGuests', 'getWorkOrders'] }, updateCount: 0 };
    await autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state));
    assert.equal(state.updateCount, 1);
    assert.deepEqual((state.updatePatch!.disabled_feeds as string[]).sort(), ['getWorkOrders']);
    // Only ever the family's live row: status='active' + pms_family guards on the UPDATE.
    const filters = new Map(state.updateFilters!.map(([c, v]) => [c, v]));
    assert.equal(filters.get('status'), 'active');
    assert.equal(filters.get('pms_family'), PMS_FAMILY);
  });

  test('idempotent — key already absent → no UPDATE at all', async () => {
    const state: AutoEnableState = { row: { disabled_feeds: ['getWorkOrders'] }, updateCount: 0 };
    await autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state));
    assert.equal(state.updateCount, 0);
    assert.equal(state.updatePatch, undefined);
  });

  test('no active row → no-op, no UPDATE, never throws', async () => {
    const state: AutoEnableState = { row: null, updateCount: 0 };
    await autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state));
    assert.equal(state.updateCount, 0);
  });

  test('empty disabled_feeds → nothing to remove, no UPDATE', async () => {
    const state: AutoEnableState = { row: { disabled_feeds: [] }, updateCount: 0 };
    await autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state));
    assert.equal(state.updateCount, 0);
  });

  test('removing the LAST disabled key writes an empty array (feed fully re-enabled)', async () => {
    const state: AutoEnableState = { row: { disabled_feeds: ['getGuests'] }, updateCount: 0 };
    await autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state));
    assert.equal(state.updateCount, 1);
    assert.deepEqual(state.updatePatch!.disabled_feeds, []);
  });

  test('a SELECT error → best-effort no-op (never throws, no UPDATE)', async () => {
    const state: AutoEnableState = { row: null, selectError: { message: 'boom' }, updateCount: 0 };
    await assert.doesNotReject(() => autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state)));
    assert.equal(state.updateCount, 0);
  });

  test('an UPDATE error → swallowed (never throws into the capture path)', async () => {
    const state: AutoEnableState = { row: { disabled_feeds: ['getGuests'] }, updateError: { message: 'write failed' }, updateCount: 0 };
    await assert.doesNotReject(() => autoEnableFeedOnCaptureSuccess(PMS_FAMILY, 'getGuests', makeAutoEnableStub(state)));
    assert.equal(state.updateCount, 1);
  });
});
