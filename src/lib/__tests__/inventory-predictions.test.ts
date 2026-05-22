/**
 * Regression tests for fetchMlPredictedRates.
 *
 * Pins the four observable behaviors the inventory UI relies on:
 *   1. Happy path — one active model + a fresh prediction → Map has the rate.
 *   2. No active models → empty Map, NEVER queries inventory_rate_predictions
 *      (avoids fetching stale rows from deactivated models).
 *   3. Network/exception path → empty Map (silent fall-through; caller
 *      still has the rule-based path).
 *   4. All returned prediction rows belong to inactive runs → empty Map
 *      (the active-model filter is doing real work, not a no-op).
 *
 * Honesty-audit Phase 1: locks the contract before Phase 2 changes
 * ai-status response shape, so a regression in this filter can't
 * silently let stale predictions feed the reorder list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMlPredictedRates } from '../inventory-predictions';

// ─── Mock client builder ──────────────────────────────────────────────────

type Row = Record<string, unknown>;
type TableResult = { data: Row[] | null; error?: { message: string } | null };
type TableHandler = (calls: BuilderCall[]) => TableResult;

interface BuilderCall {
  method: string;
  args: unknown[];
}

// Tracks which tables were queried so tests can assert "never queried X".
interface ClientLog {
  tablesQueried: string[];
  builderCalls: Record<string, BuilderCall[]>;
}

// Build a chainable mock that records every .eq/.gte/.order/.limit call,
// then resolves to whatever the per-table handler returns when awaited.
// fetchMlPredictedRates does:
//   await client.from('model_runs').select('id').eq().eq().eq()
//   await client.from('inventory_rate_predictions').select(...).eq().eq().gte().order().limit()
function makeMockClient(handlers: Record<string, TableHandler>): {
  client: { from: (table: string) => unknown };
  log: ClientLog;
} {
  const log: ClientLog = { tablesQueried: [], builderCalls: {} };

  function buildChain(table: string): unknown {
    const calls: BuilderCall[] = [];
    log.builderCalls[table] = calls;

    // Each builder method records the call and returns the same proxy.
    // When awaited, resolves to the handler's TableResult.
    const handler = handlers[table];
    if (!handler) {
      throw new Error(`Mock client: unexpected table "${table}"`);
    }

    const proxy = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (prop === 'then') {
          // Awaiting the chain resolves to the handler's result.
          const result = handler(calls);
          return (
            onFulfilled: (v: TableResult) => unknown,
            onRejected?: (e: unknown) => unknown,
          ): Promise<unknown> => {
            try {
              return Promise.resolve(result).then(onFulfilled, onRejected);
            } catch (err) {
              return Promise.reject(err);
            }
          };
        }
        if (prop === 'catch' || prop === 'finally') {
          return undefined;
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return proxy;
        };
      },
    });
    return proxy;
  }

  return {
    client: {
      from: (table: string) => {
        log.tablesQueried.push(table);
        return buildChain(table);
      },
    },
    log,
  };
}

const PID = '11111111-1111-1111-1111-111111111111';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('fetchMlPredictedRates', () => {
  it('returns rate when one active model has a fresh prediction (happy path)', async () => {
    const { client } = makeMockClient({
      model_runs: () => ({
        data: [{ id: 'mr-A' }],
        error: null,
      }),
      inventory_rate_predictions: () => ({
        data: [
          {
            item_id: 'item-1',
            predicted_daily_rate: 2.5,
            predicted_at: new Date().toISOString(),
            model_run_id: 'mr-A',
            is_shadow: false,
          },
        ],
        error: null,
      }),
    });
    const result = await fetchMlPredictedRates(PID, client as never);
    assert.equal(result.get('item-1'), 2.5);
    assert.equal(result.size, 1);
  });

  it('returns empty Map AND skips the predictions table when no active models', async () => {
    const { client, log } = makeMockClient({
      model_runs: () => ({ data: [], error: null }),
      inventory_rate_predictions: () => {
        throw new Error('should not be called when activeRunIds is empty');
      },
    });
    const result = await fetchMlPredictedRates(PID, client as never);
    assert.equal(result.size, 0);
    // Only model_runs queried — predictions short-circuited.
    assert.deepEqual(log.tablesQueried, ['model_runs']);
  });

  it('returns empty Map on network exception (silent fall-through)', async () => {
    const throwingClient = {
      from: () => {
        throw new Error('network down');
      },
    };
    const result = await fetchMlPredictedRates(PID, throwingClient as never);
    assert.equal(result.size, 0);
  });

  it('filters out predictions whose model_run is not active', async () => {
    // Active set: only mr-A. Predictions table returns rows for mr-A AND mr-X.
    // The filter must drop mr-X.
    const { client } = makeMockClient({
      model_runs: () => ({ data: [{ id: 'mr-A' }], error: null }),
      inventory_rate_predictions: () => ({
        data: [
          {
            item_id: 'item-from-inactive',
            predicted_daily_rate: 99.9,
            predicted_at: new Date().toISOString(),
            model_run_id: 'mr-X', // not in active set
            is_shadow: false,
          },
          {
            item_id: 'item-from-active',
            predicted_daily_rate: 3.0,
            predicted_at: new Date().toISOString(),
            model_run_id: 'mr-A',
            is_shadow: false,
          },
        ],
        error: null,
      }),
    });
    const result = await fetchMlPredictedRates(PID, client as never);
    assert.equal(result.get('item-from-active'), 3.0);
    assert.equal(result.has('item-from-inactive'), false);
    assert.equal(result.size, 1);
  });

  it('skips predictions that returned a query error', async () => {
    const { client } = makeMockClient({
      model_runs: () => ({ data: [{ id: 'mr-A' }], error: null }),
      inventory_rate_predictions: () => ({
        data: null,
        error: { message: 'rls' },
      }),
    });
    const result = await fetchMlPredictedRates(PID, client as never);
    assert.equal(result.size, 0);
  });

  it('takes the FIRST hit per item (most-recent ordering) when multiple rows match', async () => {
    // Two predictions for the same item; both from active model. The fetcher
    // orders predicted_at DESC and takes first hit per item — the newer one
    // (2.0) should win, NOT the older 99.9. This pins the ordering contract.
    const { client } = makeMockClient({
      model_runs: () => ({ data: [{ id: 'mr-A' }], error: null }),
      inventory_rate_predictions: () => ({
        data: [
          {
            item_id: 'item-1',
            predicted_daily_rate: 2.0,
            predicted_at: '2026-05-20T12:00:00Z',
            model_run_id: 'mr-A',
            is_shadow: false,
          },
          {
            item_id: 'item-1',
            predicted_daily_rate: 99.9,
            predicted_at: '2026-05-10T12:00:00Z', // older
            model_run_id: 'mr-A',
            is_shadow: false,
          },
        ],
        error: null,
      }),
    });
    const result = await fetchMlPredictedRates(PID, client as never);
    assert.equal(result.get('item-1'), 2.0);
  });

  it('drops non-finite or negative predicted rates', async () => {
    const { client } = makeMockClient({
      model_runs: () => ({ data: [{ id: 'mr-A' }], error: null }),
      inventory_rate_predictions: () => ({
        data: [
          {
            item_id: 'item-finite',
            predicted_daily_rate: 1.5,
            predicted_at: new Date().toISOString(),
            model_run_id: 'mr-A',
            is_shadow: false,
          },
          {
            item_id: 'item-nan',
            predicted_daily_rate: NaN,
            predicted_at: new Date().toISOString(),
            model_run_id: 'mr-A',
            is_shadow: false,
          },
          {
            item_id: 'item-negative',
            predicted_daily_rate: -2,
            predicted_at: new Date().toISOString(),
            model_run_id: 'mr-A',
            is_shadow: false,
          },
        ],
        error: null,
      }),
    });
    const result = await fetchMlPredictedRates(PID, client as never);
    assert.equal(result.size, 1);
    assert.equal(result.get('item-finite'), 1.5);
  });
});
