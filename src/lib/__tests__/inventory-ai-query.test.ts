process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  fetchInventoryAiRows,
  inventoryAiUnavailableResponse,
  InventoryAiDependencyError,
  requireInventoryAiResult,
} from '@/lib/inventory-ai-query';

describe('inventory AI dependency reads', () => {
  test('pages beyond PostgREST\'s 1,000-row cap without dropping rows', async () => {
    const source = Array.from({ length: 1_505 }, (_, id) => ({ id }));
    const ranges: Array<[number, number]> = [];
    const rows = await fetchInventoryAiRows(
      'large history',
      async (from, to) => {
        ranges.push([from, to]);
        return { data: source.slice(from, to + 1), error: null };
      },
      5_000,
    );

    assert.equal(rows.length, source.length);
    assert.deepEqual(rows.map((row) => row.id), source.map((row) => row.id));
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
  });

  test('throws when a cap-plus-one sentinel proves the dependency was truncated', async () => {
    const source = Array.from({ length: 2_501 }, (_, id) => ({ id }));
    const ranges: Array<[number, number]> = [];

    await assert.rejects(
      fetchInventoryAiRows(
        'capped history',
        async (from, to) => {
          ranges.push([from, to]);
          return { data: source.slice(from, to + 1), error: null };
        },
        2_500,
      ),
      (error: unknown) => error instanceof InventoryAiDependencyError
        && error.dependency === 'capped history',
    );
    assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2500]]);
  });

  test('dependency failures throw instead of becoming an honest-looking empty result', async () => {
    assert.throws(
      () => requireInventoryAiResult('model runs', { data: null, error: new Error('offline') }),
      (error: unknown) => error instanceof InventoryAiDependencyError
        && error.dependency === 'model runs',
    );
    await assert.rejects(
      fetchInventoryAiRows(
        'prediction history',
        async () => ({ data: null, error: new Error('offline') }),
        2_000,
      ),
      (error: unknown) => error instanceof InventoryAiDependencyError
        && error.dependency === 'prediction history',
    );
  });

  test('route failure response is retryable and machine-stable', async () => {
    const response = inventoryAiUnavailableResponse('inventory-ai-test');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '5');
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.code, 'upstream_failure');
  });

  test('both routes use paged dependencies and fail through the 503 response', () => {
    for (const name of ['ai-report', 'ai-status']) {
      const route = readFileSync(join(
        process.cwd(), 'src', 'app', 'api', 'inventory', name, 'route.ts',
      ), 'utf8');
      assert.match(route, /fetchInventoryAiRows/);
      assert.match(route, /inventoryAiUnavailableResponse\(requestId\)/);
      assert.doesNotMatch(route, /\.limit\((?:4000|50000|100000)\)/);
      assert.match(route, /\.order\('id', \{ ascending: (?:true|false) \}\)[\s\S]*?\.range\(from, to\)/);
    }
    const report = readFileSync(join(
      process.cwd(), 'src', 'app', 'api', 'inventory', 'ai-report', 'route.ts',
    ), 'utf8');
    assert.match(report, /requireInventoryAiResult\('prediction count lookup', countLookupRes\)/);
  });
});
