/**
 * Tests for the inspections checklist-selector. These are pure functions
 * — no DB, no network — so they exercise the precedence rules described
 * in the function comment without any infrastructure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectChecklist } from '@/lib/inspections';
import type { InspectionChecklist } from '@/types/inspections';

function checklist(over: Partial<InspectionChecklist> = {}): InspectionChecklist {
  return {
    id: over.id ?? `cl-${Math.random().toString(36).slice(2, 8)}`,
    propertyId: over.propertyId ?? null,
    name: over.name ?? 'Checklist',
    appliesToCleaningTypes: over.appliesToCleaningTypes ?? [],
    appliesToRoomTypes: over.appliesToRoomTypes ?? [],
    isActive: over.isActive ?? true,
    version: over.version ?? 1,
    items: over.items ?? [],
    createdAt: over.createdAt ?? '2026-01-01T00:00:00Z',
    updatedAt: over.updatedAt ?? '2026-01-01T00:00:00Z',
  };
}

const PID = '11111111-1111-1111-1111-111111111111';

describe('selectChecklist', () => {
  it('returns null when there are no active checklists', () => {
    const got = selectChecklist({ candidates: [], cleaningType: 'departure', roomType: null, propertyId: PID });
    assert.equal(got, null);

    const inactive = checklist({ isActive: false });
    const got2 = selectChecklist({ candidates: [inactive], cleaningType: null, roomType: null, propertyId: PID });
    assert.equal(got2, null);
  });

  it('property-scoped beats global when both match the cleaning type', () => {
    const global = checklist({ id: 'g', appliesToCleaningTypes: ['departure'], name: 'global departure' });
    const local = checklist({ id: 'l', propertyId: PID, appliesToCleaningTypes: ['departure'], name: 'local departure' });
    const got = selectChecklist({
      candidates: [global, local],
      cleaningType: 'departure',
      roomType: null,
      propertyId: PID,
    });
    assert.equal(got?.id, 'l');
  });

  it('checklist that requires a different cleaning type is filtered out', () => {
    const wrongType = checklist({ id: 'w', appliesToCleaningTypes: ['stayover'] });
    const right = checklist({ id: 'r', appliesToCleaningTypes: ['departure'] });
    const got = selectChecklist({
      candidates: [wrongType, right],
      cleaningType: 'departure',
      roomType: null,
      propertyId: PID,
    });
    assert.equal(got?.id, 'r');
  });

  it('catch-all checklist (empty filters) is picked over inapplicable specific ones', () => {
    const inapplicable = checklist({ id: 'x', appliesToCleaningTypes: ['stayover'] });
    const catchall = checklist({ id: 'c' });
    const got = selectChecklist({
      candidates: [inapplicable, catchall],
      cleaningType: 'departure',
      roomType: null,
      propertyId: PID,
    });
    assert.equal(got?.id, 'c');
  });

  it('cleaning + room type match outranks cleaning-only match', () => {
    const cleaningOnly = checklist({ id: 'co', appliesToCleaningTypes: ['departure'] });
    const both = checklist({
      id: 'both',
      appliesToCleaningTypes: ['departure'],
      appliesToRoomTypes: ['suite'],
    });
    const got = selectChecklist({
      candidates: [cleaningOnly, both],
      cleaningType: 'departure',
      roomType: 'suite',
      propertyId: PID,
    });
    assert.equal(got?.id, 'both');
  });

  it('within a score tie, newer updatedAt wins', () => {
    const older = checklist({ id: 'old', appliesToCleaningTypes: ['departure'], updatedAt: '2025-01-01T00:00:00Z' });
    const newer = checklist({ id: 'new', appliesToCleaningTypes: ['departure'], updatedAt: '2026-01-01T00:00:00Z' });
    const got = selectChecklist({
      candidates: [older, newer],
      cleaningType: 'departure',
      roomType: null,
      propertyId: PID,
    });
    assert.equal(got?.id, 'new');
  });

  it('falls back to property catch-all if nothing matches strictly', () => {
    const pickyGlobal = checklist({ id: 'pg', appliesToCleaningTypes: ['no_such_type'] });
    const localCatch = checklist({ id: 'lc', propertyId: PID });
    const got = selectChecklist({
      candidates: [pickyGlobal, localCatch],
      cleaningType: 'departure',
      roomType: null,
      propertyId: PID,
    });
    // localCatch passes the eligibility filter (no required cleaningType),
    // so it scores 101 vs the global catch-all which would score 1.
    assert.equal(got?.id, 'lc');
  });
});
