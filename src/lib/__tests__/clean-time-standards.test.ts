/**
 * Tests for the Clean Times standard table (migration 0244):
 *   - the pure resolver/index helpers in src/lib/clean-time-standards.ts, and
 *   - the merger wiring in src/lib/rules-engine/merger.ts that lets a
 *     property's manager-set base override the rule-supplied / static base.
 *
 * These are PURE (no DB) — they exercise the exact logic the rules-engine
 * uses at task-creation time without touching Supabase.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITABLE_CLEANING_TYPES,
  CLEAN_TIME_DEFAULT_MINUTES,
  indexStandards,
  resolveStandardMinutes,
  standardsToBaseDurations,
  isEditableCleaningType,
  isValidBaseMinutes,
  defaultStandardRows,
  type CleanTimeStandardRow,
} from '@/lib/clean-time-standards';
import { mergePartials } from '@/lib/rules-engine/merger';
import type { RuleFireResult } from '@/lib/rules-engine/types';
import { blankRoomContext } from './rules-engine-fixtures';

function fire(id: string, partial: RuleFireResult['partial']): RuleFireResult {
  return { id, summary: `${id} fired`, partial };
}

describe('clean-time-standards: defaults + guards', () => {
  test('no_clean is NOT editable (definitionally 0 min)', () => {
    assert.equal(isEditableCleaningType('no_clean'), false);
    assert.equal(isEditableCleaningType('departure'), true);
    assert.equal(isEditableCleaningType('nonsense'), false);
  });

  test('every editable type has a default and it passes the range check', () => {
    for (const t of EDITABLE_CLEANING_TYPES) {
      const v = CLEAN_TIME_DEFAULT_MINUTES[t];
      assert.equal(isValidBaseMinutes(v), true, `${t} default ${v} out of range`);
    }
  });

  test('isValidBaseMinutes rejects 0, >240, non-integers, non-numbers', () => {
    assert.equal(isValidBaseMinutes(0), false);
    assert.equal(isValidBaseMinutes(241), false);
    assert.equal(isValidBaseMinutes(20.5), false);
    assert.equal(isValidBaseMinutes('30'), false);
    assert.equal(isValidBaseMinutes(undefined), false);
    assert.equal(isValidBaseMinutes(1), true);
    assert.equal(isValidBaseMinutes(240), true);
  });

  test('defaultStandardRows covers every editable type as all-rooms rows', () => {
    const rows = defaultStandardRows();
    assert.equal(rows.length, EDITABLE_CLEANING_TYPES.length);
    for (const r of rows) assert.equal(r.room_type, null);
  });
});

describe('resolveStandardMinutes', () => {
  const rows: CleanTimeStandardRow[] = [
    { cleaning_type: 'departure', room_type: null, base_minutes: 25 },
    { cleaning_type: 'departure', room_type: 'Suite', base_minutes: 40 },
    { cleaning_type: 'deep', room_type: null, base_minutes: 80 },
  ];
  const idx = indexStandards(rows);

  test('all-rooms row resolves when no room_type given', () => {
    assert.equal(resolveStandardMinutes(idx, 'departure'), 25);
    assert.equal(resolveStandardMinutes(idx, 'deep'), 80);
  });

  test('room_type-specific row wins over all-rooms', () => {
    assert.equal(resolveStandardMinutes(idx, 'departure', 'Suite'), 40);
  });

  test('unknown room_type falls back to the all-rooms row', () => {
    assert.equal(resolveStandardMinutes(idx, 'departure', 'Standard King'), 25);
  });

  test('type with no row returns undefined (caller falls back to static default)', () => {
    assert.equal(resolveStandardMinutes(idx, 'stayover'), undefined);
    assert.equal(resolveStandardMinutes(idx, 'no_clean'), undefined);
  });

  test('standardsToBaseDurations uses only all-rooms rows', () => {
    const map = standardsToBaseDurations(rows);
    assert.equal(map.departure, 25); // all-rooms, not the Suite 40
    assert.equal(map.deep, 80);
    assert.equal('Suite' in map, false);
  });
});

describe('mergePartials honours the Clean Times base override', () => {
  test('table base overrides the rule-supplied base', () => {
    const ctx = blankRoomContext();
    const idx = indexStandards([{ cleaning_type: 'departure', room_type: null, base_minutes: 25 }]);
    const spec = mergePartials(
      [fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 })],
      ctx,
      idx,
    );
    assert.ok(spec);
    assert.equal(spec!.estimated_minutes, 25);
  });

  test('room_type-specific row wins for a suite', () => {
    const ctx = blankRoomContext({ room_type: 'Suite', is_suite: true });
    const idx = indexStandards([
      { cleaning_type: 'departure', room_type: null, base_minutes: 25 },
      { cleaning_type: 'departure', room_type: 'Suite', base_minutes: 45 },
    ]);
    const spec = mergePartials(
      [fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 })],
      ctx,
      idx,
    );
    assert.equal(spec!.estimated_minutes, 45);
  });

  test('deltas still add on top of the table base', () => {
    const ctx = blankRoomContext();
    const idx = indexStandards([{ cleaning_type: 'departure', room_type: null, base_minutes: 22 }]);
    const spec = mergePartials(
      [
        fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
        fire('pet-stay', { estimated_minutes_delta: 10 }),
      ],
      ctx,
      idx,
    );
    assert.equal(spec!.estimated_minutes, 32); // 22 + 10, NOT 35 + 10
  });

  test('table miss falls back to the rule-supplied base (legacy behaviour)', () => {
    const ctx = blankRoomContext();
    const idx = indexStandards([{ cleaning_type: 'deep', room_type: null, base_minutes: 60 }]);
    const spec = mergePartials(
      [fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 })],
      ctx,
      idx,
    );
    assert.equal(spec!.estimated_minutes, 35);
  });

  test('no baseIndex passed ⇒ identical to legacy (rule base) — back-compat', () => {
    const ctx = blankRoomContext();
    const spec = mergePartials(
      [fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 })],
      ctx,
    );
    assert.equal(spec!.estimated_minutes, 35);
  });
});
