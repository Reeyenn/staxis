/**
 * Tests for the correction-loop pure helpers — buildCorrectionNote and
 * filterReadyForRecheck. The side-effect functions (applyPass /
 * applyFail / finalizeInspection) hit the DB and are exercised via
 * integration tests, not here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCorrectionNote,
  filterReadyForRecheck,
} from '@/lib/inspections';
import type { InspectionFailedItem } from '@/types/inspections';

describe('buildCorrectionNote', () => {
  it('returns a generic prompt when no items failed', () => {
    assert.equal(buildCorrectionNote([]), 'Re-clean requested by inspector.');
  });

  it('prefixes severity for a single failed item', () => {
    const items: InspectionFailedItem[] = [{
      itemId: 'a', label: 'Mirror polished', severity: 'major', photoUrl: null, note: null,
    }];
    const note = buildCorrectionNote(items);
    assert.match(note, /Major: Mirror polished/);
  });

  it('joins multiple failures with semicolons and shows the per-item note', () => {
    const items: InspectionFailedItem[] = [
      { itemId: 'a', label: 'Mirror polished',  severity: 'major',    photoUrl: null, note: 'streaks' },
      { itemId: 'b', label: 'Linens clean',     severity: 'critical', photoUrl: null, note: null },
    ];
    const note = buildCorrectionNote(items);
    assert.match(note, /Major: Mirror polished \(streaks\)/);
    assert.match(note, /Critical: Linens clean/);
    assert.ok(note.includes('; '));
  });
});

describe('countConsecutiveFails (input shape)', () => {
  // countConsecutiveFails hits the DB; the shape of its arguments is
  // the actual contract being verified here. The TS overload accepts
  // either:
  //   (legacy)  countConsecutiveFails(parentId | null)
  //   (new)     countConsecutiveFails({ parentId, propertyId, roomNumber })
  // The new shape MUST be passed by finalizeInspection so a malformed
  // parent_inspection_id pointing at another property can't pull
  // failures into the count.
  //
  // We assert this at the lib level by reading the source and
  // confirming finalizeInspection passes the object form. Cheap and
  // catches the regression case (someone refactors and reverts to the
  // bare-id form, silently losing the cross-property guard).
  it('finalizeInspection passes propertyId + roomNumber to countConsecutiveFails', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(here, '..', 'inspections', 'correction-loop.ts'),
      'utf8',
    );
    // The call site must include both new fields. If anyone reverts to
    // countConsecutiveFails(before.parentInspectionId), this fails loudly.
    assert.match(src, /countConsecutiveFails\(\s*\{[\s\S]*?parentId[\s\S]*?propertyId[\s\S]*?roomNumber[\s\S]*?\}/);
  });
});

describe('filterReadyForRecheck', () => {
  it('returns rooms re-cleaned after the failed inspection', () => {
    const failedInspections = [
      { id: 'i1', roomId: 'r1', completedAt: '2026-05-24T10:00:00Z' },
    ];
    const roomsById = new Map([
      ['r1', { status: 'clean', completedAt: '2026-05-24T10:30:00Z' }],
    ]);
    const out = filterReadyForRecheck({ failedInspections, roomsById });
    assert.deepEqual(out, [{ inspectionId: 'i1', roomId: 'r1' }]);
  });

  it('skips rooms that have NOT been re-cleaned since the fail', () => {
    const failedInspections = [
      { id: 'i1', roomId: 'r1', completedAt: '2026-05-24T10:00:00Z' },
    ];
    const roomsById = new Map([
      ['r1', { status: 'clean', completedAt: '2026-05-24T09:00:00Z' }],
    ]);
    const out = filterReadyForRecheck({ failedInspections, roomsById });
    assert.deepEqual(out, []);
  });

  it('skips rooms whose status is not clean (still dirty / in-progress)', () => {
    const failedInspections = [
      { id: 'i1', roomId: 'r1', completedAt: '2026-05-24T10:00:00Z' },
    ];
    const roomsById = new Map([
      ['r1', { status: 'dirty', completedAt: '2026-05-24T11:00:00Z' }],
    ]);
    const out = filterReadyForRecheck({ failedInspections, roomsById });
    assert.deepEqual(out, []);
  });

  it('skips fails with no completed_at (still in progress?)', () => {
    const failedInspections = [
      { id: 'i1', roomId: 'r1', completedAt: null },
    ];
    const roomsById = new Map([
      ['r1', { status: 'clean', completedAt: '2026-05-24T11:00:00Z' }],
    ]);
    const out = filterReadyForRecheck({ failedInspections, roomsById });
    assert.deepEqual(out, []);
  });

  it('skips fails where the room id is missing from the lookup', () => {
    const failedInspections = [
      { id: 'i1', roomId: 'r1', completedAt: '2026-05-24T10:00:00Z' },
    ];
    const roomsById = new Map<string, { status: string; completedAt: string | null }>();
    const out = filterReadyForRecheck({ failedInspections, roomsById });
    assert.deepEqual(out, []);
  });
});
