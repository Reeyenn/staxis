/**
 * The two anon-client writes that used to succeed while writing nothing.
 *
 * `staff` and `cleaning_events` RLS is row-level. An UPDATE that RLS filters
 * down to zero rows is NOT an error in PostgREST: it comes back 200 with
 * `error: null` and an empty result, so a helper that only checks `error`
 * resolves cleanly and the UI reports success over a database that never
 * changed. This is the repo's #1 recurring bug class, and both of these
 * helpers sit directly behind a success toast:
 *
 *   • decideOnFlaggedEvent → QualityTab optimistically drops the flagged row
 *     and says "Kept. Counts toward averages."
 *   • updateStaffMember    → the employment card says "Employment details
 *     saved. The roster is up to date."
 *
 * These tests drive the real helpers against a stubbed anon client and assert
 * the only thing that matters: zero rows rejects, one row resolves. They would
 * fail if anyone dropped the `.select()` or the row-count check.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabase } from '@/lib/supabase';
import { decideOnFlaggedEvent } from '@/lib/db/cleaning-events';
import { updateStaffMember } from '@/lib/db/staff';

type FromFn = typeof supabase.from;
const originalFrom: FromFn = supabase.from.bind(supabase);

interface UpdateResult {
  data: Array<{ id: string }> | null;
  error: { message: string } | null;
}

/** What the stubbed client will answer, and what it was actually asked. */
const state: {
  result: UpdateResult;
  selectedColumns: string[];
  updatedPayloads: Record<string, unknown>[];
} = {
  result: { data: [{ id: 'row-1' }], error: null },
  selectedColumns: [],
  updatedPayloads: [],
};

/**
 * Minimal PostgREST update-builder stub. Every `.eq()` returns itself so the
 * helpers can chain as many filters as they like; the chain is thenable so
 * `await` on it (no `.select()`) resolves too, exactly like the real client.
 */
function updateBuilder() {
  const settle = () => Promise.resolve(state.result);
  const builder: Record<string, unknown> = {
    eq: () => builder,
    select: (columns: string) => {
      state.selectedColumns.push(columns);
      return settle();
    },
    then: (resolve: (value: UpdateResult) => unknown, reject?: (reason: unknown) => unknown) =>
      settle().then(resolve, reject),
  };
  return builder;
}

beforeEach(() => {
  state.result = { data: [{ id: 'row-1' }], error: null };
  state.selectedColumns = [];
  state.updatedPayloads = [];
  // @ts-expect-error monkey-patch of the anon client for this file only
  supabase.from = () => ({
    update: (payload: Record<string, unknown>) => {
      state.updatedPayloads.push(payload);
      return updateBuilder();
    },
  });
});

afterEach(() => {
  supabase.from = originalFrom;
});

describe('decideOnFlaggedEvent', () => {
  test('a decision that changed one row resolves', async () => {
    state.result = { data: [{ id: 'event-1' }], error: null };
    await decideOnFlaggedEvent('event-1', 'approved', 'reviewer-1');
    // It must ask for the row back, otherwise zero rows is invisible.
    assert.ok(state.selectedColumns.length > 0, 'the update must request the affected row');
  });

  test('a decision that changed NOTHING rejects instead of reading as saved', async () => {
    state.result = { data: [], error: null };
    await assert.rejects(
      () => decideOnFlaggedEvent('event-1', 'approved', 'reviewer-1'),
      /not saved/i,
    );
  });

  test('a null result set rejects too', async () => {
    state.result = { data: null, error: null };
    await assert.rejects(() => decideOnFlaggedEvent('event-1', 'rejected', 'reviewer-1'));
  });

  test('a real database error still rejects', async () => {
    state.result = { data: null, error: { message: 'boom' } };
    await assert.rejects(() => decideOnFlaggedEvent('event-1', 'approved', 'reviewer-1'));
  });

  test('records the reviewer and the decision on the row it writes', async () => {
    await decideOnFlaggedEvent('event-1', 'rejected', 'reviewer-9');
    const payload = state.updatedPayloads.at(-1) ?? {};
    assert.equal(payload.status, 'rejected');
    assert.equal(payload.reviewed_by, 'reviewer-9');
    assert.equal(typeof payload.reviewed_at, 'string');
  });
});

describe('updateStaffMember', () => {
  test('an update that changed one row resolves', async () => {
    state.result = { data: [{ id: 'staff-1' }], error: null };
    await updateStaffMember('uid', 'hotel-1', 'staff-1', { name: 'Maria Lopez' });
    assert.ok(state.selectedColumns.length > 0, 'the update must request the affected row');
  });

  test('an update that matched no rows rejects instead of reading as saved', async () => {
    state.result = { data: [], error: null };
    await assert.rejects(
      () => updateStaffMember('uid', 'hotel-1', 'staff-1', { name: 'Maria Lopez' }),
      /Nothing was saved/i,
    );
  });

  test('a real database error still rejects', async () => {
    state.result = { data: null, error: { message: 'boom' } };
    await assert.rejects(
      () => updateStaffMember('uid', 'hotel-1', 'staff-1', { name: 'Maria Lopez' }),
    );
  });

  test('still refuses to carry phone or wage over the anon client', async () => {
    // The privacy guard predates this change and must survive it: `staff` RLS
    // cannot restrict a column, so neither field may travel here.
    await updateStaffMember('uid', 'hotel-1', 'staff-1', {
      name: 'Maria Lopez',
      phone: '(409) 555-1234',
      hourlyWage: 15,
    } as Parameters<typeof updateStaffMember>[3]);
    const payload = state.updatedPayloads.at(-1) ?? {};
    assert.equal('phone' in payload, false);
    assert.equal('hourly_wage' in payload, false);
    assert.equal(payload.name, 'Maria Lopez');
  });
});
