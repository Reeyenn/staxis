/**
 * Service-layer tests for the sick-callout coverage flow.
 *
 * Run via: npx tsx --test src/lib/__tests__/sick-callout-service.test.ts
 *
 * Uses an in-memory mock of the SupabaseClient surface that the service
 * actually touches (insert/select/update on callout_events, cleaning_tasks,
 * and staff). The mock implements just enough of the query-builder
 * chaining for the service's calls to round-trip — adding more methods is
 * a few lines if a future test needs them.
 *
 * Why a mock and not a real Supabase: these tests need to run in <1s in
 * CI; spinning up a Postgres for each test would be slower and harder to
 * keep deterministic. The pure-function tests in sick-callout-redistribute-policy
 * cover the hard correctness cases; this file just verifies that the
 * service correctly wires those decisions to the right DB updates.
 */

import { test, describe, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createCallout,
  runRedistributionForCallout,
  revertCallout,
  listActiveCalloutsForBanner,
  hasActiveCalloutToday,
} from '../sick-callout/service';
import type { CalloutEvent } from '../sick-callout/types';

// ───────────────────────────────────────────────────────────────────────
// MOCK SUPABASE
// ───────────────────────────────────────────────────────────────────────

interface MockRow {
  [k: string]: unknown;
}

interface MockTable {
  rows: MockRow[];
  // Partial unique indexes — keyed by a function generating the key string
  uniqueIndexes?: Array<(row: MockRow) => string | null>;
}

class MockDB {
  private tables: Record<string, MockTable> = {};

  constructor() {
    this.tables.callout_events = {
      rows: [],
      uniqueIndexes: [
        // mirror of the partial unique index in the migration
        (r) => (r.status === 'active' ? `${r.staff_id}|${r.business_date}` : null),
      ],
    };
    this.tables.cleaning_tasks = { rows: [] };
    this.tables.staff = { rows: [] };
    this.tables.hk_assignments = { rows: [] };
  }

  seed(tableName: string, rows: MockRow[]): void {
    if (!this.tables[tableName]) this.tables[tableName] = { rows: [] };
    this.tables[tableName].rows = JSON.parse(JSON.stringify(rows));
  }

  all(tableName: string): MockRow[] {
    return this.tables[tableName]?.rows ?? [];
  }

  from(tableName: string): MockQuery {
    if (!this.tables[tableName]) this.tables[tableName] = { rows: [] };
    return new MockQuery(this.tables[tableName], tableName);
  }
}

type Filter = (r: MockRow) => boolean;

class MockQuery {
  private filters: Filter[] = [];
  private table: MockTable;
  private tableName: string;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: MockRow | null = null;
  private bulkPayload: MockRow[] | null = null;
  private updatePayload: MockRow | null = null;
  private limitN: number | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;

  constructor(table: MockTable, tableName: string) {
    this.table = table;
    this.tableName = tableName;
  }

  select(_cols?: string): MockQuery { return this; }
  insert(row: MockRow | MockRow[]): MockQuery {
    this.op = 'insert';
    // Support both single-row and array inserts (supabase JS accepts both).
    this.bulkPayload = Array.isArray(row) ? row : [row];
    this.payload = Array.isArray(row) ? null : row;
    return this;
  }
  update(row: MockRow): MockQuery { this.op = 'update'; this.updatePayload = row; return this; }
  eq(col: string, val: unknown): MockQuery {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown): MockQuery {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  is(col: string, val: unknown): MockQuery {
    if (val === null) this.filters.push((r) => r[col] === null || r[col] === undefined);
    else this.filters.push((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]): MockQuery {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  not(col: string, _op: string, val: unknown): MockQuery {
    // `not('phone', 'is', null)` → phone IS NOT NULL
    if (val === null) this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }
  limit(n: number): MockQuery { this.limitN = n; return this; }
  order(col: string, opts?: { ascending?: boolean }): MockQuery {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  // The supabase JS client lets you await any of these terminal-like calls
  // directly; we shim by giving the query a .then() so `await mock.from(...).select(...).eq(...)` works.
  then<TRes1 = { data: MockRow[] | MockRow | null; error: { message?: string; code?: string } | null }>(
    resolve: (v: TRes1) => unknown,
  ): unknown {
    return resolve(this.exec() as unknown as TRes1);
  }
  maybeSingle(): MockQuery {
    this.limitN = 1;
    (this as unknown as { _singleMode: boolean })._singleMode = true;
    return this;
  }
  single(): MockQuery {
    return this.maybeSingle();
  }

  private exec(): { data: MockRow[] | MockRow | null; error: { message?: string; code?: string } | null } {
    const singleMode = !!(this as unknown as { _singleMode: boolean })._singleMode;
    if (this.op === 'insert' && (this.payload || this.bulkPayload)) {
      const idx = this.table.uniqueIndexes ?? [];
      const toInsert = this.bulkPayload ?? (this.payload ? [this.payload] : []);
      const inserted: MockRow[] = [];
      for (const row of toInsert) {
        for (const keyFn of idx) {
          const newKey = keyFn(row);
          if (newKey === null) continue;
          if (this.table.rows.some((r) => keyFn(r) === newKey)) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
        }
        const enriched = { id: cryptoUuid(), ...row };
        this.table.rows.push(enriched);
        inserted.push(enriched);
      }
      if (singleMode) return { data: inserted[0] ?? null, error: null };
      return { data: inserted, error: null };
    }
    if (this.op === 'update' && this.updatePayload) {
      const matched = this.table.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, this.updatePayload);
      return { data: singleMode ? (matched[0] ?? null) : matched, error: null };
    }
    // select / default
    let rows = this.table.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = rows.slice().sort((a, b) => {
        const av = a[col] as string | number | null;
        const bv = b[col] as string | number | null;
        if (av === bv) return 0;
        if (av === null || av === undefined) return asc ? -1 : 1;
        if (bv === null || bv === undefined) return asc ? 1 : -1;
        return asc ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    if (singleMode) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

function cryptoUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Cast our mock to the SupabaseClient shape the service expects. The
// service only uses the surface implemented above.
function makeClient(db: MockDB): unknown {
  return { from: (t: string) => db.from(t) };
}

// ───────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────

const PID = '00000000-0000-0000-0000-000000000001';
const SICK = '00000000-0000-0000-0000-000000000010';
const A = '00000000-0000-0000-0000-000000000020';
const B = '00000000-0000-0000-0000-000000000030';
const DATE = '2026-05-24';

function seedStaff(db: MockDB): void {
  db.seed('staff', [
    { id: SICK, property_id: PID, name: 'Maria',  is_active: true, is_senior: true, scheduled_today: true, weekly_hours: 30, max_weekly_hours: 40, phone: '+15551110010', language: 'en', department: 'housekeeping', vacation_dates: [] },
    { id: A,    property_id: PID, name: 'Carlos', is_active: true, is_senior: true, scheduled_today: true, weekly_hours: 30, max_weekly_hours: 40, phone: '+15551110020', language: 'en', department: 'housekeeping', vacation_dates: [] },
    { id: B,    property_id: PID, name: 'Lupe',   is_active: true, is_senior: true, scheduled_today: true, weekly_hours: 30, max_weekly_hours: 40, phone: '+15551110030', language: 'es', department: 'housekeeping', vacation_dates: [] },
  ]);
}

function seedTasks(db: MockDB, rows: Array<{ id: string; room_number: string; status?: string; assignee_id?: string | null }>): void {
  db.seed(
    'cleaning_tasks',
    rows.map((r) => ({
      id: r.id,
      property_id: PID,
      business_date: DATE,
      room_number: r.room_number,
      cleaning_type: 'departure',
      priority: 'normal',
      due_by: null,
      estimated_minutes: 30,
      requires_inspection: false,
      extras: [],
      rule_inputs: {},
      status: r.status ?? 'scheduled',
      assignee_id: r.assignee_id === undefined ? SICK : r.assignee_id,
      started_at: null,
    })),
  );
}

// ───────────────────────────────────────────────────────────────────────
// TESTS
// ───────────────────────────────────────────────────────────────────────

describe('createCallout', () => {
  let db: MockDB;
  beforeEach(() => { db = new MockDB(); seedStaff(db); });

  test('inserts a row with reported_by + reason', async () => {
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const result = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE,
      reportedBy: 'self', reason: 'sick',
    });
    assert.equal(result.created, true);
    const rows = db.all('callout_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].staff_id, SICK);
    assert.equal(rows[0].reported_by, 'self');
    assert.equal(rows[0].reason, 'sick');
    assert.equal(rows[0].status, 'active');
  });

  test('idempotent — second call returns same id, created=false', async () => {
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const first = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
    });
    const second = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'sms',
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.calloutId, second.calloutId);
    assert.equal(db.all('callout_events').length, 1);
  });

  test('leave_timing in_15_min defers redistribute_at by 15 minutes', async () => {
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const before = Date.now();
    const result = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
      leaveTiming: 'in_15_min',
    });
    const at = Date.parse(result.redistributeAt);
    assert.ok(at - before >= 14 * 60_000, 'redistribute_at should be ~15 min in future');
    assert.ok(at - before <= 16 * 60_000);
  });
});

describe('runRedistributionForCallout', () => {
  let db: MockDB;
  beforeEach(() => { db = new MockDB(); seedStaff(db); });

  test('reassigns scheduled tasks, retains in-progress with sick HK', async () => {
    seedTasks(db, [
      { id: 't1', room_number: '101', status: 'scheduled' },
      { id: 't2', room_number: '102', status: 'scheduled' },
      { id: 't3', room_number: '103', status: 'in_progress' },
    ]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const created = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'manager',
    });
    await runRedistributionForCallout(client, created.calloutId);

    const tasks = db.all('cleaning_tasks');
    const t1 = tasks.find((r) => r.id === 't1')!;
    const t2 = tasks.find((r) => r.id === 't2')!;
    const t3 = tasks.find((r) => r.id === 't3')!;
    assert.notEqual(t1.assignee_id, SICK);
    assert.notEqual(t2.assignee_id, SICK);
    assert.equal(t3.assignee_id, SICK, 'in_progress task should stay with sick HK');

    const callout = db.all('callout_events')[0];
    assert.ok(callout.redistributed_at, 'redistributed_at should be stamped');
    assert.equal((callout.impacted_assignments as unknown[]).length, 2);
  });

  test('second call is idempotent (alreadyDone=true)', async () => {
    seedTasks(db, [{ id: 't1', room_number: '101' }]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const created = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
    });
    const r1 = await runRedistributionForCallout(client, created.calloutId);
    const r2 = await runRedistributionForCallout(client, created.calloutId);
    assert.equal(r1.alreadyDone, false);
    assert.equal(r2.alreadyDone, true);
  });

  test('callouts on other HKs disqualify them from picking up rooms', async () => {
    // Carlos (A) is also out. Lupe (B) must pick up everything.
    seedTasks(db, [
      { id: 't1', room_number: '101' },
      { id: 't2', room_number: '102' },
      { id: 't3', room_number: '103' },
    ]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    // Carlos's pre-existing callout
    await createCallout(client, {
      propertyId: PID, staffId: A, businessDate: DATE, reportedBy: 'manager',
    });
    const created = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'manager',
    });
    await runRedistributionForCallout(client, created.calloutId);
    const tasks = db.all('cleaning_tasks');
    for (const t of tasks) {
      assert.equal(t.assignee_id, B, `task ${t.id} should be on B (only eligible)`);
    }
  });
});

describe('revertCallout', () => {
  let db: MockDB;
  beforeEach(() => { db = new MockDB(); seedStaff(db); });

  test('returns untouched rooms, keeps started rooms with new assignee', async () => {
    seedTasks(db, [
      { id: 't1', room_number: '101' },
      { id: 't2', room_number: '102' },
    ]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const created = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
    });
    await runRedistributionForCallout(client, created.calloutId);

    // Carlos started t2 while Maria was out
    const t2 = db.all('cleaning_tasks').find((r) => r.id === 't2')!;
    t2.status = 'in_progress';

    const result = await revertCallout(client, {
      calloutId: created.calloutId,
      revertedByStaffId: SICK,
    });
    assert.equal(result.returnedCount, 1);
    assert.equal(result.retainedCount, 1);
    const tasks = db.all('cleaning_tasks');
    assert.equal(tasks.find((r) => r.id === 't1')!.assignee_id, SICK);
    // t2 stays with whoever started it
    assert.notEqual(tasks.find((r) => r.id === 't2')!.assignee_id, SICK);

    // Callout flipped to 'reverted'
    const callout = db.all('callout_events')[0];
    assert.equal(callout.status, 'reverted');
    assert.ok(callout.reverted_at);
    assert.ok(callout.revert_outcome);
  });

  test('a second revert is a no-op (idempotent)', async () => {
    seedTasks(db, [{ id: 't1', room_number: '101' }]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const created = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
    });
    await runRedistributionForCallout(client, created.calloutId);
    await revertCallout(client, { calloutId: created.calloutId });
    const second = await revertCallout(client, { calloutId: created.calloutId });
    assert.equal(second.returnedCount, 0);
    assert.equal(second.retainedCount, 0);
  });

  test('after revert, the same HK CAN call out again on the same day', async () => {
    seedTasks(db, [{ id: 't1', room_number: '101' }]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const first = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
    });
    await revertCallout(client, { calloutId: first.calloutId });
    const second = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'manager',
    });
    assert.equal(second.created, true);
    assert.notEqual(first.calloutId, second.calloutId);
  });
});

describe('reads', () => {
  let db: MockDB;
  beforeEach(() => { db = new MockDB(); seedStaff(db); });

  test('hasActiveCalloutToday true after create, false after revert', async () => {
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    assert.equal(await hasActiveCalloutToday(client, PID, SICK, DATE), false);
    const c = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'self',
    });
    assert.equal(await hasActiveCalloutToday(client, PID, SICK, DATE), true);
    await revertCallout(client, { calloutId: c.calloutId });
    assert.equal(await hasActiveCalloutToday(client, PID, SICK, DATE), false);
  });

  test('listActiveCalloutsForBanner returns one entry with pickups grouped by name', async () => {
    seedTasks(db, [
      { id: 't1', room_number: '101' },
      { id: 't2', room_number: '102' },
    ]);
    const client = makeClient(db) as Parameters<typeof createCallout>[0];
    const c = await createCallout(client, {
      propertyId: PID, staffId: SICK, businessDate: DATE, reportedBy: 'manager', reason: 'sick',
    });
    await runRedistributionForCallout(client, c.calloutId);

    const entries = await listActiveCalloutsForBanner(client, PID, DATE);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].staff_name, 'Maria');
    assert.equal(entries[0].reason, 'sick');
    assert.equal(entries[0].total_redistributed, 2);
    // pickup count adds up to 2 across whichever receivers got the rooms
    const totalPicked = entries[0].pickups.reduce((s, p) => s + p.count, 0);
    assert.equal(totalPicked, 2);
  });
});

// Suppress unused import warning for the type re-export check below
void ({} as CalloutEvent);
