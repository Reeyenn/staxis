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
import { PROPERTY_COLS, fromPropertyRow } from '@/lib/db-mappers';
import { callerManagesProperty, validateWage } from '@/lib/staff-wages';

const PID_A = '11111111-1111-1111-1111-111111111111';
const PID_B = '22222222-2222-2222-2222-222222222222';

/**
 * Does this column or field name carry money?
 *
 * Catches the legacy dollar column, the integer-cents mirror migration 0463
 * added beside it, and any future sibling — while leaving alone the names that
 * merely contain a money word without holding a number, e.g.
 * `inventory_budget_mode`, which is an enum of how the budget screen is laid
 * out. Case- and separator-insensitive so it reads the same list whether the
 * name arrived as `weekly_budget` or `weeklyBudget`.
 */
function isPayName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z]/g, '');
  if (flat.includes('wage') || flat.includes('salary') || flat.includes('payrate')) return true;
  return /(budget|cost)(cents)?$/.test(flat);
}

function payColumnsIn(selectList: string): string[] {
  return selectList
    .split(',')
    .map((c) => c.trim())
    .filter(isPayName);
}

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

  test('names no pay column at all, including the 0463 cents mirror', () => {
    // 0463 added `staff.hourly_wage_cents` beside `hourly_wage`. A guard that
    // only knows the dollar name would wave the mirror straight through.
    assert.deepEqual(payColumnsIn(STAFF_COLS), []);
  });

  test('still includes the columns the directory needs', () => {
    const cols = STAFF_COLS.split(',').map(c => c.trim());
    for (const needed of ['id', 'name', 'department', 'is_active']) {
      assert.ok(cols.includes(needed), `STAFF_COLS should still include ${needed}`);
    }
  });
});

/**
 * The app-shell hotel payload (2026-08-07).
 *
 * `GET /api/properties` reads `PROPERTY_COLS` with service-role and hands the
 * rows to everyone who can open the hotel — housekeeper, front desk,
 * maintenance, company finance. That is deliberate (the tenant wall there is
 * coverage, not role) and it runs no `view_wages` check. So the select list IS
 * the disclosure list: it shipped `hourly_wage` (the hotel's default
 * housekeeper rate) and `weekly_budget` (its weekly labor budget) to every
 * signed-in person, in the JSON they receive on sign-in, with no capability
 * anywhere in the path. Nothing rendered either one.
 */
describe('PROPERTY_COLS — the app-shell hotel projection', () => {
  test('names no pay column, dollars or the 0463 cents mirrors', () => {
    assert.deepEqual(
      payColumnsIn(PROPERTY_COLS),
      [],
      'every column here reaches a housekeeper; pay belongs behind view_wages',
    );
  });

  test('still carries what the shell actually runs on', () => {
    const cols = PROPERTY_COLS.split(',').map((c) => c.trim());
    for (const needed of ['id', 'name', 'total_rooms', 'timezone', 'enabled_sections']) {
      assert.ok(cols.includes(needed), `PROPERTY_COLS should still include ${needed}`);
    }
  });

  test('a row that still holds pay columns maps to a hotel with no pay on it', () => {
    // Belt and braces for the read side: even if a row arrives carrying money
    // (a wider select somewhere, a service-role caller reusing the mapper), the
    // object the browser gets must not carry it forward.
    const mapped = fromPropertyRow({
      id: PID_A,
      name: 'Comfort Suites',
      total_rooms: 74,
      hourly_wage: 17.5,
      hourly_wage_cents: 1750,
      weekly_budget: 4200,
      weekly_budget_cents: 420000,
    }) as unknown as Record<string, unknown>;

    const leaked = Object.keys(mapped).filter(isPayName);
    assert.deepEqual(leaked, [], `hotel object leaked pay fields: ${leaked.join(', ')}`);
    assert.equal(
      Object.values(mapped).includes(17.5),
      false,
      'the wage value itself must not survive under a different key',
    );
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
