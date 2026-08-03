import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { startInspectionCore } from '@/lib/inspections/start-core';

const PROPERTY = 'c1000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = 'c1000000-0000-4000-8000-000000000002';
const CHECKLIST = 'c2000000-0000-4000-8000-000000000001';

type Plan = {
  id: string;
  legacy_task_id?: string | null;
  property_id: string;
  room_number: string;
  business_date: string;
  cleaning_type: string;
};

type Inspection = Record<string, unknown>;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function checklistRow() {
  return {
    id: CHECKLIST,
    property_id: PROPERTY,
    name: 'Canonical start checklist',
    applies_to_cleaning_types: [],
    applies_to_room_types: [],
    is_active: true,
    version: 1,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

function installBackendStore(plans: Plan[]) {
  const inspections: Inspection[] = [];
  let nextInspection = 1;

  function filterRows(table: string, filters: Array<[string, unknown]>, orders: Array<[string, boolean]>, limit: number | null, range: [number, number] | null) {
    let rows: Record<string, unknown>[] =
      table === 'room_work_plan_v1' ? plans.map((plan) => ({
        ...plan,
        id: plan.legacy_task_id ?? plan.id,
      }))
        : table === 'inspection_checklists' ? [checklistRow()]
          : table === 'inspection_checklist_items' ? []
            : table === 'inspections' ? inspections
              : [];
    rows = rows.filter((row) => filters.every(([column, value]) =>
      Array.isArray(value) ? value.includes(row[column]) : row[column] === value));
    for (const [column, ascending] of [...orders].reverse()) {
      rows.sort((a, b) => {
        const left = String(a[column] ?? '');
        const right = String(b[column] ?? '');
        return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    if (range) rows = rows.slice(range[0], range[1] + 1);
    if (limit !== null) rows = rows.slice(0, limit);
    return rows;
  }

  // @ts-expect-error test-only Supabase client seam
  supabaseAdmin.from = (table: string) => {
    let filters: Array<[string, unknown]> = [];
    let orders: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let inserted: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      gte: () => builder,
      lte: () => builder,
      in: (column: string, values: unknown[]) => {
        const current = filters;
        filters = [...current, [column, values]];
        return builder;
      },
      order: (column: string, options: { ascending?: boolean }) => {
        orders.push([column, options.ascending !== false]);
        return builder;
      },
      limit: (value: number) => { limit = value; return builder; },
      range: (from: number, to: number) => { range = [from, to]; return builder; },
      insert: (payload: Record<string, unknown>) => {
        inserted = payload;
        return builder;
      },
      maybeSingle: async () => {
        if (inserted) return { data: inserted, error: null };
        const rows = filterRows(table, filters, orders, limit, range);
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        if (table !== 'inspections' || !inserted) throw new Error(`unexpected single on ${table}`);
        const row: Inspection = {
          ...inserted,
          id: `inspection-${nextInspection++}`,
          started_at: '2026-08-02T12:00:00.000Z',
          completed_at: null,
          result: 'in_progress',
          failed_items: [],
          passed_items: [],
          correction_notice_sent_at: null,
          recheck_inspection_id: null,
          notes: null,
          escalated: false,
          escalation_reason: null,
          created_at: '2026-08-02T12:00:00.000Z',
          updated_at: '2026-08-02T12:00:00.000Z',
        };
        inspections.push(row);
        return { data: row, error: null };
      },
      then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) => {
        const rows = filterRows(table, filters, orders, limit, range);
        return Promise.resolve(resolve({ data: rows, error: null }));
      },
    };
    return builder;
  };

  return inspections;
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

const commonInput = {
  propertyId: PROPERTY,
  cleaningType: null,
  roomType: null,
  inspectorStaffId: null,
  parentInspectionId: null,
};

describe('inspection starts resolve canonical plan identity', () => {
  test('manager start selects the latest applicable canonical plan, not a legacy task', async () => {
    installBackendStore([
      { id: 'legacy-plan-id', property_id: PROPERTY, room_number: '101', business_date: '2026-08-01', cleaning_type: 'stayover' },
      { id: 'canonical-plan-id', property_id: PROPERTY, room_number: '101', business_date: '2026-08-02', cleaning_type: 'departure' },
      { id: 'room-work-legacy-row', legacy_task_id: 'legacy-linked-id', property_id: PROPERTY, room_number: '102', business_date: '2026-08-02', cleaning_type: 'stayover' },
      { id: 'other-property-plan', property_id: OTHER_PROPERTY, room_number: '401', business_date: '2026-08-04', cleaning_type: 'departure' },
    ]);

    const result = await startInspectionCore({
      ...commonInput,
      roomNumber: '101',
      roomId: 'c3000000-0000-4000-8000-000000000001',
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.inspection?.cleaningTaskId, 'canonical-plan-id');
    }

    const legacyLinked = await startInspectionCore({
      ...commonInput,
      roomNumber: '102',
      roomId: null,
    });
    assert.equal(legacyLinked.kind, 'ok');
    if (legacyLinked.kind === 'ok') {
      assert.equal(legacyLinked.inspection?.cleaningTaskId, 'legacy-linked-id');
    }

    const isolated = await startInspectionCore({
      ...commonInput,
      roomNumber: '401',
      roomId: null,
    });
    assert.equal(isolated.kind, 'ok');
    if (isolated.kind === 'ok') {
      assert.equal(isolated.inspection?.cleaningTaskId, null, 'a different property plan must not link into this property');
    }
  });

  test('housekeeper composite room id selects its exact date and room', async () => {
    installBackendStore([
      { id: 'housekeeper-exact-plan', property_id: PROPERTY, room_number: '202', business_date: '2026-08-02', cleaning_type: 'stayover' },
      { id: 'housekeeper-later-plan', property_id: PROPERTY, room_number: '202', business_date: '2026-08-03', cleaning_type: 'departure' },
    ]);

    const result = await startInspectionCore({
      ...commonInput,
      roomNumber: '202',
      roomId: '2026-08-02:202',
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.inspection?.cleaningTaskId, 'housekeeper-exact-plan');
      assert.equal(result.inspection?.roomId, '2026-08-02:202');
    }
  });

  test('missing canonical plans leave the link empty, while ambiguous latest plans fail closed', async () => {
    installBackendStore([]);
    const missing = await startInspectionCore({
      ...commonInput,
      roomNumber: '303',
      roomId: null,
    });
    assert.equal(missing.kind, 'ok');
    if (missing.kind === 'ok') assert.equal(missing.inspection?.cleaningTaskId, null);

    supabaseAdmin.from = originalFrom;
    installBackendStore([
      { id: 'ambiguous-a', property_id: PROPERTY, room_number: '304', business_date: '2026-08-02', cleaning_type: 'stayover' },
      { id: 'ambiguous-b', property_id: PROPERTY, room_number: '304', business_date: '2026-08-02', cleaning_type: 'departure' },
    ]);
    await assert.rejects(
      startInspectionCore({ ...commonInput, roomNumber: '304', roomId: null }),
      /ambiguous canonical cleaning plan/,
    );
  });

  test('a composite identifier that disagrees with the room input fails closed', async () => {
    installBackendStore([
      { id: 'mismatch-plan', property_id: PROPERTY, room_number: '305', business_date: '2026-08-02', cleaning_type: 'stayover' },
    ]);
    await assert.rejects(
      startInspectionCore({ ...commonInput, roomNumber: '306', roomId: '2026-08-02:305' }),
      /does not match room number/,
    );
  });
});
