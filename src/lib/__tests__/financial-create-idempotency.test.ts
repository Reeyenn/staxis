import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  FinancialCreateConflictError,
  sameFinancialCreateFields,
  settleFinancialCreateInsert,
  type FinancialCreateDbResult,
} from '@/lib/financials/idempotent-create';

type Row = Record<string, unknown> & { id: string };

async function createInMemory(
  store: Map<string, Row>,
  row: Row,
  fields: readonly string[],
): Promise<{ row: Row; replayed: boolean }> {
  return settleFinancialCreateInsert({
    operationId: row.id,
    insert: async (): Promise<FinancialCreateDbResult<Row>> => {
      if (store.has(row.id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      store.set(row.id, { ...row });
      return { data: { ...row }, error: null };
    },
    lookup: async () => ({ data: store.get(row.id) ?? null, error: null }),
    matches: (existing) => sameFinancialCreateFields(existing, row, fields),
  });
}

describe('financial create exact retries', () => {
  const cases = [
    {
      label: 'expense',
      row: {
        id: '11111111-1111-4111-8111-111111111111',
        property_id: 'hotel-a',
        expense_date: '2026-07-28',
        amount_cents: 12345,
        vendor: 'Vendor',
      },
      fields: ['property_id', 'expense_date', 'amount_cents', 'vendor'],
    },
    {
      label: 'CapEx project',
      row: {
        id: '22222222-2222-4222-8222-222222222222',
        property_id: 'hotel-a',
        name: 'Replace roof',
        estimated_cost_cents: 5000000,
        submitted_by: 'account-a',
      },
      fields: ['property_id', 'name', 'estimated_cost_cents', 'submitted_by'],
    },
    {
      label: 'CapEx line item',
      row: {
        id: '33333333-3333-4333-8333-333333333333',
        property_id: 'hotel-a',
        capex_project_id: 'project-a',
        label: 'Deposit',
        amount_cents: 75000,
      },
      fields: ['property_id', 'capex_project_id', 'label', 'amount_cents'],
    },
  ] as const;

  for (const fixture of cases) {
    test(`${fixture.label}: commit + lost response + retry leaves one row`, async () => {
      const store = new Map<string, Row>();
      const first = await createInMemory(store, { ...fixture.row }, fixture.fields);
      assert.equal(first.replayed, false);

      // Pretend the first HTTP response was lost. The exact retry reaches the
      // primary-key collision path and resolves to the committed row.
      const retry = await createInMemory(store, { ...fixture.row }, fixture.fields);
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.row, fixture.row);
      assert.equal(store.size, 1);
    });
  }

  test('same operation UUID with changed financial data is a conflict', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const store = new Map<string, Row>();
    await createInMemory(store, {
      id,
      property_id: 'hotel-a',
      amount_cents: 1000,
    }, ['property_id', 'amount_cents']);

    await assert.rejects(
      () => createInMemory(store, {
        id,
        property_id: 'hotel-a',
        amount_cents: 2000,
      }, ['property_id', 'amount_cents']),
      FinancialCreateConflictError,
    );
    assert.equal(store.size, 1);
    assert.equal(store.get(id)?.amount_cents, 1000);
  });

  test('a failed duplicate verification never guesses success', async () => {
    const databaseError = { code: '08006', message: 'connection failure' };
    await assert.rejects(
      () => settleFinancialCreateInsert<Row>({
        operationId: '55555555-5555-4555-8555-555555555555',
        insert: async () => ({ data: null, error: { code: '23505' } }),
        lookup: async () => ({ data: null, error: databaseError }),
        matches: () => true,
      }),
      (error) => error === databaseError,
    );
  });
});

describe('financial create route and client contracts', () => {
  const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');
  const db = source('src', 'lib', 'financials', 'db.ts');
  const capexRoute = source('src', 'app', 'api', 'financials', 'capex', 'route.ts');
  const lineRoute = source('src', 'app', 'api', 'financials', 'capex', 'line-items', 'route.ts');
  const expenseRoute = source('src', 'app', 'api', 'financials', 'expenses', 'route.ts');
  const checkbook = source('src', 'app', 'financials', '_components', 'CheckbookTab.tsx');
  const requestModal = source('src', 'app', 'financials', '_components', 'CapexRequestModal.tsx');
  const detailModal = source('src', 'app', 'financials', '_components', 'CapexDetailModal.tsx');
  const finUi = source('src', 'app', 'financials', '_components', 'fin-ui.tsx');

  test('all three POST routes require and pass a UUID operationId', () => {
    for (const route of [capexRoute, lineRoute, expenseRoute]) {
      const post = route.slice(route.indexOf('export async function POST'), route.indexOf('export async function PATCH') === -1
        ? route.indexOf('export async function DELETE')
        : route.indexOf('export async function PATCH'));
      assert.match(post, /validateUuid\(body\.operationId, 'operationId'\)/);
      assert.match(post, /operationCheck\.value/);
      assert.match(post, /ApiErrorCode\.IdempotencyConflict/);
    }
  });

  test('the three inserts use the operation UUID as PK and verify 23505 replays', () => {
    assert.equal((db.match(/id: operationId/g) ?? []).length, 3);
    assert.equal((db.match(/settleFinancialCreateInsert\(\{/g) ?? []).length, 3);
    assert.match(db, /financial_expenses[\s\S]*?\.eq\('property_id', pid\)[\s\S]*?\.eq\('id', operationId\)/);
    assert.match(db, /capex_projects[\s\S]*?\.eq\('property_id', pid\)[\s\S]*?\.eq\('id', operationId\)/);
    assert.match(db, /capex_line_items[\s\S]*?\.eq\('property_id', pid\)[\s\S]*?\.eq\('capex_project_id', projectId\)[\s\S]*?\.eq\('id', operationId\)/);
  });

  test('each create UI reuses one operationId while the form remains open', () => {
    assert.match(checkbook, /operationId: newFinancialCreateOperationId\(\)/);
    assert.match(checkbook, /operationId: input\.draft\.id \? undefined : input\.draft\.operationId/);
    assert.match(requestModal, /operationId: newFinancialCreateOperationId\(\)/);
    assert.match(requestModal, /operationId: f\.operationId/);
    assert.match(requestModal, /operationId: l\.operationId/);
    assert.match(detailModal, /addLineOperationIdRef\.current \?\? newFinancialCreateOperationId\(\)/);
    assert.match(detailModal, /operationId,[\s\S]*?if \(res\.error\)/);
  });

  test('bounded finSend remains in place for retryable idempotent creates and existing writes', () => {
    assert.match(finUi, /timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS/);
  });
});
