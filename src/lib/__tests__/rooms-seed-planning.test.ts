/**
 * Tests for the pure planning helpers extracted from seedRoomsForDate.
 *
 * Round 15 (2026-05-14). seedRoomsForDate itself does Supabase IO and
 * is hard to unit-test without a DB or a heavy mock framework. The
 * decision logic — what patch to apply, what precondition to attach,
 * what to phantom-seed — is the part that holds the merge semantics
 * (assigned_to preservation, in_progress override, race precondition).
 *
 * These pure helpers are the actual contract. If they're right and
 * seedRoomsForDate just calls them + writes the result, the seed
 * behavior is correct.
 *
 * Most-critical test: the precondition status (Round 15 race fix
 * from Codex finding B). If anyone removes `.eq('status', ...)` from
 * the seeder, planRoomPatch's preconditionStatus must still match the
 * read-time state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRoomPatch,
  planNewRoomInsert,
  planPhantomSeed,
  mapRoomType,
  mapRoomStatus,
} from '@/lib/rooms/seed';

describe('mapRoomType', () => {
  it('C/O stayType always wins → checkout', () => {
    assert.equal(mapRoomType('C/O', 'OCC'), 'checkout');
    assert.equal(mapRoomType('C/O', 'VAC'), 'checkout');
    assert.equal(mapRoomType('C/O', null), 'checkout');
  });

  it('OCC status without C/O stayType → stayover', () => {
    assert.equal(mapRoomType('Stay', 'OCC'), 'stayover');
    assert.equal(mapRoomType(null, 'OCC'), 'stayover');
  });

  it('VAC / OOO / null → vacant', () => {
    assert.equal(mapRoomType(null, 'VAC'), 'vacant');
    assert.equal(mapRoomType(null, 'OOO'), 'vacant');
    assert.equal(mapRoomType(null, null), 'vacant');
    assert.equal(mapRoomType(undefined, undefined), 'vacant');
  });
});

describe('mapRoomStatus', () => {
  it('only literal "Clean" maps to clean; everything else dirty', () => {
    assert.equal(mapRoomStatus('Clean'), 'clean');
    assert.equal(mapRoomStatus('Dirty'), 'dirty');
    assert.equal(mapRoomStatus('clean'), 'dirty');  // case-sensitive
    assert.equal(mapRoomStatus(''), 'dirty');
    assert.equal(mapRoomStatus(null), 'dirty');
    assert.equal(mapRoomStatus(undefined), 'dirty');
  });
});

describe('planRoomPatch', () => {
  it('returns CSV-derived type and status when room is dirty (no race)', () => {
    const csv = { number: '302', stayType: 'C/O', status: 'OCC', condition: 'Dirty' };
    const { patch, preconditionStatus } = planRoomPatch(csv, 'dirty');
    assert.equal(patch.type, 'checkout');
    assert.equal(patch.status, 'dirty');
    assert.equal(preconditionStatus, 'dirty');
    // dirty + !mid-clean → wipe timestamps
    assert.equal(patch.started_at, null);
    assert.equal(patch.completed_at, null);
  });

  it('preserves in_progress + skips timestamp wipe when mid-clean (95a90a3)', () => {
    // This is THE bug Maria reported on 2026-05-02. CSV says "Dirty" because
    // the PMS hasn't seen our Done tap yet; we MUST NOT wipe started_at.
    const csv = { number: '302', stayType: 'C/O', status: 'OCC', condition: 'Dirty' };
    const { patch, preconditionStatus } = planRoomPatch(csv, 'in_progress');
    // status stays in_progress, not dirty
    assert.equal(patch.status, 'in_progress');
    // timestamps NOT wiped
    assert.equal(patch.started_at, undefined);
    assert.equal(patch.completed_at, undefined);
    // precondition matches the read-time status — UPDATE will land only
    // if the row is STILL in_progress at write time
    assert.equal(preconditionStatus, 'in_progress');
  });

  it('Round 15 race-fix: preconditionStatus tracks read-time status', () => {
    // The seeder reads room as 'clean' (housekeeper finished + PMS confirmed
    // → CSV reports Clean). Patch sets status to clean. If a housekeeper
    // races to reset (status: clean → dirty), the UPDATE with
    // .eq('status', 'clean') won't land, preserving the new dirty state.
    const csv = { number: '302', stayType: 'Stay', status: 'OCC', condition: 'Clean' };
    const { preconditionStatus } = planRoomPatch(csv, 'clean');
    assert.equal(preconditionStatus, 'clean');
  });

  it('null existingStatus defaults to "dirty" for precondition', () => {
    // Defensive: schema says rooms.status NOT NULL DEFAULT 'dirty', so this
    // shouldn't happen in practice. But if it did, the precondition uses
    // the default rather than passing NULL (which PostgREST treats as IS NULL).
    const csv = { number: '302', stayType: null, status: 'VAC', condition: 'Clean' };
    const { preconditionStatus } = planRoomPatch(csv, null);
    assert.equal(preconditionStatus, 'dirty');
  });

  it('always clears issue_note and help_requested on refresh', () => {
    // Pre-existing behavior: every CSV refresh clears these flags. Round 15
    // doesn't change this. (Pre-existing race: if a housekeeper adds a note
    // and the seeder runs immediately after, the note could be cleared.
    // Out of scope for this round; the conditional UPDATE incidentally
    // protects the note during a STATUS race.)
    const csv = { number: '302', stayType: 'Stay', status: 'OCC', condition: 'Dirty' };
    const { patch } = planRoomPatch(csv, 'dirty');
    assert.equal(patch.issue_note, null);
    assert.equal(patch.help_requested, false);
  });

  it('preserves stayover_day = 0 (not coerced to null)', () => {
    // Codex Q2 nullish-coalesce nitpick: csv.stayoverDay = 0 should stay 0,
    // not get nulled by `?? null`. JavaScript's ?? only short-circuits on
    // null/undefined, so 0 passes through correctly.
    const csv = {
      number: '302',
      stayType: 'Stay',
      status: 'OCC',
      condition: 'Dirty',
      stayoverDay: 0,
    };
    const { patch } = planRoomPatch(csv, 'dirty');
    assert.equal(patch.stayover_day, 0);
  });

  it('handles missing optional fields → null', () => {
    const csv = { number: '302', stayType: 'C/O', status: 'OCC', condition: 'Dirty' };
    const { patch } = planRoomPatch(csv, 'dirty');
    assert.equal(patch.stayover_day, null);
    assert.equal(patch.stayover_minutes, null);
    assert.equal(patch.arrival, null);
  });
});

describe('planNewRoomInsert', () => {
  it('builds a complete payload for a new room', () => {
    const csv = { number: '302', stayType: 'C/O', status: 'OCC', condition: 'Dirty' };
    const payload = planNewRoomInsert(csv, 'prop-uuid', '2026-05-14');
    assert.equal(payload.property_id, 'prop-uuid');
    assert.equal(payload.number, '302');
    assert.equal(payload.date, '2026-05-14');
    assert.equal(payload.type, 'checkout');
    assert.equal(payload.status, 'dirty');
    assert.equal(payload.priority, 'standard');
  });

  it('only includes optional fields when present (matches original semantics)', () => {
    // The original code used `if (csv.stayoverDay !== null && !== undefined)`,
    // so the field was omitted for null/undefined but included for 0.
    // The refactor preserves this — 0 is included, null is omitted.
    const csvWithFields = {
      number: '302',
      stayType: 'Stay',
      status: 'OCC',
      condition: 'Dirty',
      stayoverDay: 0,
      stayoverMinutes: 30,
      arrival: '2026-05-15',
    };
    const payload = planNewRoomInsert(csvWithFields, 'p', 'd');
    assert.equal(payload.stayover_day, 0);
    assert.equal(payload.stayover_minutes, 30);
    assert.equal(payload.arrival, '2026-05-15');

    const csvBare = { number: '302', stayType: 'C/O', status: 'OCC', condition: 'Dirty' };
    const bare = planNewRoomInsert(csvBare, 'p', 'd');
    assert.equal('stayover_day' in bare, false);
    assert.equal('stayover_minutes' in bare, false);
    assert.equal('arrival' in bare, false);
  });
});

describe('planPhantomSeed', () => {
  it('returns inventory rooms missing from both CSV and DB', () => {
    const inventory = ['101', '102', '103', '104'];
    const csvNumbers = new Set(['101', '102']);
    const existingNumbers = new Set(['103']);
    const phantoms = planPhantomSeed(inventory, csvNumbers, existingNumbers);
    // 104 is the only room with no CSV mention and no existing row
    assert.deepEqual(phantoms, ['104']);
  });

  it('skips inventory rooms that are in CSV (already seeded by CSV branch)', () => {
    const inventory = ['101', '102'];
    const csvNumbers = new Set(['101', '102']);
    const existingNumbers = new Set<string>();
    assert.deepEqual(planPhantomSeed(inventory, csvNumbers, existingNumbers), []);
  });

  it('skips inventory rooms that have existing DB rows (leave untouched)', () => {
    const inventory = ['101', '102'];
    const csvNumbers = new Set<string>();
    const existingNumbers = new Set(['101', '102']);
    assert.deepEqual(planPhantomSeed(inventory, csvNumbers, existingNumbers), []);
  });

  it('returns the entire inventory when CSV is empty and DB is empty', () => {
    // This is the scenario the new seed-rooms-daily cron handles: no CSV
    // available yet, no rows for today. Phantom-seed everything as vacant.
    const inventory = ['101', '102', '103', '104'];
    const phantoms = planPhantomSeed(inventory, new Set(), new Set());
    assert.deepEqual(phantoms, ['101', '102', '103', '104']);
  });

  it('preserves inventory order', () => {
    const inventory = ['422', '421', '420', '101'];
    const phantoms = planPhantomSeed(inventory, new Set(), new Set());
    assert.deepEqual(phantoms, ['422', '421', '420', '101']);
  });

  it('empty inventory returns empty regardless of other args', () => {
    assert.deepEqual(
      planPhantomSeed([], new Set(['101']), new Set(['102'])),
      [],
    );
  });
});
