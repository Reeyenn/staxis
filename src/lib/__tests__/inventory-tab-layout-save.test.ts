import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveOrderedInventoryTabLayout, type InventoryConfigRequest } from '@/lib/inventory-tab-layout-save';
import {
  inventoryTabLayoutStateFromStored,
  parseInventoryTabLayout,
} from '@/lib/inventory-tab-layout-ordering';
import { fromPropertyRow } from '@/lib/db-mappers';

const PID = '40200000-0000-4000-8000-000000000001';
const OP = '40200000-0000-4000-8000-00000000000a';
const OLD = { order: ['general', 'breakfast'], hidden: [] };
const NEXT = { order: ['breakfast', 'general'], hidden: [] };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ordered inventory tab-layout client protocol', () => {
  test('public parsers expose order/hidden while retaining revision only in the CAS state', () => {
    const stored = {
      ...NEXT,
      _staxis: { revision: 9, operationId: OP },
    };
    assert.deepEqual(parseInventoryTabLayout(stored), NEXT);
    assert.deepEqual(inventoryTabLayoutStateFromStored(stored), {
      tabLayout: NEXT,
      revision: 9,
    });
    assert.deepEqual(fromPropertyRow({ id: PID, inventory_tab_layout: stored }).inventoryTabLayout, NEXT);
    assert.deepEqual(Object.keys(parseInventoryTabLayout(stored) ?? {}).sort(), ['hidden', 'order']);
  });

  test('an ambiguous first attempt retries the exact operation and accepts replay', async () => {
    const posts: string[] = [];
    const request: InventoryConfigRequest = async (_url, init) => {
      posts.push(String(init?.body));
      if (posts.length === 1) throw new Error('deadline');
      return response({
        ok: true,
        data: {
          saved: true,
          status: 'replayed',
          operationId: OP,
          operationRevision: 1,
          revision: 1,
          tabLayout: NEXT,
        },
      });
    };

    const result = await saveOrderedInventoryTabLayout({
      request,
      propertyId: PID,
      tabLayout: NEXT,
      baselineLayout: OLD,
      expectedRevision: 0,
      operationId: OP,
      timeoutMs: 30_000,
    });
    assert.equal(result.kind, 'saved');
    assert.equal(posts.length, 2);
    assert.equal(posts[0], posts[1]);
    assert.deepEqual(JSON.parse(posts[0]), {
      pid: PID,
      tabLayout: NEXT,
      operationId: OP,
      expectedRevision: 0,
    });
  });

  test('a CAS conflict returns and preserves the authoritative layout', async () => {
    const request: InventoryConfigRequest = async () => response({
      ok: false,
      code: 'layout_revision_conflict',
      details: {
        status: 'revision_conflict',
        operationId: OP,
        revision: 4,
        tabLayout: OLD,
      },
    }, 409);
    const result = await saveOrderedInventoryTabLayout({
      request,
      propertyId: PID,
      tabLayout: NEXT,
      baselineLayout: OLD,
      expectedRevision: 3,
      operationId: OP,
      timeoutMs: 30_000,
    });
    assert.equal(result.kind, 'conflict');
    assert.deepEqual(result.state, { tabLayout: OLD, revision: 4 });
  });

  test('two ambiguous attempts require the exact receipt; layout equality alone is not success', async () => {
    let calls = 0;
    const request: InventoryConfigRequest = async (url) => {
      calls += 1;
      if (!url.includes('?')) throw new Error('network timeout');
      return response({
        ok: true,
        data: { tabLayout: NEXT, revision: 7, operation: null },
      });
    };
    const result = await saveOrderedInventoryTabLayout({
      request,
      propertyId: PID,
      tabLayout: NEXT,
      baselineLayout: OLD,
      expectedRevision: 6,
      operationId: OP,
      timeoutMs: 30_000,
    });
    assert.equal(calls, 3);
    assert.equal(result.kind, 'unconfirmed');
    assert.deepEqual(result.state, { tabLayout: NEXT, revision: 7 });
  });

  test('an exact current-actor layout-only receipt confirms an ambiguous operation', async () => {
    let calls = 0;
    const request: InventoryConfigRequest = async (url) => {
      calls += 1;
      if (!url.includes('?')) throw new Error('network timeout');
      return response({
        ok: true,
        data: {
          tabLayout: NEXT,
          revision: 1,
          operation: {
            operationId: OP,
            expectedRevision: 0,
            appliedRevision: 1,
            tabLayout: NEXT,
            budgetMode: null,
            actorMatches: true,
          },
        },
      });
    };
    const result = await saveOrderedInventoryTabLayout({
      request,
      propertyId: PID,
      tabLayout: NEXT,
      baselineLayout: OLD,
      expectedRevision: 0,
      operationId: OP,
      timeoutMs: 30_000,
    });
    assert.equal(calls, 3);
    assert.equal(result.kind, 'saved');
    assert.deepEqual(result.state, { tabLayout: NEXT, revision: 1 });
  });

  test('a receipt from a combined-budget operation or another actor is not exact', async () => {
    for (const receiptPatch of [
      { budgetMode: 'total' as const, actorMatches: true },
      { budgetMode: null, actorMatches: false },
    ]) {
      const request: InventoryConfigRequest = async (url) => {
        if (!url.includes('?')) throw new Error('network timeout');
        return response({
          ok: true,
          data: {
            tabLayout: NEXT,
            revision: 1,
            operation: {
              operationId: OP,
              expectedRevision: 0,
              appliedRevision: 1,
              tabLayout: NEXT,
              ...receiptPatch,
            },
          },
        });
      };
      const result = await saveOrderedInventoryTabLayout({
        request,
        propertyId: PID,
        tabLayout: NEXT,
        baselineLayout: OLD,
        expectedRevision: 0,
        operationId: OP,
        timeoutMs: 30_000,
      });
      assert.equal(result.kind, 'unconfirmed');
    }
  });

  test('a success-shaped response for another operation is never accepted', async () => {
    let calls = 0;
    const request: InventoryConfigRequest = async (url) => {
      calls += 1;
      if (url.includes('?')) {
        return response({
          ok: true,
          data: { tabLayout: OLD, revision: 0, operation: null },
        });
      }
      return response({
        ok: true,
        data: {
          saved: true,
          status: 'applied',
          operationId: '40200000-0000-4000-8000-00000000000f',
          operationRevision: 1,
          revision: 1,
          tabLayout: NEXT,
        },
      });
    };
    const result = await saveOrderedInventoryTabLayout({
      request,
      propertyId: PID,
      tabLayout: NEXT,
      baselineLayout: OLD,
      expectedRevision: 0,
      operationId: OP,
      timeoutMs: 30_000,
    });
    assert.equal(calls, 3);
    assert.equal(result.kind, 'unconfirmed');
    assert.deepEqual(result.state, { tabLayout: OLD, revision: 0 });
  });

  test('the first lazy revision read refuses to overwrite a newer public layout', async () => {
    let postCalled = false;
    const request: InventoryConfigRequest = async (url) => {
      if (!url.includes('?')) postCalled = true;
      return response({
        ok: true,
        data: { tabLayout: NEXT, revision: 2, operation: null },
      });
    };
    const result = await saveOrderedInventoryTabLayout({
      request,
      propertyId: PID,
      tabLayout: OLD,
      baselineLayout: OLD,
      expectedRevision: null,
      operationId: OP,
      timeoutMs: 30_000,
    });
    assert.equal(result.kind, 'conflict');
    assert.equal(postCalled, false);
    assert.deepEqual(result.state, { tabLayout: NEXT, revision: 2 });
  });

  test('migration and route keep CAS, row lock, bounded DB work, and private metadata contracts', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0404_inventory_tab_layout_ordered_writes.sql'),
      'utf8',
    );
    assert.match(sql, /p_operation_id uuid/i);
    assert.match(sql, /p_expected_revision bigint/i);
    assert.match(sql, /for update/i);
    assert.match(sql, /set lock_timeout = '4s'/i);
    assert.match(sql, /set statement_timeout = '8s'/i);
    assert.match(sql, /db-hoisted-tx-settings includes statement_timeout/i);
    assert.match(sql, /notify pgrst, 'reload config'/i);
    assert.match(sql, /v_existing\.requested_layout = v_requested_layout/i);
    assert.match(sql, /v_existing\.requested_budget_mode is not distinct from p_budget_mode/i);
    assert.match(sql, /v_existing\.actor_id = p_actor_id/i);
    assert.match(sql, /p_expected_revision <> v_current_revision/i);
    assert.match(sql, /'_staxis'/i);
    assert.match(sql, /p_tab_layout is not null[\s\S]*requires ordered operation contract/i);

    const route = readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'inventory', 'property-config', 'route.ts'),
      'utf8',
    );
    assert.match(route, /staxis_write_inventory_tab_layout_ordered/);
    assert.match(route, /p_operation_id: operationId\.value/);
    assert.match(route, /p_expected_revision: body\.expectedRevision/);
    assert.match(route, /abortSignal\(AbortSignal\.timeout\(ORDERED_LAYOUT_RPC_HTTP_TIMEOUT_MS\)\)/);
    assert.match(route, /inventoryTabLayoutStateFromStored/);
    assert.match(route, /\.eq\('operation_id', operationId\.value/);
    assert.match(route, /\.eq\('property_id', pid\)/);

    const shell = readFileSync(
      join(process.cwd(), 'src', 'app', 'inventory', '_components', 'InventoryShell.tsx'),
      'utf8',
    );
    assert.match(shell, /layoutSaveGenerationRef\.current \+= 1/);
    assert.match(shell, /layoutSaveChainRef\.current = Promise\.resolve\(\)/);
    assert.match(shell, /outcome\.kind === 'unconfirmed'/);
  });
});
