// fetchAllRows — the guard against PostgREST's silent 1000-row response cap.
// The bug class this prevents: a .limit(2000) query that returns exactly 1000
// rows with no error, silently halving count history / money totals.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchAllRows, SUPABASE_PAGE_SIZE } from '../supabase-paginate';

// Simulates PostgREST: serves rows[from..to] but never more than `cap` per
// response, mirroring the server-side db-max-rows behavior.
function fakeServer(totalRows: number, cap = SUPABASE_PAGE_SIZE) {
  const calls: Array<[number, number]> = [];
  const makePage = (from: number, to: number) => {
    calls.push([from, to]);
    const requested = Math.min(to, totalRows - 1) - from + 1;
    const served = Math.max(0, Math.min(requested, cap));
    const data = Array.from({ length: served }, (_, i) => ({ n: from + i }));
    return Promise.resolve({ data, error: null });
  };
  return { makePage, calls };
}

describe('fetchAllRows', () => {
  test('assembles multiple full pages plus the short tail', async () => {
    const { makePage, calls } = fakeServer(2345);
    const rows = await fetchAllRows(makePage);
    assert.equal(rows.length, 2345);
    assert.equal((rows[2344] as { n: number }).n, 2344); // contiguous, in order
    assert.equal(calls.length, 3); // 1000 + 1000 + 345
  });

  test('a dataset under one page makes exactly one request', async () => {
    const { makePage, calls } = fakeServer(7);
    const rows = await fetchAllRows(makePage);
    assert.equal(rows.length, 7);
    assert.equal(calls.length, 1);
  });

  test('an exact page-boundary dataset terminates on the empty follow-up page', async () => {
    const { makePage } = fakeServer(SUPABASE_PAGE_SIZE);
    const rows = await fetchAllRows(makePage);
    assert.equal(rows.length, SUPABASE_PAGE_SIZE);
  });

  test('maxRows truncates the final page request', async () => {
    const { makePage, calls } = fakeServer(5000);
    const rows = await fetchAllRows(makePage, { maxRows: 2500 });
    assert.equal(rows.length, 2500);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], [2000, 2499]); // last page asks only for the remainder
  });

  test('zero rows returns an empty array from one request', async () => {
    const { makePage, calls } = fakeServer(0);
    const rows = await fetchAllRows(makePage);
    assert.equal(rows.length, 0);
    assert.equal(calls.length, 1);
  });

  test('a page error rejects instead of returning partial data', async () => {
    await assert.rejects(
      fetchAllRows(() => Promise.resolve({ data: null, error: new Error('boom') })),
      /boom/,
    );
  });
});
