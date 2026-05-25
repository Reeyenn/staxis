/**
 * Tests for the pure helpers inside mergePmsRoomsForDate.
 *
 * These cover the logic that decides what the user sees on the manager's
 * housekeeping board:
 *   - mapStatus: PMS status_log + today's assignment → legacy RoomStatus
 *   - mapType: cleaning_type → legacy RoomType
 *   - formatArrivalMDY: ISO date → "M/D/YY" legacy badge format
 *   - daysBetween: two ISO dates → whole-day diff for stayoverDay
 *   - normalizeName: cross-source name match for staff lookup
 *
 * The full mergePmsRoomsForDate() function is integration-tested via the
 * /api/housekeeping/rooms route in production; these unit tests pin the
 * branching logic that's most error-prone and most likely to regress
 * when the writes branch lands (or when CUA adds new PMS statuses).
 *
 * Created during the post-merge adversarial sweep (2026-05-25, Codex
 * finding M9 / quality bar).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapStatus,
  mapType,
  formatArrivalMDY,
  daysBetween,
  normalizeName,
} from '@/lib/pms-rooms-server';

// Minimal AssignmentRow shape — mirrors the interface inside
// pms-rooms-server.ts. Kept here so the tests don't depend on internals
// changing.
type Assignment = {
  room_number: string;
  housekeeper_name: string | null;
  cleaning_type: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  dnd_active: boolean | null;
};

function makeAssignment(over: Partial<Assignment> = {}): Assignment {
  return {
    room_number: '201',
    housekeeper_name: 'Rosa',
    cleaning_type: 'departure',
    status: 'not_started',
    started_at: null,
    completed_at: null,
    dnd_active: null,
    ...over,
  };
}

describe('mapStatus — assignment-first derivation', () => {
  it('returns clean when assignment is completed (status="completed")', () => {
    const a = makeAssignment({ status: 'completed' });
    assert.equal(mapStatus(a, 'vacant_dirty'), 'clean');
  });

  it('returns clean when assignment has completed_at even without status', () => {
    const a = makeAssignment({ completed_at: '2026-05-25T11:00:00Z' });
    assert.equal(mapStatus(a, 'vacant_dirty'), 'clean');
  });

  it('returns in_progress when started_at set and not completed', () => {
    const a = makeAssignment({ started_at: '2026-05-25T10:30:00Z' });
    assert.equal(mapStatus(a, 'occupied_clean'), 'in_progress');
  });

  it('returns dirty when assignment exists but not_started', () => {
    const a = makeAssignment({ status: 'not_started' });
    assert.equal(mapStatus(a, 'vacant_clean'), 'dirty');
  });

  it('returns dirty when assignment refused — needs attention', () => {
    const a = makeAssignment({ status: 'refused' });
    assert.equal(mapStatus(a, 'vacant_clean'), 'dirty');
  });

  it('returns dirty when assignment skipped', () => {
    const a = makeAssignment({ status: 'skipped' });
    assert.equal(mapStatus(a, 'vacant_clean'), 'dirty');
  });
});

describe('mapStatus — fallback to status_log when no assignment', () => {
  it('returns inspected when status_log says inspected', () => {
    assert.equal(mapStatus(undefined, 'inspected'), 'inspected');
  });

  it('returns clean for any _clean suffix (vacant_clean, occupied_clean)', () => {
    assert.equal(mapStatus(undefined, 'vacant_clean'), 'clean');
    assert.equal(mapStatus(undefined, 'occupied_clean'), 'clean');
  });

  it('returns clean for steady-state occupied (no clean needed today)', () => {
    // M1 fix — previously this collapsed to 'dirty' and inflated the
    // "to turn" count.
    assert.equal(mapStatus(undefined, 'occupied'), 'clean');
  });

  it('returns dirty for vacant_dirty', () => {
    assert.equal(mapStatus(undefined, 'vacant_dirty'), 'dirty');
  });

  it('returns dirty for occupied_dirty', () => {
    assert.equal(mapStatus(undefined, 'occupied_dirty'), 'dirty');
  });

  it('returns dirty for out_of_order (WO badge layers on top)', () => {
    assert.equal(mapStatus(undefined, 'out_of_order'), 'dirty');
  });

  it('returns dirty for unknown / null', () => {
    assert.equal(mapStatus(undefined, 'unknown'), 'dirty');
    assert.equal(mapStatus(undefined, null), 'dirty');
  });
});

describe('mapType', () => {
  it('maps departure → checkout', () => {
    assert.equal(mapType('departure'), 'checkout');
  });

  it('maps stayover → stayover', () => {
    assert.equal(mapType('stayover'), 'stayover');
  });

  it('defaults unknown cleaning types to vacant', () => {
    assert.equal(mapType(null), 'vacant');
    assert.equal(mapType(undefined), 'vacant');
    assert.equal(mapType('deep'), 'vacant');
    assert.equal(mapType('arrival'), 'vacant');
  });
});

describe('formatArrivalMDY — legacy CSV badge format', () => {
  it('strips leading zeros and 2-digit year', () => {
    assert.equal(formatArrivalMDY('2026-05-24'), '5/24/26');
  });

  it('handles December correctly', () => {
    assert.equal(formatArrivalMDY('2026-12-01'), '12/1/26');
  });

  it('handles year 2030', () => {
    assert.equal(formatArrivalMDY('2030-01-15'), '1/15/30');
  });
});

describe('daysBetween — whole-day diff between ISO dates', () => {
  it('returns 0 for same day', () => {
    assert.equal(daysBetween('2026-05-24', '2026-05-24'), 0);
  });

  it('returns positive diff when toIso is later', () => {
    assert.equal(daysBetween('2026-05-20', '2026-05-24'), 4);
  });

  it('returns negative diff when toIso is earlier', () => {
    assert.equal(daysBetween('2026-05-24', '2026-05-20'), -4);
  });

  it('crosses month boundary correctly', () => {
    assert.equal(daysBetween('2026-04-30', '2026-05-02'), 2);
  });

  it('returns 0 for invalid date strings', () => {
    assert.equal(daysBetween('not-a-date', '2026-05-24'), 0);
    assert.equal(daysBetween('2026-05-24', 'not-a-date'), 0);
  });
});

describe('normalizeName — cross-source matching', () => {
  it('lower-cases and trims', () => {
    assert.equal(normalizeName('  Rosa Martinez  '), 'rosa martinez');
  });

  it('collapses internal whitespace', () => {
    assert.equal(normalizeName('Rosa   Martinez'), 'rosa martinez');
    assert.equal(normalizeName('Rosa\tMartinez'), 'rosa martinez');
  });

  it('preserves diacritics via NFC', () => {
    // "María" with composed character should match "María" with composed
    // character. We do NOT strip diacritics — staff entry should also
    // store the diacritic form. This is the safest match strategy.
    assert.equal(normalizeName('María'), 'maría');
    // Composed (NFC) and decomposed (NFD) forms reduce to the same key.
    assert.equal(normalizeName('Marı́a'), normalizeName('María'));
  });

  it('returns empty string for null/undefined/empty', () => {
    assert.equal(normalizeName(null), '');
    assert.equal(normalizeName(undefined), '');
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName('   '), '');
  });

  it('produces same key for two equivalent inputs (the whole point)', () => {
    // The PMS housekeeper name + the staff record name should match
    // after normalization, even with whitespace / casing drift.
    const pms = 'Maria  Smith';
    const staff = 'maria smith';
    assert.equal(normalizeName(pms), normalizeName(staff));
  });
});
