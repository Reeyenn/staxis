/**
 * scraper/__tests__/ooo-cakeys-preservation.test.js
 *
 * Run via: node --test scraper/__tests__/ooo-cakeys-preservation.test.js
 *
 * F5 reframe — the contract this test pins:
 *
 *   A work order that CA still considers active but whose payload fails
 *   our per-row validation MUST NOT be marked "resolved" in our table.
 *
 * In v1 of the master plan we proposed Zod-then-skip, which would have
 * silently auto-resolved any active OOO block whose payload happened to
 * fail validation. Codex caught this in adversarial review. The fix is
 * to build the caKeys set from raw CA payload BEFORE per-row validation,
 * so reconciliation only resolves work orders that genuinely disappeared
 * from CA's response.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { reconcileOOO } = require('../ooo-pull');

// Minimal Supabase fake — captures every .update / .insert call so the
// assertions can check what reconcileOOO actually wrote.
function makeFakeSupabase(existingRows = []) {
  const calls = { update: [], insert: [] };
  const fake = {
    from(table) {
      assert.equal(table, 'work_orders');
      return {
        select() { return this; },
        eq(_col, _val) { return this; },
        async then(resolve) {
          resolve({ data: existingRows, error: null });
        },
        update(payload) {
          const op = { payload, where: {} };
          calls.update.push(op);
          return {
            eq(col, val) {
              op.where[col] = val;
              return { error: null };
            },
          };
        },
        insert(payload) {
          calls.insert.push({ payload });
          return { error: null };
        },
      };
    },
  };
  // The select chain above returns this via thenable, but reconcileOOO
  // awaits .select(...).eq().eq(). We need .eq() to also be thenable in
  // the select path. Simpler: rebuild as a proper chain.
  fake.from = (table) => {
    assert.equal(table, 'work_orders');
    return new FakeBuilder(table, existingRows, calls);
  };
  return { fake, calls };
}

class FakeBuilder {
  constructor(table, existing, calls) {
    this.table = table;
    this.existing = existing;
    this.calls = calls;
    this._mode = null;
    this._updatePayload = null;
    this._insertPayload = null;
    this._whereClauses = {};
  }
  select() { this._mode = 'select'; return this; }
  update(payload) { this._mode = 'update'; this._updatePayload = payload; return this; }
  insert(payload) {
    this._insertPayload = payload;
    this.calls.insert.push({ payload });
    return Promise.resolve({ error: null });
  }
  eq(col, val) {
    this._whereClauses[col] = val;
    if (this._mode === 'update') {
      // .eq() is the terminator on update — fire the captured payload.
      this.calls.update.push({
        payload: this._updatePayload,
        where: { ...this._whereClauses },
      });
      return Promise.resolve({ error: null });
    }
    return this;
  }
  // Make the SELECT chain thenable so `await supabase.from().select().eq().eq()` works.
  then(resolve) {
    if (this._mode === 'select') {
      resolve({ data: this.existing, error: null });
    } else {
      resolve({ error: null });
    }
  }
}

function workOrder(overrides) {
  return {
    workOrderNumber: '5001',
    roomNumber: '101',
    reason: 'AC out',
    fromDate: '04/26/2026',
    toDate: '04/28/2026',
    notes: '',
    openingClerk: 'manager',
    ...overrides,
  };
}

describe('reconcileOOO — caKeys built BEFORE validation', () => {
  test('malformed-but-present CA work order is NOT auto-resolved', async () => {
    // Pre-state: work_order 5001 is currently OPEN in our table.
    const existing = [
      { id: 'wo-uuid-5001', status: 'submitted', ca_work_order_number: '5001' },
    ];
    // CA still lists 5001 — but with a garbage room number.
    const caList = [
      workOrder({ workOrderNumber: '5001', roomNumber: 'GARBAGE' }),
    ];

    const supabase = { from: (t) => new FakeBuilder(t, existing, { update: [], insert: [] }) };
    // Need a real call accumulator; rebuild more carefully.
    const calls = { update: [], insert: [] };
    const realSupabase = { from: (t) => new FakeBuilder(t, existing, calls) };

    const stats = await reconcileOOO(realSupabase, { PROPERTY_ID: 'pid' }, caList, () => {});

    assert.equal(stats.invalidPayloadCount, 1, 'malformed row was counted');
    assert.equal(stats.resolved, 0, 'open work order MUST NOT be auto-resolved');
    // No update with status:'resolved' should have fired.
    const resolveCalls = calls.update.filter(u => u.payload && u.payload.status === 'resolved');
    assert.equal(resolveCalls.length, 0);
    assert.deepEqual(stats.invalidPayloadKeys, ['5001']);
  });

  test('work order genuinely removed from CA gets auto-resolved (positive case)', async () => {
    const existing = [
      { id: 'wo-uuid-5001', status: 'submitted', ca_work_order_number: '5001' },
      { id: 'wo-uuid-5002', status: 'in_progress', ca_work_order_number: '5002' },
    ];
    // CA only lists 5001 now — 5002 has been removed.
    const caList = [
      workOrder({ workOrderNumber: '5001', roomNumber: '101' }),
    ];

    const calls = { update: [], insert: [] };
    const realSupabase = { from: (t) => new FakeBuilder(t, existing, calls) };

    const stats = await reconcileOOO(realSupabase, { PROPERTY_ID: 'pid' }, caList, () => {});

    assert.equal(stats.resolved, 1, '5002 disappeared from CA, must resolve');
    assert.equal(stats.invalidPayloadCount, 0);
    const resolveCalls = calls.update.filter(u => u.payload && u.payload.status === 'resolved');
    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].where.id, 'wo-uuid-5002');
  });

  test('completely-empty workOrderNumber rows do not pollute caKeys', async () => {
    const existing = [
      { id: 'wo-uuid-5001', status: 'submitted', ca_work_order_number: '5001' },
    ];
    // CA returns one valid row + one garbage row with no workOrderNumber.
    // Valid row "5001" exists → no resolves. Empty-key row is just skipped.
    const caList = [
      workOrder({ workOrderNumber: '5001', roomNumber: '101' }),
      workOrder({ workOrderNumber: '', roomNumber: '102' }),
    ];

    const calls = { update: [], insert: [] };
    const realSupabase = { from: (t) => new FakeBuilder(t, existing, calls) };

    const stats = await reconcileOOO(realSupabase, { PROPERTY_ID: 'pid' }, caList, () => {});

    assert.equal(stats.resolved, 0);
    assert.equal(stats.invalidPayloadCount, 0, 'empty-key rows are NOT counted as malformed');
  });

  test('open-ended OOO (null toDate) is treated as valid', async () => {
    const existing = [];
    const caList = [
      workOrder({ workOrderNumber: '5001', roomNumber: '101', fromDate: '04/26/2026', toDate: null }),
    ];

    const calls = { update: [], insert: [] };
    const realSupabase = { from: (t) => new FakeBuilder(t, existing, calls) };

    const stats = await reconcileOOO(realSupabase, { PROPERTY_ID: 'pid' }, caList, () => {});

    assert.equal(stats.created, 1, 'null toDate is legitimate — write through');
    assert.equal(stats.invalidPayloadCount, 0);
  });

  test('caps invalidPayloadKeys at 20 entries (prevents JSON bloat)', async () => {
    const existing = [];
    const caList = Array.from({ length: 30 }, (_, i) =>
      workOrder({ workOrderNumber: `bad-${i}`, roomNumber: 'GARBAGE' })
    );

    const calls = { update: [], insert: [] };
    const realSupabase = { from: (t) => new FakeBuilder(t, existing, calls) };

    const stats = await reconcileOOO(realSupabase, { PROPERTY_ID: 'pid' }, caList, () => {});

    assert.equal(stats.invalidPayloadCount, 30);
    assert.equal(stats.invalidPayloadKeys.length, 20, 'capped at 20');
  });
});
