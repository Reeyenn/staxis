import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { finalizeInspection } from '@/lib/inspections/correction-loop';

const INSPECTION_ID = 'b5100000-0000-4000-8000-000000000001';
const PROPERTY_ID = 'b5200000-0000-4000-8000-000000000001';

type InspectionDbRow = Record<string, unknown> & {
  result: 'in_progress' | 'pass' | 'fail';
};

function inspectionRow(result: InspectionDbRow['result']): InspectionDbRow {
  return {
    id: INSPECTION_ID,
    property_id: PROPERTY_ID,
    room_number: '101',
    room_id: null,
    cleaning_task_id: null,
    checklist_id: null,
    inspector_staff_id: null,
    housekeeper_staff_id: null,
    started_at: '2026-08-02T10:00:00.000Z',
    completed_at: result === 'in_progress' ? null : '2026-08-02T10:05:00.000Z',
    result,
    failed_items: [],
    passed_items: [],
    correction_notice_sent_at: null,
    recheck_inspection_id: null,
    parent_inspection_id: null,
    notes: null,
    escalated: false,
    escalation_reason: null,
    created_at: '2026-08-02T10:00:00.000Z',
    updated_at: '2026-08-02T10:05:00.000Z',
  };
}

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

function installInspectionStore(state: { row: InspectionDbRow }) {
  // @ts-expect-error test-only Supabase client seam
  supabaseAdmin.from = (table: string) => {
    if (table !== 'inspections') throw new Error(`unexpected table ${table}`);
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: state.row, error: null }),
    };
    return builder;
  };
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

describe('finalizeInspection canonical retry idempotency', () => {
  test('a retry for an already-terminal matching result succeeds without another write', async () => {
    const state = { row: inspectionRow('pass') };
    installInspectionStore(state);
    let rpcCalls = 0;
    // @ts-expect-error test-only Supabase client seam
    supabaseAdmin.rpc = async () => {
      rpcCalls += 1;
      return { data: null, error: null };
    };

    const result = await finalizeInspection({
      inspectionId: INSPECTION_ID,
      result: 'pass',
      failedItems: [],
      passedItems: ['bathroom'],
      notes: null,
    });

    assert.equal(result.inspection.result, 'pass');
    assert.equal(result.correctionNoticeSent, false);
    assert.equal(rpcCalls, 0, 'a committed retry must not issue another write');
  });

  test('a terminal mismatch remains a conflict without a second writer', async () => {
    const state = { row: inspectionRow('fail') };
    installInspectionStore(state);
    let rpcCalls = 0;
    // @ts-expect-error test-only Supabase client seam
    supabaseAdmin.rpc = async () => {
      rpcCalls += 1;
      return { data: null, error: null };
    };

    await assert.rejects(
      finalizeInspection({
        inspectionId: INSPECTION_ID,
        result: 'pass',
        failedItems: [],
        passedItems: ['bathroom'],
        notes: null,
      }),
      /already finalized as fail/,
    );
    assert.equal(rpcCalls, 0, 'a terminal mismatch must not issue a compensating write');
  });

  test('an E_ALREADY_FINALIZED response refetches and succeeds when the committed result matches', async () => {
    const state = { row: inspectionRow('in_progress') };
    installInspectionStore(state);
    let rpcCalls = 0;
    // @ts-expect-error test-only Supabase client seam
    supabaseAdmin.rpc = async () => {
      rpcCalls += 1;
      state.row = inspectionRow('fail');
      return { data: null, error: { message: 'E_ALREADY_FINALIZED: inspection already fail' } };
    };

    const result = await finalizeInspection({
      inspectionId: INSPECTION_ID,
      result: 'fail',
      failedItems: [{ itemId: 'bathroom', label: 'Bathroom', severity: 'major', photoUrl: null, note: null }],
      passedItems: [],
      notes: 'retry',
    });

    assert.equal(result.inspection.result, 'fail');
    assert.equal(result.correctionNoticeSent, true);
    assert.equal(rpcCalls, 1, 'the duplicate race makes exactly one canonical attempt');
  });

  test('an E_ALREADY_FINALIZED response remains a conflict when the committed result differs', async () => {
    const state = { row: inspectionRow('in_progress') };
    installInspectionStore(state);
    // @ts-expect-error test-only Supabase client seam
    supabaseAdmin.rpc = async () => {
      state.row = inspectionRow('pass');
      return { data: null, error: { message: 'E_ALREADY_FINALIZED: inspection already pass' } };
    };

    await assert.rejects(
      finalizeInspection({
        inspectionId: INSPECTION_ID,
        result: 'fail',
        failedItems: [{ itemId: 'bathroom', label: 'Bathroom', severity: 'major', photoUrl: null, note: null }],
        passedItems: [],
        notes: 'retry',
      }),
      /finalized as pass, not the requested fail/,
    );
  });
});
