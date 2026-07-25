/**
 * Migration 0346 — the mirror / state split.
 *
 * pms_housekeeping_assignments is now a read-only mirror of what the PMS
 * housekeeping report printed; everything Staxis knows about a room's day lives
 * in public.room_work, which the ingest physically cannot write.
 *
 * Two pure functions carry the whole behavioural risk of that split, and both
 * sit on the PUBLIC, unauthenticated housekeeper SMS-link path:
 *
 *   mergeAssignment          — folds the two halves back into one row
 *   assignmentBelongsToStaff — decides whose shift a room appears on
 *
 * Get the second one wrong and a housekeeper opens their link to "no work",
 * which is indistinguishable from a genuine day off. These tests pin the
 * precedence rules rather than the shape of the code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeAssignment,
  assignmentBelongsToStaff,
  buildStaffLookup,
} from '../pms-rooms-server';
import { mergeHkHalves } from '../rules-engine/context';

const MARIA = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const NAMES = new Map([[MARIA, 'Maria Garcia'], [ANA, 'Ana Lopez']]);

function mirror(over: Partial<Parameters<typeof mergeAssignment>[0] & object> = {}) {
  return {
    room_number: '101',
    housekeeper_name: null,
    cleaning_type: null,
    dnd_active: null,
    ...over,
  } as NonNullable<Parameters<typeof mergeAssignment>[0]>;
}

function work(over: Record<string, unknown> = {}) {
  return {
    room_number: '101',
    status: 'not_started',
    started_at: null,
    completed_at: null,
    cleaning_type: null,
    dnd_active: null,
    assigned_staff_id: null,
    is_paused: false,
    paused_at: null,
    total_paused_seconds: 0,
    exception_type: null,
    exception_note: null,
    exception_at: null,
    checklist_template_id: null,
    checklist_progress: [],
    manager_notes: null,
    housekeeper_note: null,
    is_rush: false,
    rush_due_by: null,
    marked_for_inspection_at: null,
    inspected_by: null,
    inspected_at: null,
    issue_note: null,
    help_requested: false,
    dnd_note: null,
    ...over,
  } as NonNullable<Parameters<typeof mergeAssignment>[1]>;
}

describe('mergeAssignment — 0346 precedence', () => {
  test('neither half present is not a room', () => {
    assert.equal(mergeAssignment(undefined, undefined, NAMES), undefined);
  });

  test('a PMS row nobody has touched keeps the report and has no app state', () => {
    const m = mergeAssignment(
      mirror({ housekeeper_name: 'Maria Garcia', cleaning_type: 'departure', dnd_active: true }),
      undefined,
      NAMES,
    );
    assert.ok(m);
    assert.equal(m!.cleaning_type, 'departure');
    assert.equal(m!.dnd_active, true);
    assert.equal(m!.housekeeper_name, 'Maria Garcia');
    assert.equal(m!.status, null, 'lifecycle only ever comes from room_work');
    assert.equal(m!.assigned_staff_id, null);
  });

  test('a Staxis row for a room the report never listed still renders', () => {
    const m = mergeAssignment(undefined, work({ status: 'in_progress', started_at: 'T1' }), NAMES);
    assert.ok(m);
    assert.equal(m!.room_number, '101');
    assert.equal(m!.status, 'in_progress');
    assert.equal(m!.started_at, 'T1');
  });

  test("the manager's cleaning_type beats the report's", () => {
    const m = mergeAssignment(
      mirror({ cleaning_type: 'departure' }),
      work({ cleaning_type: 'stayover' }),
      NAMES,
    );
    assert.equal(m!.cleaning_type, 'stayover');
  });

  test('no app opinion on cleaning_type falls back to the report', () => {
    const m = mergeAssignment(mirror({ cleaning_type: 'departure' }), work(), NAMES);
    assert.equal(m!.cleaning_type, 'departure');
  });

  // The case the whole coalesce rule exists for: a manager (or housekeeper)
  // turns DND OFF, and the next PMS report still says it is on. `false` is an
  // opinion; only NULL defers to the report.
  test('an explicit DND-off beats a stale report that still says DND is on', () => {
    const m = mergeAssignment(mirror({ dnd_active: true }), work({ dnd_active: false }), NAMES);
    assert.equal(m!.dnd_active, false);
  });

  test('DND with no app opinion still shows what the report said', () => {
    const m = mergeAssignment(mirror({ dnd_active: true }), work({ dnd_active: null }), NAMES);
    assert.equal(m!.dnd_active, true);
  });

  test('an id-based assignment resolves to that staff member’s name', () => {
    const m = mergeAssignment(
      mirror({ housekeeper_name: 'Ana Lopez' }),
      work({ assigned_staff_id: MARIA }),
      NAMES,
    );
    assert.equal(m!.housekeeper_name, 'Maria Garcia', 'identity beats the printed name');
    assert.equal(m!.assigned_staff_id, MARIA);
  });

  test('an id we cannot name still falls back to the printed name rather than blanking', () => {
    const m = mergeAssignment(
      mirror({ housekeeper_name: 'Ana Lopez' }),
      work({ assigned_staff_id: 'deadbeef-0000-4000-8000-000000000000' }),
      NAMES,
    );
    assert.equal(m!.housekeeper_name, 'Ana Lopez');
  });

  test('every app-state field comes through the merge', () => {
    const m = mergeAssignment(
      undefined,
      work({
        is_paused: true, paused_at: 'T2', total_paused_seconds: 90,
        exception_type: 'dnd', exception_note: 'guest asleep', exception_at: 'T3',
        checklist_progress: ['bed', 'bath'], manager_notes: 'deep clean',
        housekeeper_note: 'low on towels', is_rush: true, rush_due_by: 'T4',
        marked_for_inspection_at: 'T5', inspected_by: 'GM', inspected_at: 'T6',
        issue_note: 'lamp broken', help_requested: true, dnd_note: 'sign on door',
      }),
      NAMES,
    );
    assert.equal(m!.is_paused, true);
    assert.equal(m!.total_paused_seconds, 90);
    assert.equal(m!.exception_type, 'dnd');
    assert.deepEqual(m!.checklist_progress, ['bed', 'bath']);
    assert.equal(m!.manager_notes, 'deep clean');
    assert.equal(m!.housekeeper_note, 'low on towels');
    assert.equal(m!.is_rush, true);
    assert.equal(m!.inspected_by, 'GM');
    assert.equal(m!.issue_note, 'lamp broken');
    assert.equal(m!.help_requested, true);
    assert.equal(m!.dnd_note, 'sign on door');
  });
});

describe('assignmentBelongsToStaff — whose shift a room shows up on', () => {
  const roster = buildStaffLookup([
    { id: MARIA, name: 'Maria Garcia' },
    { id: ANA, name: 'Ana Lopez' },
  ]);

  test('an id-based assignment belongs to that staff member', () => {
    assert.equal(
      assignmentBelongsToStaff({ assigned_staff_id: MARIA, housekeeper_name: 'Maria Garcia' }, MARIA, roster),
      true,
    );
  });

  // The bug this guards: the report still prints yesterday's housekeeper while
  // the manager has reassigned the room. If the name were consulted first, the
  // room would appear on BOTH shifts.
  test('a reassignment by id wins over the name the report still prints', () => {
    const a = { assigned_staff_id: ANA, housekeeper_name: 'Maria Garcia' };
    assert.equal(assignmentBelongsToStaff(a, ANA, roster), true);
    assert.equal(assignmentBelongsToStaff(a, MARIA, roster), false);
  });

  // Day-one behaviour: before anything has written room_work.assigned_staff_id,
  // the public housekeeper link must still show the PMS-assigned rooms.
  test('with no id, the PMS-printed name still resolves the shift', () => {
    assert.equal(
      assignmentBelongsToStaff({ assigned_staff_id: null, housekeeper_name: 'Maria Garcia' }, MARIA, roster),
      true,
    );
  });

  test('the name fallback tolerates PMS spacing and case', () => {
    assert.equal(
      assignmentBelongsToStaff({ assigned_staff_id: null, housekeeper_name: '  MARIA   GARCIA ' }, MARIA, roster),
      true,
    );
  });

  test('a first name is enough only while it is unique', () => {
    assert.equal(
      assignmentBelongsToStaff({ assigned_staff_id: null, housekeeper_name: 'Maria' }, MARIA, roster),
      true,
    );
    const collided = buildStaffLookup([
      { id: MARIA, name: 'Maria Garcia' },
      { id: ANA, name: 'Maria Lopez' },
    ]);
    assert.equal(
      assignmentBelongsToStaff({ assigned_staff_id: null, housekeeper_name: 'Maria' }, MARIA, collided),
      false,
      'two Marias must not each inherit the other’s rooms',
    );
  });

  test('an unassigned room belongs to nobody', () => {
    assert.equal(
      assignmentBelongsToStaff({ assigned_staff_id: null, housekeeper_name: null }, MARIA, roster),
      false,
    );
  });
});

describe('mergeHkHalves — the rules engine sees the same precedence', () => {
  test('the app override wins and the report supplies the approval fields', () => {
    const [row] = mergeHkHalves(
      [{
        room_number: '204', cleaning_type: 'departure', dnd_active: true,
        late_checkout_approved: true, late_checkout_until: '14:00',
        early_checkin_approved: null, early_checkin_from: null,
      }],
      [{ room_number: '204', cleaning_type: 'stayover', status: 'in_progress', dnd_active: false }],
    );
    assert.equal(row!.cleaning_type, 'stayover');
    assert.equal(row!.dnd_active, false);
    assert.equal(row!.status, 'in_progress');
    assert.equal(row!.late_checkout_approved, true, 'approvals are the report’s to give');
    assert.equal(row!.late_checkout_until, '14:00');
  });

  test('a room in only one half is not dropped', () => {
    const rows = mergeHkHalves(
      [{
        room_number: '301', cleaning_type: 'departure', dnd_active: null,
        late_checkout_approved: null, late_checkout_until: null,
        early_checkin_approved: null, early_checkin_from: null,
      }],
      [{ room_number: '302', cleaning_type: null, status: 'completed', dnd_active: null }],
    );
    assert.deepEqual(rows.map(r => r.room_number).sort(), ['301', '302']);
    assert.equal(rows.find(r => r.room_number === '301')!.status, 'not_started');
    assert.equal(rows.find(r => r.room_number === '302')!.status, 'completed');
  });
});
