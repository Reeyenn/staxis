/**
 * feature/housekeeping-levels (2026-07-24) — behavior tests for the one-time
 * Housekeeping questionnaire rules. Pure-function tests, no DB, no React.
 *
 * Three things in this module can hurt a real hotel, so they get the hardest
 * tests:
 *
 *   1. THE DOUBLE-ENTRY LOCK (`isLevelOfferable`). Level 3 puts housekeepers on
 *      phones tapping "done". For a hotel whose housekeepers ALREADY record room
 *      status themselves (room-phone code, or their own login), that tap is the
 *      same person recording the same fact twice. Double entry is the one thing
 *      this product must never introduce — it is why nobody uses tools like
 *      this. If this rule breaks, we ship a level that quietly makes people do
 *      their job twice, and we'd only find out when the hotel stopped using it.
 *
 *   2. `parseHousekeepingSetup` MUST BE TOTAL. It reads a stored jsonb blob that
 *      a migration, a hand-edit, or an older version of this code may have left
 *      malformed. If it throws, the Housekeeping page white-screens for a hotel
 *      whose crew is standing in a corridor waiting for their board. Nothing —
 *      no input at all — may throw.
 *
 *   3. `isHousekeepingSetupComplete` is the gate in front of the whole section.
 *      A false positive locks a hotel out of ever answering the questions and
 *      leaves them on default room times they never agreed to (which silently
 *      drives the labor-cost math). A false negative traps a set-up hotel in the
 *      questionnaire on every single visit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hkst } from '../../app/housekeeping/_components/_hk-setup-i18n';

import {
  isLevelOfferable,
  levelLockReason,
  recommendLevel,
  parseHousekeepingSetup,
  isHousekeepingSetupComplete,
  validateSetupSubmission,
  isValidCleanMinutes,
  isValidShiftStart,
  HK_LEVELS,
  STATUS_ENTRY_METHODS,
  BOARD_BUILT_BY_OPTIONS,
  DEFAULT_CHECKOUT_MINUTES,
  DEFAULT_STAYOVER_MINUTES,
  DEFAULT_SHIFT_START,
  type HousekeepingSetup,
  type StatusEntryMethod,
  type BoardBuiltBy,
} from '@/lib/housekeeping/setup-gate';

/** A complete, valid submission body. Individual tests break one field at a time. */
function goodSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level: 1,
    statusEntry: 'housekeeper_radio',
    checkoutMinutes: 30,
    stayoverMinutes: 20,
    shiftStartTime: '08:00',
    boardBuiltBy: 'gm',
    inspection: 'spot_check',
    sideDuties: ['laundry'],
    boardPhotoPath: null,
    completedAt: '2026-07-24T15:00:00.000Z',
    ...over,
  };
}

/** Unwrap a submission expected to succeed, failing loudly with the real error. */
function expectValue(raw: unknown): HousekeepingSetup {
  const res = validateSetupSubmission(raw);
  if ('error' in res) assert.fail(`expected success, got error: ${res.error}`);
  return res.value;
}

/** Unwrap a submission expected to fail, failing loudly if it was accepted. */
function expectError(raw: unknown): string {
  const res = validateSetupSubmission(raw);
  if (!('error' in res)) assert.fail(`expected an error, got a value: ${JSON.stringify(res.value)}`);
  return res.error;
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('isLevelOfferable — the double-entry lock (the product thesis)', () => {
  test('level 3 is LOCKED when housekeepers already enter status themselves', () => {
    // The whole reason this questionnaire exists. Asking a housekeeper who
    // already dials a code on the room phone to also tap "done" in Staxis is
    // making her do the job twice.
    assert.equal(isLevelOfferable(3, 'housekeeper_direct'), false);
  });

  test('level 3 IS offerable for every other way status gets entered', () => {
    // Radio-to-front-desk and supervisor-enters are exactly the hotels where a
    // crew tap REPLACES a radio call rather than adding to it.
    assert.equal(isLevelOfferable(3, 'housekeeper_radio'), true);
    assert.equal(isLevelOfferable(3, 'supervisor_keys'), true);
    // 'unsure' stays offerable on purpose: better to offer and let them decline
    // than to block a hotel out of a level because nobody knew on day one.
    assert.equal(isLevelOfferable(3, 'unsure'), true);
  });

  test('levels 1 and 2 are offerable for EVERY status-entry answer', () => {
    // Level 1 is manager-only and level 2 replaces the head housekeeper's
    // notebook — neither can ever create double entry, so neither may ever lock.
    for (const entry of STATUS_ENTRY_METHODS) {
      assert.equal(isLevelOfferable(1, entry), true, `level 1 must be offerable for ${entry}`);
      assert.equal(isLevelOfferable(2, entry), true, `level 2 must be offerable for ${entry}`);
    }
  });

  test('exactly one (level, statusEntry) pair in the whole matrix is locked', () => {
    // Belt-and-braces over the full cross-product: if a refactor widened or
    // narrowed the lock, this catches it even if the cases above were updated.
    const locked: string[] = [];
    for (const level of HK_LEVELS) {
      for (const entry of STATUS_ENTRY_METHODS) {
        if (!isLevelOfferable(level, entry)) locked.push(`${level}/${entry}`);
      }
    }
    assert.deepEqual(locked, ['3/housekeeper_direct']);
  });
});

describe('levelLockReason — what the padlock says', () => {
  test('locked level 3 reports the double-entry reason', () => {
    assert.equal(levelLockReason(3, 'housekeeper_direct'), 'double_entry');
  });

  test('null whenever the level is actually offerable', () => {
    assert.equal(levelLockReason(3, 'housekeeper_radio'), null);
    assert.equal(levelLockReason(1, 'housekeeper_direct'), null);
    assert.equal(levelLockReason(2, 'housekeeper_direct'), null);
  });

  test('the reason agrees with isLevelOfferable across the whole matrix', () => {
    // The UI explains the padlock from this; if the two ever disagree a hotel
    // sees a locked card with no explanation, or an explanation with no lock.
    for (const level of HK_LEVELS) {
      for (const entry of STATUS_ENTRY_METHODS) {
        const offerable = isLevelOfferable(level, entry);
        assert.equal(levelLockReason(level, entry) === null, offerable, `${level}/${entry}`);
      }
    }
  });
});

describe('recommendLevel — what we pre-select on the final screen', () => {
  test('level 2 when a head housekeeper already builds the board', () => {
    // She keeps the notebook we are replacing, and her edits are what keep
    // per-person numbers honest. Winning her first is the whole strategy.
    assert.equal(recommendLevel({ statusEntry: 'housekeeper_radio', boardBuiltBy: 'head_housekeeper' }), 2);
    assert.equal(recommendLevel({ statusEntry: 'housekeeper_direct', boardBuiltBy: 'head_housekeeper' }), 2);
    assert.equal(recommendLevel({ statusEntry: 'unsure', boardBuiltBy: 'head_housekeeper' }), 2);
  });

  test('level 1 when the GM, nobody, or an unknown person builds the board', () => {
    assert.equal(recommendLevel({ statusEntry: 'housekeeper_radio', boardBuiltBy: 'gm' }), 1);
    assert.equal(recommendLevel({ statusEntry: 'supervisor_keys', boardBuiltBy: 'nobody' }), 1);
    assert.equal(recommendLevel({ statusEntry: 'unsure', boardBuiltBy: 'unsure' }), 1);
  });

  test('NEVER recommends level 3 — for any combination of answers', () => {
    // Putting the whole crew on phones is a real change to real people's day.
    // It has to be an opt-in climb once they trust us, never something we
    // quietly pre-select on day one.
    for (const statusEntry of STATUS_ENTRY_METHODS) {
      for (const boardBuiltBy of BOARD_BUILT_BY_OPTIONS) {
        assert.notEqual(
          recommendLevel({ statusEntry, boardBuiltBy }),
          3,
          `recommended 3 for ${statusEntry}/${boardBuiltBy}`,
        );
      }
    }
  });

  test('never recommends a level that is locked for those answers', () => {
    // The cross-field invariant most likely to break in a refactor: someone
    // relaxes the "never 3" rule without re-checking offerability, and a
    // 'housekeeper_direct' hotel gets double entry pre-selected for them.
    for (const statusEntry of STATUS_ENTRY_METHODS) {
      for (const boardBuiltBy of BOARD_BUILT_BY_OPTIONS) {
        const rec = recommendLevel({ statusEntry, boardBuiltBy });
        assert.equal(
          isLevelOfferable(rec, statusEntry),
          true,
          `recommended locked level ${rec} for ${statusEntry}/${boardBuiltBy}`,
        );
      }
    }
  });
});

describe('isValidCleanMinutes — the number the money math rests on', () => {
  test('accepts whole minutes inside 5..240 including the exact bounds', () => {
    assert.equal(isValidCleanMinutes(5), true);
    assert.equal(isValidCleanMinutes(30), true);
    assert.equal(isValidCleanMinutes(240), true);
  });

  test('rejects out-of-range, fractional, non-finite and non-number input', () => {
    // A fat-fingered 3000 or a stray NaN here would turn earned-hours-vs-paid
    // -hours into nonsense that still renders as a confident dollar figure.
    assert.equal(isValidCleanMinutes(4), false);
    assert.equal(isValidCleanMinutes(241), false);
    assert.equal(isValidCleanMinutes(0), false);
    assert.equal(isValidCleanMinutes(-30), false);
    assert.equal(isValidCleanMinutes(30.5), false);
    assert.equal(isValidCleanMinutes(NaN), false);
    assert.equal(isValidCleanMinutes(Infinity), false);
    assert.equal(isValidCleanMinutes(-Infinity), false);
    assert.equal(isValidCleanMinutes('30'), false); // a string means the form was never parsed
    assert.equal(isValidCleanMinutes(null), false);
    assert.equal(isValidCleanMinutes(undefined), false);
  });
});

describe('isValidShiftStart', () => {
  test('accepts zero-padded 24-hour times', () => {
    assert.equal(isValidShiftStart('08:00'), true);
    assert.equal(isValidShiftStart('00:00'), true);
    assert.equal(isValidShiftStart('23:59'), true);
  });

  test('rejects malformed times', () => {
    assert.equal(isValidShiftStart('8:00'), false); // strict two-digit hour
    assert.equal(isValidShiftStart('24:00'), false);
    assert.equal(isValidShiftStart('25:00'), false);
    assert.equal(isValidShiftStart('08:60'), false);
    assert.equal(isValidShiftStart('0800'), false);
    assert.equal(isValidShiftStart('ab:cd'), false);
    assert.equal(isValidShiftStart(''), false);
    assert.equal(isValidShiftStart(800), false);
    assert.equal(isValidShiftStart(null), false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('parseHousekeepingSetup — must be TOTAL (a corrupt row must not white-screen)', () => {
  test('null for anything that cannot be a setup blob at all', () => {
    // These all read as "the questionnaire has not been done" — always
    // recoverable, because the hotel just answers six short questions.
    assert.equal(parseHousekeepingSetup(null), null);
    assert.equal(parseHousekeepingSetup(undefined), null);
    assert.equal(parseHousekeepingSetup(0), null);
    assert.equal(parseHousekeepingSetup(''), null);
    assert.equal(parseHousekeepingSetup('{}'), null); // a JSON *string*, never parsed
    assert.equal(parseHousekeepingSetup([]), null);
    assert.equal(parseHousekeepingSetup([{ level: 1 }]), null);
    assert.equal(parseHousekeepingSetup(true), null);
    assert.equal(parseHousekeepingSetup(NaN), null);
  });

  test('an unrecognised schema version is null, not a guess', () => {
    // Guessing at a future shape is worse than re-asking six questions.
    assert.equal(parseHousekeepingSetup({ version: 2, level: 3 }), null);
    assert.equal(parseHousekeepingSetup({ version: 0 }), null);
    assert.equal(parseHousekeepingSetup({ version: '1' }), null);
    assert.equal(parseHousekeepingSetup({ version: null }), null);
  });

  test('an empty object yields a fully-formed setup on safe defaults', () => {
    // Never a half-built object: every field is present and of the right type,
    // so no downstream screen has to null-check its way through the record.
    assert.deepEqual(parseHousekeepingSetup({}), {
      version: 1,
      completedAt: null,
      level: 1,
      recommendedLevel: 1,
      statusEntry: 'unsure',
      checkoutMinutes: DEFAULT_CHECKOUT_MINUTES,
      stayoverMinutes: DEFAULT_STAYOVER_MINUTES,
      shiftStartTime: DEFAULT_SHIFT_START,
      boardBuiltBy: 'unsure',
      inspection: 'none',
      sideDuties: [],
      boardPhotoPath: null,
    });
  });

  test('every single field the wrong type still yields a fully-formed setup', () => {
    const parsed = parseHousekeepingSetup({
      completedAt: 12345,
      level: 'two',
      recommendedLevel: { n: 3 },
      statusEntry: 99,
      checkoutMinutes: 'thirty',
      stayoverMinutes: [20],
      shiftStartTime: 800,
      boardBuiltBy: false,
      inspection: null,
      sideDuties: 'laundry',
      boardPhotoPath: { path: 'x' },
    });
    assert.deepEqual(parsed, {
      version: 1,
      completedAt: null,
      level: 1,
      recommendedLevel: 1,
      statusEntry: 'unsure',
      checkoutMinutes: DEFAULT_CHECKOUT_MINUTES,
      stayoverMinutes: DEFAULT_STAYOVER_MINUTES,
      shiftStartTime: DEFAULT_SHIFT_START,
      boardBuiltBy: 'unsure',
      inspection: 'none',
      sideDuties: [],
      boardPhotoPath: null,
    });
  });

  test('unknown enum members fall back instead of crashing the page', () => {
    // The realistic corruption: an option we renamed or removed later.
    const parsed = parseHousekeepingSetup({
      statusEntry: 'carrier_pigeon',
      boardBuiltBy: 'the_owner',
      inspection: 'sometimes',
      level: 4,
      recommendedLevel: 0,
    });
    assert.ok(parsed);
    assert.equal(parsed.statusEntry, 'unsure');
    assert.equal(parsed.boardBuiltBy, 'unsure');
    assert.equal(parsed.inspection, 'none');
    assert.equal(parsed.level, 1);
    assert.equal(parsed.recommendedLevel, 1);
  });

  test('bad minutes fall back to the prefilled defaults', () => {
    const cases = [NaN, Infinity, -Infinity, -30, 0, 4, 241, 30.5, '30'];
    for (const bad of cases) {
      const parsed = parseHousekeepingSetup({ checkoutMinutes: bad, stayoverMinutes: bad });
      assert.ok(parsed, `returned null for ${String(bad)}`);
      assert.equal(parsed.checkoutMinutes, DEFAULT_CHECKOUT_MINUTES, `checkout for ${String(bad)}`);
      assert.equal(parsed.stayoverMinutes, DEFAULT_STAYOVER_MINUTES, `stayover for ${String(bad)}`);
    }
  });

  test('a malformed shift start falls back to 08:00', () => {
    for (const bad of ['25:00', '8:00', '0800', 'ab:cd', '', '08:60', 800, null]) {
      const parsed = parseHousekeepingSetup({ shiftStartTime: bad });
      assert.ok(parsed);
      assert.equal(parsed.shiftStartTime, DEFAULT_SHIFT_START, `for ${String(bad)}`);
    }
  });

  test('good values are preserved verbatim', () => {
    const parsed = parseHousekeepingSetup({
      version: 1,
      completedAt: '2026-07-24T15:00:00.000Z',
      level: 2,
      recommendedLevel: 2,
      statusEntry: 'supervisor_keys',
      checkoutMinutes: 45,
      stayoverMinutes: 25,
      shiftStartTime: '07:30',
      boardBuiltBy: 'head_housekeeper',
      inspection: 'every_room',
      sideDuties: ['breakfast', 'laundry'],
      boardPhotoPath: 'boards/prop-1/2026-07-24.jpg',
    });
    assert.deepEqual(parsed, {
      version: 1,
      completedAt: '2026-07-24T15:00:00.000Z',
      level: 2,
      recommendedLevel: 2,
      statusEntry: 'supervisor_keys',
      checkoutMinutes: 45,
      stayoverMinutes: 25,
      shiftStartTime: '07:30',
      boardBuiltBy: 'head_housekeeper',
      inspection: 'every_room',
      sideDuties: ['laundry', 'breakfast'], // canonical order, not input order
      boardPhotoPath: 'boards/prop-1/2026-07-24.jpg',
    });
  });

  test('a stored level 3 is clamped to 2 when housekeepers enter status themselves', () => {
    // The read-side half of the double-entry lock. This row can only come from
    // a hand-edit or from the hotel changing its Q1 answer later — either way,
    // rendering it as level 3 would put housekeepers into double entry.
    const parsed = parseHousekeepingSetup({
      level: 3,
      statusEntry: 'housekeeper_direct',
      completedAt: '2026-07-24T15:00:00.000Z',
    });
    assert.ok(parsed);
    assert.equal(parsed.level, 2);
  });

  test('a stored level 3 survives for EVERY answer that allows it', () => {
    // The clamp must not be over-eager. A hotel that genuinely climbed to level 3
    // must not be quietly demoted to level 2 on every page load — the crew would
    // open the app one morning and find the board gone off their phones.
    for (const entry of ['housekeeper_radio', 'supervisor_keys', 'unsure'] as StatusEntryMethod[]) {
      const parsed = parseHousekeepingSetup({ level: 3, statusEntry: entry });
      assert.ok(parsed);
      assert.equal(parsed.level, 3, `level 3 was demoted for ${entry}`);
    }
  });

  test('the clamp still applies when statusEntry itself is corrupt', () => {
    // Corrupt statusEntry becomes 'unsure', which is offerable, so level 3 is
    // kept. Pinning this because "unsure blocks level 3" would silently demote
    // real level-3 hotels the day someone tightens the fallback.
    const parsed = parseHousekeepingSetup({ level: 3, statusEntry: 'nonsense' });
    assert.ok(parsed);
    assert.equal(parsed.statusEntry, 'unsure');
    assert.equal(parsed.level, 3);
  });

  test('side duties are deduped, sorted, and stripped of unknown members', () => {
    const parsed = parseHousekeepingSetup({
      sideDuties: ['shuttle', 'laundry', 'laundry', 'gardening', null, 7, 'lobby'],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.sideDuties, ['laundry', 'lobby', 'shuttle']);
  });

  test('two equivalent duty lists parse to identical JSON (deterministic)', () => {
    // Later screens compare saved setups; unstable ordering would show a
    // phantom "changed" every time the questionnaire is re-read.
    const a = parseHousekeepingSetup({ sideDuties: ['shuttle', 'laundry', 'breakfast'] });
    const b = parseHousekeepingSetup({ sideDuties: ['breakfast', 'breakfast', 'laundry', 'shuttle'] });
    assert.deepEqual(a?.sideDuties, b?.sideDuties);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('a non-array sideDuties becomes an empty list, not a crash', () => {
    assert.deepEqual(parseHousekeepingSetup({ sideDuties: 'laundry' })?.sideDuties, []);
    assert.deepEqual(parseHousekeepingSetup({ sideDuties: null })?.sideDuties, []);
    assert.deepEqual(parseHousekeepingSetup({ sideDuties: { laundry: true } })?.sideDuties, []);
  });

  test('a blank or non-string board photo path becomes null', () => {
    assert.equal(parseHousekeepingSetup({ boardPhotoPath: '' })?.boardPhotoPath, null);
    assert.equal(parseHousekeepingSetup({ boardPhotoPath: '   ' })?.boardPhotoPath, null);
    assert.equal(parseHousekeepingSetup({ boardPhotoPath: 42 })?.boardPhotoPath, null);
  });

  test('a blank completedAt is treated as not-finished', () => {
    assert.equal(parseHousekeepingSetup({ completedAt: '' })?.completedAt, null);
    assert.equal(parseHousekeepingSetup({ completedAt: '   ' })?.completedAt, null);
  });

  test('recommendedLevel is recomputed from the answers when it is missing', () => {
    const hh = parseHousekeepingSetup({ boardBuiltBy: 'head_housekeeper', level: 1 });
    assert.equal(hh?.recommendedLevel, 2);
    const gm = parseHousekeepingSetup({ boardBuiltBy: 'gm', level: 1 });
    assert.equal(gm?.recommendedLevel, 1);
  });

  test('a wall of hostile inputs — none of them throws', () => {
    // The contract that keeps the Housekeeping page alive for a live hotel.
    const hostile: unknown[] = [
      null,
      undefined,
      0,
      -1,
      NaN,
      Infinity,
      '',
      'null',
      '[]',
      [],
      [[]],
      true,
      false,
      Symbol('x'),
      () => {},
      new Date(),
      {},
      { version: 1 },
      { version: 99 },
      { level: Infinity, checkoutMinutes: NaN, sideDuties: [undefined, Symbol('d')] },
      { completedAt: {}, statusEntry: [], boardBuiltBy: 0, inspection: false },
      { shiftStartTime: '99:99', boardPhotoPath: 'x'.repeat(10_000) },
      Object.create(null),
      JSON.parse('{"level":3,"statusEntry":"housekeeper_direct"}'),
    ];
    hostile.forEach((input, i) => {
      // NB: label by index — some of these (a null-prototype object) throw on
      // String() themselves, which is exactly the kind of value that reaches a
      // parser from JSON.parse and must not be assumed stringifiable.
      assert.doesNotThrow(() => parseHousekeepingSetup(input), `parse threw on hostile[${i}]`);
      assert.doesNotThrow(() => isHousekeepingSetupComplete(input), `complete threw on hostile[${i}]`);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('isHousekeepingSetupComplete — the gate in front of Housekeeping', () => {
  test('true only for a genuinely finished record', () => {
    assert.equal(
      isHousekeepingSetupComplete({
        version: 1,
        completedAt: '2026-07-24T15:00:00.000Z',
        level: 1,
        statusEntry: 'housekeeper_radio',
        checkoutMinutes: 30,
        stayoverMinutes: 20,
        shiftStartTime: '08:00',
        boardBuiltBy: 'gm',
        inspection: 'none',
        sideDuties: [],
        boardPhotoPath: null,
      }),
      true,
    );
  });

  test('a validated submission always satisfies the gate (no infinite wizard loop)', () => {
    // The round trip that matters: whatever we persist must read back as done,
    // or the hotel answers the questionnaire again on every single visit.
    const saved = expectValue(goodSubmission());
    assert.equal(isHousekeepingSetupComplete(saved), true);
  });

  test('false for a NULL column, junk, or a half-written blob', () => {
    // A false POSITIVE here is the dangerous direction: it locks a hotel out of
    // ever answering the questions and leaves them on default room times they
    // never agreed to, which silently drives every labor-cost number.
    assert.equal(isHousekeepingSetupComplete(null), false);
    assert.equal(isHousekeepingSetupComplete(undefined), false);
    assert.equal(isHousekeepingSetupComplete({}), false);
    assert.equal(isHousekeepingSetupComplete([]), false);
    assert.equal(isHousekeepingSetupComplete('done'), false);
    assert.equal(isHousekeepingSetupComplete(0), false);
    assert.equal(isHousekeepingSetupComplete({ level: 2, statusEntry: 'supervisor_keys' }), false);
  });

  test('false for an absent, empty or non-string completedAt', () => {
    assert.equal(isHousekeepingSetupComplete({ completedAt: null }), false);
    assert.equal(isHousekeepingSetupComplete({ completedAt: '' }), false);
    assert.equal(isHousekeepingSetupComplete({ completedAt: '   ' }), false);
    assert.equal(isHousekeepingSetupComplete({ completedAt: 1_753_000_000_000 }), false);
    assert.equal(isHousekeepingSetupComplete({ completedAt: true }), false);
  });

  test('false when the blob carries an unrecognised schema version', () => {
    // Unparseable => re-ask. Answering six questions again is recoverable;
    // running on a shape we cannot read is not.
    assert.equal(
      isHousekeepingSetupComplete({ version: 2, completedAt: '2026-07-24T15:00:00.000Z' }),
      false,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('validateSetupSubmission — strict on the way into the database', () => {
  test('accepts a good submission and returns it fully normalized', () => {
    const value = expectValue(
      goodSubmission({ sideDuties: ['shuttle', 'laundry', 'laundry'], boardPhotoPath: '  boards/a.jpg  ' }),
    );
    assert.deepEqual(value, {
      version: 1,
      completedAt: '2026-07-24T15:00:00.000Z',
      level: 1,
      recommendedLevel: 1,
      statusEntry: 'housekeeper_radio',
      checkoutMinutes: 30,
      stayoverMinutes: 20,
      shiftStartTime: '08:00',
      boardBuiltBy: 'gm',
      inspection: 'spot_check',
      sideDuties: ['laundry', 'shuttle'],
      boardPhotoPath: 'boards/a.jpg',
    });
  });

  test('REJECTS a submission that chooses a locked level', () => {
    // The real boundary. The UI hides level 3 for these hotels, but a browser
    // can POST anything — accepting it would put housekeepers into double entry
    // with the UI showing nothing wrong.
    const err = expectError(goodSubmission({ level: 3, statusEntry: 'housekeeper_direct' }));
    assert.match(err, /housekeepers already enter room status/i);
  });

  test('accepts level 3 for every hotel that is genuinely eligible', () => {
    // The rejection above must be about the lock, not a blanket ban on level 3.
    for (const entry of ['housekeeper_radio', 'supervisor_keys', 'unsure'] as StatusEntryMethod[]) {
      assert.equal(expectValue(goodSubmission({ level: 3, statusEntry: entry })).level, 3, `for ${entry}`);
    }
  });

  test('levels 1 and 2 are still accepted at a direct-entry hotel', () => {
    // The lock has to be surgical. A hotel whose housekeepers enter their own
    // room status is still a perfectly good "Staxis plans it" / "head
    // housekeeper runs her day in it" customer — an over-broad rejection here
    // would refuse the setup outright and shut a whole class of hotels out of
    // the product, which is a far bigger loss than the one locked option.
    assert.equal(expectValue(goodSubmission({ level: 1, statusEntry: 'housekeeper_direct' })).level, 1);
    assert.equal(expectValue(goodSubmission({ level: 2, statusEntry: 'housekeeper_direct' })).level, 2);
  });

  test('rejects a missing or malformed statusEntry, naming the field', () => {
    assert.match(expectError(goodSubmission({ statusEntry: undefined })), /statusEntry/);
    assert.match(expectError(goodSubmission({ statusEntry: 'carrier_pigeon' })), /statusEntry/);
    assert.match(expectError(goodSubmission({ statusEntry: null })), /statusEntry/);
  });

  test('rejects bad room times, naming the field — never coerces them', () => {
    // Coercing a typo into a plausible default here would hand the hotel a
    // confident dollar figure built on a number nobody chose.
    assert.match(expectError(goodSubmission({ checkoutMinutes: undefined })), /checkoutMinutes/);
    assert.match(expectError(goodSubmission({ checkoutMinutes: 0 })), /checkoutMinutes/);
    assert.match(expectError(goodSubmission({ checkoutMinutes: 241 })), /checkoutMinutes/);
    assert.match(expectError(goodSubmission({ checkoutMinutes: 30.5 })), /checkoutMinutes/);
    assert.match(expectError(goodSubmission({ checkoutMinutes: '30' })), /checkoutMinutes/);
    assert.match(expectError(goodSubmission({ checkoutMinutes: NaN })), /checkoutMinutes/);
    assert.match(expectError(goodSubmission({ stayoverMinutes: -5 })), /stayoverMinutes/);
    assert.match(expectError(goodSubmission({ stayoverMinutes: Infinity })), /stayoverMinutes/);
  });

  test('accepts the exact 5 and 240 boundaries', () => {
    const value = expectValue(goodSubmission({ checkoutMinutes: 5, stayoverMinutes: 240 }));
    assert.equal(value.checkoutMinutes, 5);
    assert.equal(value.stayoverMinutes, 240);
  });

  test('rejects a bad shift start, naming the field', () => {
    assert.match(expectError(goodSubmission({ shiftStartTime: '8:00' })), /shiftStartTime/);
    assert.match(expectError(goodSubmission({ shiftStartTime: '25:00' })), /shiftStartTime/);
    assert.match(expectError(goodSubmission({ shiftStartTime: undefined })), /shiftStartTime/);
  });

  test('rejects a bad boardBuiltBy or inspection, naming the field', () => {
    assert.match(expectError(goodSubmission({ boardBuiltBy: 'the_owner' })), /boardBuiltBy/);
    assert.match(expectError(goodSubmission({ boardBuiltBy: undefined })), /boardBuiltBy/);
    assert.match(expectError(goodSubmission({ inspection: 'sometimes' })), /inspection/);
    assert.match(expectError(goodSubmission({ inspection: undefined })), /inspection/);
  });

  test('rejects a bad level, naming the field', () => {
    assert.match(expectError(goodSubmission({ level: undefined })), /level/);
    assert.match(expectError(goodSubmission({ level: 4 })), /level/);
    assert.match(expectError(goodSubmission({ level: '2' })), /level/);
    assert.match(expectError(goodSubmission({ recommendedLevel: 9 })), /recommendedLevel/);
  });

  test('rejects an unknown side duty rather than silently dropping it', () => {
    // A duty we do not know has no minutes model behind it. Dropping it quietly
    // would hide a client/server mismatch until the minutes stopped adding up.
    assert.match(expectError(goodSubmission({ sideDuties: ['laundry', 'gardening'] })), /sideDuties/);
    assert.match(expectError(goodSubmission({ sideDuties: 'laundry' })), /sideDuties/);
    assert.match(expectError(goodSubmission({ sideDuties: [null] })), /sideDuties/);
  });

  test('omitted or empty side duties mean "rooms only"', () => {
    assert.deepEqual(expectValue(goodSubmission({ sideDuties: undefined })).sideDuties, []);
    assert.deepEqual(expectValue(goodSubmission({ sideDuties: [] })).sideDuties, []);
    assert.deepEqual(expectValue(goodSubmission({ sideDuties: null })).sideDuties, []);
  });

  test('side duty normalisation is deterministic across equivalent inputs', () => {
    const a = expectValue(goodSubmission({ sideDuties: ['shuttle', 'lobby', 'laundry'] }));
    const b = expectValue(goodSubmission({ sideDuties: ['laundry', 'shuttle', 'lobby', 'lobby'] }));
    assert.deepEqual(a.sideDuties, b.sideDuties);
    assert.deepEqual(a.sideDuties, ['laundry', 'lobby', 'shuttle']);
  });

  test('rejects a non-object body and a wrong schema version', () => {
    assert.match(expectError(null), /object/i);
    assert.match(expectError('level=1'), /object/i);
    assert.match(expectError([]), /object/i);
    assert.match(expectError(goodSubmission({ version: 2 })), /version/);
  });

  test('skipping the board photo is always allowed', () => {
    // Q3 is skippable in one tap, so every "no photo" spelling must pass.
    assert.equal(expectValue(goodSubmission({ boardPhotoPath: null })).boardPhotoPath, null);
    assert.equal(expectValue(goodSubmission({ boardPhotoPath: undefined })).boardPhotoPath, null);
    assert.equal(expectValue(goodSubmission({ boardPhotoPath: '' })).boardPhotoPath, null);
    assert.equal(expectValue(goodSubmission({ boardPhotoPath: '   ' })).boardPhotoPath, null);
  });

  test('rejects a non-string or over-long board photo path', () => {
    assert.match(expectError(goodSubmission({ boardPhotoPath: 42 })), /boardPhotoPath/);
    assert.match(expectError(goodSubmission({ boardPhotoPath: 'x'.repeat(501) })), /boardPhotoPath/);
    assert.equal(expectValue(goodSubmission({ boardPhotoPath: 'x'.repeat(500) })).boardPhotoPath, 'x'.repeat(500));
  });

  test('recommendedLevel is recomputed when the client omits it', () => {
    const hh = expectValue(goodSubmission({ boardBuiltBy: 'head_housekeeper', recommendedLevel: undefined }));
    assert.equal(hh.recommendedLevel, 2);
    const gm = expectValue(goodSubmission({ boardBuiltBy: 'gm', recommendedLevel: undefined }));
    assert.equal(gm.recommendedLevel, 1);
  });

  test('the chosen level is kept even when it differs from the recommendation', () => {
    // The gap between what we suggest and what hotels pick is the only signal
    // we will ever get about whether the recommendation rule is any good, so an
    // override must never be flattened back to the suggestion.
    const value = expectValue(goodSubmission({ level: 3, boardBuiltBy: 'head_housekeeper' }));
    assert.equal(value.level, 3);
    assert.equal(value.recommendedLevel, 2);
  });

  test('completedAt is stamped when the client omits it', () => {
    // If this were left null the hotel would be handed straight back into the
    // questionnaire after finishing it.
    const before = Date.now();
    const value = expectValue(goodSubmission({ completedAt: undefined }));
    const after = Date.now();
    assert.equal(typeof value.completedAt, 'string');
    const stamped = Date.parse(value.completedAt as string);
    assert.ok(stamped >= before - 1000 && stamped <= after + 1000, `stamp out of range: ${value.completedAt}`);
    assert.equal(isHousekeepingSetupComplete(value), true);
  });

  test('rejects a present-but-unparseable completedAt', () => {
    assert.match(expectError(goodSubmission({ completedAt: 'yesterday' })), /completedAt/);
    assert.match(expectError(goodSubmission({ completedAt: '' })), /completedAt/);
    assert.match(expectError(goodSubmission({ completedAt: 12345 })), /completedAt/);
  });

  test('a validated value round-trips through the reader unchanged', () => {
    // Write then read is what actually happens in production. If these two ever
    // disagree, a hotel saves one set of answers and sees another.
    for (const statusEntry of STATUS_ENTRY_METHODS) {
      for (const boardBuiltBy of BOARD_BUILT_BY_OPTIONS) {
        const value = expectValue(
          goodSubmission({
            statusEntry,
            boardBuiltBy,
            level: 2,
            sideDuties: ['shuttle', 'laundry'],
            boardPhotoPath: 'boards/x.jpg',
          }),
        );
        assert.deepEqual(
          parseHousekeepingSetup(JSON.parse(JSON.stringify(value))),
          value,
          `round trip failed for ${statusEntry}/${boardBuiltBy}`,
        );
      }
    }
  });
});

/* Type-only sanity: the exported unions are what every other agent codes to. */
const _statusEntries: readonly StatusEntryMethod[] = STATUS_ENTRY_METHODS;
const _boardBuiltBy: readonly BoardBuiltBy[] = BOARD_BUILT_BY_OPTIONS;
void _statusEntries;
void _boardBuiltBy;

/* ─────────────────── Questionnaire copy: EN/ES parity ────────────────────
 * `_hk-setup-i18n.ts` derives its string type from the `en` map only, so the
 * `es` map is NOT type-checked: a key added to English and forgotten in
 * Spanish compiles cleanly and then renders as `undefined` on a Spanish
 * manager's screen. This is the only thing that catches that.
 */
describe('housekeeping setup copy', () => {
  const en = hkst('en') as Record<string, string>;
  const es = hkst('es') as Record<string, string>;

  test('Spanish mirrors every English key, and vice versa', () => {
    assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  });

  test('no string in either language is empty', () => {
    for (const [lang, map] of [['en', en], ['es', es]] as const) {
      for (const [key, value] of Object.entries(map)) {
        assert.equal(typeof value, 'string', `${lang}.${key} is not a string`);
        assert.notEqual(value.trim(), '', `${lang}.${key} is empty`);
      }
    }
  });

  test('an unknown language falls back to English rather than blowing up', () => {
    assert.deepEqual(hkst('de' as 'en'), en);
  });
});
