/**
 * normalizeBoardExtraction — the untrusted-output boundary of
 * POST /api/housekeeping/setup/board-photo.
 *
 * That route photographs a hotel's paper housekeeping board during first-time
 * setup and asks Claude Vision to read it. Everything the model returns is
 * untrusted: it may be the wrong shape, contain 10,000 hallucinated rooms, or
 * echo back a wall of text from the photo. This function is the only thing
 * standing between that output and the browser.
 *
 * Two rules it must never break:
 *   1. It must THROW on a top level that isn't the object we asked for, because
 *      the route turns that into `extracted: null` — the "we couldn't read it"
 *      outcome the questionnaire is designed to absorb silently.
 *   2. Below the top level it must NORMALISE rather than throw. A stray
 *      non-string in one section's room list is not a reason to discard a board
 *      we otherwise read fine, and every field is bounded so a hallucinated
 *      answer can't be echoed back at any size.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBoardExtraction } from '@/app/api/housekeeping/setup/board-photo/route';

describe('normalizeBoardExtraction', () => {
  test('throws on any top level that is not the object we asked for', () => {
    for (const bad of [null, undefined, 'sections', 42, true, [], [{ label: 'A' }]]) {
      assert.throws(
        () => normalizeBoardExtraction(bad),
        /top level/,
        `expected a throw for ${JSON.stringify(bad)}`,
      );
    }
  });

  test('throws when "sections" is present but not an array', () => {
    assert.throws(() => normalizeBoardExtraction({ sections: 'four of them' }), /sections/);
    assert.throws(() => normalizeBoardExtraction({ sections: { a: 1 } }), /sections/);
  });

  test('an empty board is a valid answer, not an error', () => {
    assert.deepEqual(normalizeBoardExtraction({ sections: [], floors: [] }), {
      sections: [],
      floors: [],
    });
  });

  test('missing keys read as empty rather than throwing', () => {
    assert.deepEqual(normalizeBoardExtraction({}), { sections: [], floors: [] });
    assert.deepEqual(normalizeBoardExtraction({ floors: null }), { sections: [], floors: [] });
  });

  test('reads a well-formed board through unchanged', () => {
    const out = normalizeBoardExtraction({
      sections: [
        { label: 'Section A', floor: '2', roomRange: '201-218', rooms: ['201', '202'], staffFirstName: 'Maria' },
      ],
      floors: ['2', '3'],
    });
    assert.deepEqual(out.sections, [
      { label: 'Section A', floor: '2', roomRange: '201-218', rooms: ['201', '202'], staffFirstName: 'Maria' },
    ]);
    assert.deepEqual(out.floors, ['2', '3']);
  });

  test('junk inside a section is dropped without discarding the section', () => {
    const out = normalizeBoardExtraction({
      sections: [{ label: 'A', rooms: ['201', null, 42, { x: 1 }, '202', '201'] }],
      floors: [],
    });
    assert.equal(out.sections.length, 1);
    assert.deepEqual(out.sections[0].rooms, ['201', '202'], 'non-strings dropped, duplicates collapsed');
  });

  test('non-object members of "sections" do not crash the read', () => {
    const out = normalizeBoardExtraction({
      sections: [null, 'A', 7, ['201'], { label: 'Real' }],
      floors: [],
    });
    assert.equal(out.sections.length, 1);
    assert.equal(out.sections[0].label, 'Real');
  });

  test('sections carrying no information at all are dropped', () => {
    const out = normalizeBoardExtraction({
      sections: [{}, { rooms: [] }, { label: '   ' }, { staffFirstName: 'Ana' }],
      floors: [],
    });
    assert.equal(out.sections.length, 1);
    assert.equal(out.sections[0].staffFirstName, 'Ana');
  });

  test('whitespace-only fields become null instead of empty strings', () => {
    const out = normalizeBoardExtraction({
      sections: [{ label: '  ', floor: '2', roomRange: '', staffFirstName: '\t' }],
      floors: ['  ', '2'],
    });
    assert.equal(out.sections[0].label, null);
    assert.equal(out.sections[0].roomRange, null);
    assert.equal(out.sections[0].staffFirstName, null);
    assert.equal(out.sections[0].floor, '2');
    assert.deepEqual(out.floors, ['2']);
  });

  test('floors are deduplicated', () => {
    assert.deepEqual(
      normalizeBoardExtraction({ sections: [], floors: ['2', '2', '3', '2'] }).floors,
      ['2', '3'],
    );
  });

  test('a hallucinated answer is capped at every level', () => {
    const out = normalizeBoardExtraction({
      sections: Array.from({ length: 500 }, (_, i) => ({
        label: `S${i}`,
        rooms: Array.from({ length: 300 }, (_, j) => `r${j}`),
      })),
      floors: Array.from({ length: 200 }, (_, i) => `F${i}`),
    });
    assert.equal(out.sections.length, 40, 'sections capped');
    assert.equal(out.sections[0].rooms.length, 60, 'rooms per section capped');
    assert.equal(out.floors.length, 20, 'floors capped');
  });

  test('a wall of text in one field is truncated, not echoed back', () => {
    const out = normalizeBoardExtraction({
      sections: [{ label: 'x'.repeat(10_000), rooms: ['y'.repeat(10_000)] }],
      floors: [],
    });
    assert.equal(out.sections[0].label!.length, 60);
    assert.equal(out.sections[0].rooms[0].length, 60);
  });
});
