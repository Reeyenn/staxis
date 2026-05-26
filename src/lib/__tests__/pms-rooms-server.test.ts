/**
 * Tests for the pure helpers in pms-rooms-server.ts + pms-rooms-writes.ts.
 *
 * Covers:
 *   - mapStatus / mapType / reverseMapType
 *   - formatArrivalMDY / daysBetween
 *   - normalizeName (NFC, diacritic strip, whitespace collapse)
 *   - composeRoomId / parseRoomId (Room.id format round-trip)
 *
 * mergePmsRoomsForDate + mergePmsRoomsForStaff + applyRoom* are integration-
 * tested via /api/housekeeping/rooms + /api/housekeeper/rooms +
 * /api/housekeeping/room-action; these unit tests pin the branching logic
 * that's most likely to regress.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapStatus,
  mapType,
  reverseMapType,
  formatArrivalMDY,
  daysBetween,
  normalizeName,
  composeRoomId,
  parseRoomId,
} from '@/lib/pms-rooms-server';

describe('mapStatus — PMS status + in-progress flag → legacy RoomStatus', () => {
  it('in-progress assignment always wins over status_log', () => {
    assert.equal(mapStatus('vacant_clean', true), 'in_progress');
    assert.equal(mapStatus('out_of_order', true), 'in_progress');
    assert.equal(mapStatus(null, true), 'in_progress');
  });

  it('inspected status maps directly to inspected', () => {
    assert.equal(mapStatus('inspected', false), 'inspected');
  });

  it('any _clean suffix maps to clean', () => {
    assert.equal(mapStatus('vacant_clean', false), 'clean');
    assert.equal(mapStatus('occupied_clean', false), 'clean');
  });

  it('steady-state occupied maps to clean (no work today)', () => {
    assert.equal(mapStatus('occupied', false), 'clean');
  });

  it('dirty variants map to dirty', () => {
    assert.equal(mapStatus('vacant_dirty', false), 'dirty');
    assert.equal(mapStatus('occupied_dirty', false), 'dirty');
  });

  it('out_of_order / out_of_inventory map to dirty', () => {
    assert.equal(mapStatus('out_of_order', false), 'dirty');
    assert.equal(mapStatus('out_of_inventory', false), 'dirty');
  });

  it('unknown / null map to dirty', () => {
    assert.equal(mapStatus('unknown', false), 'dirty');
    assert.equal(mapStatus(null, false), 'dirty');
    assert.equal(mapStatus(undefined, false), 'dirty');
  });
});

describe('mapType + reverseMapType', () => {
  it('maps cleaning_type → RoomType', () => {
    assert.equal(mapType('departure'), 'checkout');
    assert.equal(mapType('stayover'), 'stayover');
    assert.equal(mapType('deep'), 'vacant');
    assert.equal(mapType(null), 'vacant');
  });

  it('reverses RoomType → cleaning_type', () => {
    assert.equal(reverseMapType('checkout'), 'departure');
    assert.equal(reverseMapType('stayover'), 'stayover');
    assert.equal(reverseMapType('vacant'), null);
    assert.equal(reverseMapType(undefined), null);
  });
});

describe('formatArrivalMDY', () => {
  it('strips leading zeros', () => {
    assert.equal(formatArrivalMDY('2026-05-24'), '5/24/26');
  });

  it('handles double-digit month + day', () => {
    assert.equal(formatArrivalMDY('2026-12-15'), '12/15/26');
  });
});

describe('daysBetween', () => {
  it('returns 0 for same day', () => {
    assert.equal(daysBetween('2026-05-24', '2026-05-24'), 0);
  });

  it('returns positive diff when toIso is later', () => {
    assert.equal(daysBetween('2026-05-20', '2026-05-24'), 4);
  });

  it('crosses month boundary correctly', () => {
    assert.equal(daysBetween('2026-04-30', '2026-05-02'), 2);
  });

  it('returns 0 for invalid inputs', () => {
    assert.equal(daysBetween('not-a-date', '2026-05-24'), 0);
  });
});

describe('normalizeName — fuzzy match preparation', () => {
  it('lower-cases + trims', () => {
    assert.equal(normalizeName('  Maria Smith  '), 'maria smith');
  });

  it('collapses internal whitespace', () => {
    assert.equal(normalizeName('Maria   Smith'), 'maria smith');
    assert.equal(normalizeName('Maria\tSmith'), 'maria smith');
  });

  it('strips diacritics so María matches Maria', () => {
    assert.equal(normalizeName('María'), 'maria');
    assert.equal(normalizeName('Maria'), 'maria');
    assert.equal(normalizeName('JOSÉ'), 'jose');
  });

  it('returns empty string for null/undefined/empty/whitespace', () => {
    assert.equal(normalizeName(null), '');
    assert.equal(normalizeName(undefined), '');
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName('   '), '');
  });

  it('produces the same key for PMS-vs-staff drift', () => {
    // Real-world drift cases:
    assert.equal(normalizeName('Maria  Smith'), normalizeName('maria smith'));
    assert.equal(normalizeName('María'), normalizeName('Maria'));
    assert.equal(normalizeName('  Rosa Pérez '), normalizeName('rosa perez'));
  });
});

describe('composeRoomId + parseRoomId — round-trip', () => {
  it('round-trips a typical (date, room_number) tuple', () => {
    const id = composeRoomId('2026-05-25', '201');
    const parsed = parseRoomId(id);
    assert.deepEqual(parsed, { date: '2026-05-25', roomNumber: '201' });
  });

  it('handles alphanumeric room numbers', () => {
    const id = composeRoomId('2026-05-25', '201A');
    const parsed = parseRoomId(id);
    assert.deepEqual(parsed, { date: '2026-05-25', roomNumber: '201A' });
  });

  it('rejects shapes that do not match', () => {
    assert.equal(parseRoomId('phantom-201'), null);
    assert.equal(parseRoomId('not-a-composite'), null);
    assert.equal(parseRoomId(''), null);
    assert.equal(parseRoomId('not-a-date:201'), null);
  });

  it('preserves room numbers that contain colons (only the first split)', () => {
    const id = composeRoomId('2026-05-25', '201:wing-A');
    const parsed = parseRoomId(id);
    assert.deepEqual(parsed, { date: '2026-05-25', roomNumber: '201:wing-A' });
  });
});
