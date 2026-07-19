/**
 * Staff wage privacy fix (2026-05-31).
 *
 * Pins the contract that closes a real payroll leak: `staff.hourly_wage` was
 * readable AND writable by every authenticated property user through the anon
 * Supabase client, because `staff` RLS is row-level only ("owner rw staff",
 * migration 0001) and Postgres RLS can't restrict a single column.
 *
 * Three guards:
 *   1. The anon read projection (STAFF_COLS) must NOT list hourly_wage — this
 *      is the read leak. If someone re-adds it, this test goes red.
 *   2. The wage route's authorization predicate (callerManagesProperty) only
 *      lets admins / wildcard / explicit-access callers touch a property.
 *   3. validateWage rejects junk / negatives / absurd values and clamps to
 *      cents; null clears the wage.
 *
 * The HTTP handlers themselves (GET/PUT) are guarded by requireSession +
 * canManageTeam + the staff-belongs-to-property IDOR check; exercising those
 * end-to-end would mean mocking requireSession + supabaseAdmin (the same
 * "out of scope" call the agent-speak route test makes). The compile-time
 * binding plus these unit tests cover the logic that matters.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { STAFF_COLS } from '@/lib/db/staff';
import { callerManagesProperty, validateWage } from '@/lib/staff-wages';

const PID_A = '11111111-1111-1111-1111-111111111111';
const PID_B = '22222222-2222-2222-2222-222222222222';

describe('STAFF_COLS anon projection', () => {
  test('does NOT include hourly_wage (the read leak)', () => {
    // Match on a word boundary so a future "hourly_wage_cents" wouldn't give
    // a false pass, and a re-added "hourly_wage" can't hide behind a substring.
    const cols = STAFF_COLS.split(',').map(c => c.trim());
    assert.ok(
      !cols.includes('hourly_wage'),
      `STAFF_COLS must not expose hourly_wage over the anon client; got: ${STAFF_COLS}`,
    );
  });

  test('still includes the columns the directory needs', () => {
    const cols = STAFF_COLS.split(',').map(c => c.trim());
    for (const needed of ['id', 'name', 'department', 'is_active']) {
      assert.ok(cols.includes(needed), `STAFF_COLS should still include ${needed}`);
    }
  });
});

describe('callerManagesProperty', () => {
  test('admin manages any property', () => {
    assert.equal(callerManagesProperty({ role: 'admin', propertyAccess: [] }, PID_A), true);
  });
  test('wildcard access manages any property', () => {
    assert.equal(callerManagesProperty({ role: 'owner', propertyAccess: ['*'] }, PID_A), true);
  });
  test('explicit access to the property is allowed', () => {
    assert.equal(callerManagesProperty({ role: 'general_manager', propertyAccess: [PID_A] }, PID_A), true);
  });
  test('no access to the property is denied (cross-property)', () => {
    assert.equal(callerManagesProperty({ role: 'general_manager', propertyAccess: [PID_B] }, PID_A), false);
  });
  test('empty access is denied for non-admins', () => {
    assert.equal(callerManagesProperty({ role: 'owner', propertyAccess: [] }, PID_A), false);
  });
});

describe('validateWage', () => {
  test('null / undefined clears the wage', () => {
    assert.deepEqual(validateWage(null), { value: null });
    assert.deepEqual(validateWage(undefined), { value: null });
  });
  test('accepts a plain number, rounded to cents', () => {
    assert.deepEqual(validateWage(15), { value: 15 });
    assert.deepEqual(validateWage(15.5), { value: 15.5 });
    assert.deepEqual(validateWage(15.009), { value: 15.01 });
  });
  test('accepts a numeric string', () => {
    assert.deepEqual(validateWage('18.25'), { value: 18.25 });
  });
  test('rejects negatives', () => {
    assert.ok(validateWage(-1).error);
  });
  test('rejects absurd values over the cap', () => {
    assert.ok(validateWage(10001).error);
  });
  test('rejects non-numeric junk', () => {
    assert.ok(validateWage('abc').error);
    assert.ok(validateWage('').error);
    assert.ok(validateWage({}).error);
    assert.ok(validateWage(NaN).error);
  });
});
