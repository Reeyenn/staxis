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
  resolveShiftStartHour,
  FALLBACK_SHIFT_START_HOUR,
  HK_LEVELS,
  STATUS_ENTRY_METHODS,
  BOARD_BUILT_BY_OPTIONS,
  DEFAULT_CHECKOUT_MINUTES,
  DEFAULT_STAYOVER_MINUTES,
  DEFAULT_SHIFT_START,
  MAX_CUSTOM_LABEL_LENGTH,
  MAX_CUSTOM_ROOM_TYPES,
  MAX_CUSTOM_DUTIES,
  RESERVED_ROOM_TYPE_KEYS,
  RESERVED_DUTY_KEYS,
  normalizeCustomLabel,
  customEntryKey,
  isValidCustomLabel,
  isReservedRoomTypeLabel,
  isReservedDutyLabel,
  type CustomRoomType,
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
      customRoomTypes: [],
      customDuties: [],
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
      customRoomTypes: 'Suite',
      customDuties: { laundry: true },
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
      customRoomTypes: [],
      customDuties: [],
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
      customRoomTypes: [{ label: 'Suite', minutes: 45 }],
      customDuties: ['Van runs'],
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
      customRoomTypes: [{ label: 'Suite', minutes: 45 }],
      customDuties: ['Van runs'],
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
      customRoomTypes: [],
      customDuties: [],
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

/* ══════════════════════════════════════════════════════════════════════════
 * The two "+" lists: custom room types (Q2) and custom duties (Q6).
 *
 * These were added to schema version 1 AFTER hotels had already completed the
 * questionnaire. The first describe block below is the one that matters most in
 * this whole file: if absent fields stop parsing as "complete", every hotel
 * that already finished setup gets thrown back into the seven screens.
 * ══════════════════════════════════════════════════════════════════════════ */

describe('BACKWARD COMPATIBILITY — records saved before the "+" fields existed', () => {
  /** A blob exactly as it was written the day before customRoomTypes/customDuties
   *  existed: no such keys at all. */
  function yesterdaysRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      completedAt: '2026-07-24T15:00:00.000Z',
      level: 2,
      recommendedLevel: 2,
      statusEntry: 'supervisor_keys',
      checkoutMinutes: 30,
      stayoverMinutes: 20,
      shiftStartTime: '08:00',
      boardBuiltBy: 'head_housekeeper',
      inspection: 'spot_check',
      sideDuties: ['laundry'],
      boardPhotoPath: null,
      ...over,
    };
  }

  test('a record with NEITHER new field still reads as a finished questionnaire', () => {
    // THE regression that would hurt every existing customer at once: a hotel
    // that answered all seven screens yesterday opens Housekeeping today and is
    // asked to answer them again. Recoverable only by re-doing the work, and
    // they would (rightly) conclude the product forgot them.
    const stored = yesterdaysRecord();
    assert.equal(isHousekeepingSetupComplete(stored), true);
    assert.notEqual(parseHousekeepingSetup(stored), null);
  });

  test('the schema version did NOT move — a version bump is what would re-ask them', () => {
    // parseHousekeepingSetup returns null for any unrecognised version, and null
    // means "not done". Shipping these fields as version 2 would therefore have
    // silently reset every hotel. Pinning it so nobody bumps it casually later.
    const parsed = parseHousekeepingSetup(yesterdaysRecord());
    assert.equal(parsed?.version, 1);
    assert.equal(parseHousekeepingSetup(yesterdaysRecord({ version: 2 })), null);
  });

  test('the missing fields come back as empty lists, not undefined or null', () => {
    // Downstream screens map over these. A hole would be a crash waiting for the
    // first hotel that never touched the "+".
    const parsed = parseHousekeepingSetup(yesterdaysRecord());
    assert.ok(parsed);
    assert.deepEqual(parsed.customRoomTypes, []);
    assert.deepEqual(parsed.customDuties, []);
    assert.ok(Array.isArray(parsed.customRoomTypes));
    assert.ok(Array.isArray(parsed.customDuties));
  });

  test('every other answer in an old record survives untouched', () => {
    // The new fields must be additive. If adding them shifted any existing
    // answer, a hotel would find its room times or its level quietly changed.
    const parsed = parseHousekeepingSetup(yesterdaysRecord());
    assert.deepEqual(parsed, {
      version: 1,
      completedAt: '2026-07-24T15:00:00.000Z',
      level: 2,
      recommendedLevel: 2,
      statusEntry: 'supervisor_keys',
      checkoutMinutes: 30,
      stayoverMinutes: 20,
      shiftStartTime: '08:00',
      boardBuiltBy: 'head_housekeeper',
      inspection: 'spot_check',
      sideDuties: ['laundry'],
      customRoomTypes: [],
      customDuties: [],
      boardPhotoPath: null,
    });
  });

  test('an old record re-submitted without the new fields is still accepted', () => {
    // The realistic path when a manager edits one answer from a screen built
    // before the "+" shipped: the payload simply has no such keys.
    const value = expectValue(goodSubmission({ customRoomTypes: undefined, customDuties: undefined }));
    assert.deepEqual(value.customRoomTypes, []);
    assert.deepEqual(value.customDuties, []);
    assert.equal(isHousekeepingSetupComplete(value), true);
  });

  test('null is accepted for both lists too (an over-eager client)', () => {
    const value = expectValue(goodSubmission({ customRoomTypes: null, customDuties: null }));
    assert.deepEqual(value.customRoomTypes, []);
    assert.deepEqual(value.customDuties, []);
  });
});

describe('custom room types + duties — round trip through validate then parse', () => {
  test('what a hotel enters is what comes back out', () => {
    // Write-then-read is what production actually does. If these two disagree,
    // a manager saves "Suite 45" and the next page load shows him something else.
    const value = expectValue(
      goodSubmission({
        customRoomTypes: [
          { label: 'Suite', minutes: 45 },
          { label: 'Extended stay', minutes: 60 },
        ],
        customDuties: ['Van runs', 'Pool towels'],
      }),
    );
    assert.deepEqual(value.customRoomTypes, [
      { label: 'Extended stay', minutes: 60 },
      { label: 'Suite', minutes: 45 },
    ]);
    assert.deepEqual(value.customDuties, ['Pool towels', 'Van runs']);

    // Through JSON, exactly as jsonb storage would.
    const readBack = parseHousekeepingSetup(JSON.parse(JSON.stringify(value)));
    assert.deepEqual(readBack, value);
  });

  test('a hotel with custom entries still passes the completeness gate', () => {
    const value = expectValue(
      goodSubmission({ customRoomTypes: [{ label: 'Suite', minutes: 45 }], customDuties: ['Van runs'] }),
    );
    assert.equal(isHousekeepingSetupComplete(value), true);
  });

  test('the hotel’s own capitalisation is preserved', () => {
    // "King Suite" is how they write it and how it must read back to them.
    const value = expectValue(goodSubmission({ customRoomTypes: [{ label: 'King Suite', minutes: 50 }] }));
    assert.equal(value.customRoomTypes[0].label, 'King Suite');
  });

  test('surrounding and doubled-up whitespace is tidied, not rejected', () => {
    // Pasted from a spreadsheet with a trailing newline is a normal way for this
    // to arrive; refusing it would strand a manager on the screen.
    const value = expectValue(
      goodSubmission({
        customRoomTypes: [{ label: '  Extended   stay  ', minutes: 60 }],
        customDuties: ['  Van   runs '],
      }),
    );
    assert.equal(value.customRoomTypes[0].label, 'Extended stay');
    assert.deepEqual(value.customDuties, ['Van runs']);
  });

  test('ordering is deterministic — two equivalent setups serialize identically', () => {
    // Later screens compare saved setups; unstable order would show a phantom
    // "changed" on every read.
    const a = expectValue(
      goodSubmission({
        customRoomTypes: [
          { label: 'Suite', minutes: 45 },
          { label: 'Cabana', minutes: 35 },
        ],
        customDuties: ['Van runs', 'Grill'],
      }),
    );
    const b = expectValue(
      goodSubmission({
        customRoomTypes: [
          { label: 'Cabana', minutes: 35 },
          { label: 'Suite', minutes: 45 },
        ],
        customDuties: ['Grill', 'Van runs'],
      }),
    );
    assert.deepEqual(a.customRoomTypes, b.customRoomTypes);
    assert.deepEqual(a.customDuties, b.customDuties);
    assert.equal(JSON.stringify(a), JSON.stringify(b));

    // And the reader agrees with the writer about that order.
    assert.equal(
      JSON.stringify(parseHousekeepingSetup(JSON.parse(JSON.stringify(b)))),
      JSON.stringify(a),
    );
  });
});

describe('custom entries — case-insensitive duplicates', () => {
  test('WRITE refuses a repeated room type instead of picking one silently', () => {
    // "Suite 45" and "suite 60" are two different numbers under one name. Folding
    // would hand the hotel a room time nobody chose; the message names the label
    // so the manager can fix it in one tap.
    const err = expectError(
      goodSubmission({
        customRoomTypes: [
          { label: 'Suite', minutes: 45 },
          { label: 'suite', minutes: 60 },
        ],
      }),
    );
    assert.match(err, /customRoomTypes/);
    // The message quotes the DUPLICATE entry exactly as the manager typed it
    // ("suite", not the first "Suite") — that is the row he has to remove.
    assert.match(err, /"suite"/);
  });

  test('WRITE catches duplicates that differ only by case or spacing', () => {
    assert.match(
      expectError(goodSubmission({ customRoomTypes: [{ label: 'SUITE', minutes: 45 }, { label: 'Suite', minutes: 45 }] })),
      /customRoomTypes/,
    );
    assert.match(
      expectError(goodSubmission({ customRoomTypes: [{ label: 'King  Suite', minutes: 45 }, { label: 'king suite', minutes: 45 }] })),
      /customRoomTypes/,
    );
    assert.match(expectError(goodSubmission({ customDuties: ['Van runs', 'VAN RUNS'] })), /customDuties/);
    assert.match(expectError(goodSubmission({ customDuties: ['Grill', ' grill '] })), /customDuties/);
  });

  test('READ folds the same duplicates instead of failing', () => {
    // A stored row can only look like this after a hand-edit, and the page must
    // still render. Keep the first, drop the rest — never throw, never null.
    const parsed = parseHousekeepingSetup({
      customRoomTypes: [
        { label: 'Suite', minutes: 45 },
        { label: 'suite', minutes: 60 },
        { label: 'SUITE', minutes: 90 },
      ],
      customDuties: ['Van runs', 'VAN RUNS', 'van  runs'],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.customRoomTypes, [{ label: 'Suite', minutes: 45 }]);
    assert.deepEqual(parsed.customDuties, ['Van runs']);
  });

  test('genuinely different labels are NOT treated as duplicates', () => {
    // The dedup must not be over-eager — a hotel with real suites AND real
    // extended-stay units has to be able to say so.
    const value = expectValue(
      goodSubmission({
        customRoomTypes: [
          { label: 'Suite', minutes: 45 },
          { label: 'Suites', minutes: 50 },
          { label: 'Junior suite', minutes: 40 },
        ],
        customDuties: ['Van runs', 'Van wash'],
      }),
    );
    assert.equal(value.customRoomTypes.length, 3);
    assert.equal(value.customDuties.length, 2);
  });
});

describe('custom entries — collision with something the questionnaire already asks', () => {
  test('WRITE refuses a room type named after the two standard times', () => {
    // A custom "Checkout" would sit beside checkoutMinutes holding a different
    // number, and no later screen could say which one the hotel meant.
    for (const label of ['Checkout', 'check out', 'CHECK-OUT', 'Stayover', 'stay over', 'Departure']) {
      const err = expectError(goodSubmission({ customRoomTypes: [{ label, minutes: 45 }] }));
      assert.match(err, /customRoomTypes/, `no rejection for ${label}`);
    }
  });

  test('WRITE refuses a duty named after one of the five built-in duties', () => {
    // Folding it into the built-in would be Staxis ticking a box the manager did
    // not tick; dropping it would lose a duty the hotel really does. Neither is
    // ours to decide — so we say which word is the problem and let him choose.
    for (const label of ['Laundry', 'laundry', 'BREAKFAST', 'Lobby', 'Public areas', 'public_areas', 'Shuttle']) {
      const err = expectError(goodSubmission({ customDuties: [label] }));
      assert.match(err, /customDuties/, `no rejection for ${label}`);
    }
  });

  test('the rejection message names the offending word so it is actionable', () => {
    assert.match(expectError(goodSubmission({ customDuties: ['Laundry'] })), /Laundry/);
    assert.match(expectError(goodSubmission({ customRoomTypes: [{ label: 'Checkout', minutes: 30 }] })), /Checkout/);
  });

  test('READ drops a colliding entry rather than storing a second copy', () => {
    const parsed = parseHousekeepingSetup({
      customRoomTypes: [
        { label: 'Checkout', minutes: 99 },
        { label: 'Suite', minutes: 45 },
      ],
      customDuties: ['Laundry', 'Van runs'],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.customRoomTypes, [{ label: 'Suite', minutes: 45 }]);
    assert.deepEqual(parsed.customDuties, ['Van runs']);
  });

  test('a reserved word merely CONTAINED in a longer label is fine', () => {
    // "Laundry room deep clean" is a real, distinct duty. The collision rule
    // matches whole labels only — an over-broad match would refuse honest answers.
    const value = expectValue(
      goodSubmission({
        customDuties: ['Laundry room deep clean', 'Shuttle to airport'],
        customRoomTypes: [{ label: 'Checkout deep clean', minutes: 60 }],
      }),
    );
    assert.equal(value.customDuties.length, 2);
    assert.equal(value.customRoomTypes.length, 1);
  });

  test('a room type named in SPANISH collides with the built-in times too', () => {
    // The questionnaire is bilingual, so a Spanish-speaking manager types
    // "Salida", not "Checkout". If that sailed through, "Salida — 40 min" would
    // sit beside checkoutMinutes: 30 with nothing able to say which number the
    // hotel meant — the exact harm the reserved list exists to prevent, and one
    // every ES user would hit. Accented and unaccented spellings both count.
    for (const label of [
      'Salida', 'salidas', 'Habitación de salida', 'habitacion de salida',
      'Ocupada', 'ocupadas', 'Habitación ocupada', 'habitacion ocupada',
    ]) {
      assert.equal(isReservedRoomTypeLabel(label), true, `not reserved: ${label}`);
      const err = expectError(goodSubmission({ customRoomTypes: [{ label, minutes: 45 }] }));
      assert.match(err, /customRoomTypes/, `no rejection for ${label}`);
    }
  });

  test('"estancia larga" is still a legal room type in Spanish', () => {
    // The Spanish Q2 placeholder offers it as an EXAMPLE of a good custom room
    // type. Reserving anything built on "estancia" would refuse the very answer
    // the screen suggests one line above the box.
    assert.equal(isReservedRoomTypeLabel('Estancia larga'), false);
    const value = expectValue(
      goodSubmission({ customRoomTypes: [{ label: 'Estancia larga', minutes: 60 }] }),
    );
    assert.deepEqual(value.customRoomTypes, [{ label: 'Estancia larga', minutes: 60 }]);
  });

  test('a Spanish duty name is NOT reserved, and that is deliberate', () => {
    // The asymmetry is the point: a custom duty carries no minutes, so a second
    // copy of "laundry" cannot make any number wrong. A custom ROOM TYPE carries
    // the minute count the labor math rests on, which is why the list above does
    // cover both languages. Pinned so the difference is a decision, not a drift.
    assert.equal(isReservedDutyLabel('Lavandería'), false);
    const value = expectValue(goodSubmission({ customDuties: ['Lavandería'] }));
    assert.deepEqual(value.customDuties, ['Lavandería']);
  });

  test('the exported reserved lists agree with the exported predicates', () => {
    // The questionnaire uses these to warn while the manager types. If they ever
    // disagreed with the validator, the screen would accept an entry the save
    // then refused, with nothing on screen explaining why.
    for (const key of RESERVED_ROOM_TYPE_KEYS) {
      assert.equal(isReservedRoomTypeLabel(key), true, `room type key ${key}`);
      assert.equal(isReservedRoomTypeLabel(key.toUpperCase()), true, `room type key ${key} upper`);
    }
    for (const key of RESERVED_DUTY_KEYS) {
      assert.equal(isReservedDutyLabel(key), true, `duty key ${key}`);
      assert.equal(isReservedDutyLabel(` ${key.toUpperCase()} `), true, `duty key ${key} padded`);
    }
    assert.equal(isReservedRoomTypeLabel('Suite'), false);
    assert.equal(isReservedDutyLabel('Van runs'), false);
  });
});

describe('custom room type minutes — the same rule as the built-in times', () => {
  test('WRITE rejects bad minutes and names the room type', () => {
    // A custom room must never be validated more loosely than "checkout" was
    // three fields earlier — it feeds the same kind of number.
    for (const bad of [0, 4, 241, 30.5, NaN, Infinity, -30, '45', null, undefined]) {
      const err = expectError(goodSubmission({ customRoomTypes: [{ label: 'Suite', minutes: bad }] }));
      assert.match(err, /customRoomTypes/, `no rejection for ${String(bad)}`);
    }
    assert.match(
      expectError(goodSubmission({ customRoomTypes: [{ label: 'Suite', minutes: 500 }] })),
      /Suite/,
    );
  });

  test('WRITE accepts the exact 5 and 240 boundaries, same as the built-ins', () => {
    const value = expectValue(
      goodSubmission({
        customRoomTypes: [
          { label: 'Quick touch-up', minutes: 5 },
          { label: 'Full deep clean', minutes: 240 },
        ],
      }),
    );
    assert.deepEqual(
      value.customRoomTypes.map((r: CustomRoomType) => r.minutes).sort((a: number, b: number) => a - b),
      [5, 240],
    );
  });

  test('READ drops an entry with impossible minutes rather than inventing a number', () => {
    // The built-in times can fall back to a prefilled default because the
    // questionnaire always collects them. A custom room type cannot: a made-up
    // minute count under a name the hotel DID choose would look authoritative
    // and be fiction. Losing the row is the honest degradation.
    const parsed = parseHousekeepingSetup({
      customRoomTypes: [
        { label: 'Suite', minutes: NaN },
        { label: 'Cabana', minutes: 0 },
        { label: 'Villa', minutes: 5000 },
        { label: 'Studio', minutes: '45' },
        { label: 'Loft', minutes: 45 },
      ],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.customRoomTypes, [{ label: 'Loft', minutes: 45 }]);
  });

  test('READ drops entries that are not objects at all', () => {
    const parsed = parseHousekeepingSetup({
      customRoomTypes: [null, 42, 'Suite', [], ['Suite', 45], { minutes: 45 }, { label: 'Loft', minutes: 45 }],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.customRoomTypes, [{ label: 'Loft', minutes: 45 }]);
  });

  test('WRITE rejects a room type entry that is not an object', () => {
    for (const bad of [null, 42, 'Suite', ['Suite', 45]]) {
      assert.match(expectError(goodSubmission({ customRoomTypes: [bad] })), /customRoomTypes/, `for ${String(bad)}`);
    }
  });
});

describe('custom labels — length, emptiness and junk', () => {
  test('the label cap is enforced on write, at the exact boundary', () => {
    const atCap = 'x'.repeat(MAX_CUSTOM_LABEL_LENGTH);
    const overCap = 'x'.repeat(MAX_CUSTOM_LABEL_LENGTH + 1);
    assert.equal(expectValue(goodSubmission({ customDuties: [atCap] })).customDuties[0], atCap);
    assert.match(expectError(goodSubmission({ customDuties: [overCap] })), /customDuties/);
    assert.equal(
      expectValue(goodSubmission({ customRoomTypes: [{ label: atCap, minutes: 45 }] })).customRoomTypes[0].label,
      atCap,
    );
    assert.match(
      expectError(goodSubmission({ customRoomTypes: [{ label: overCap, minutes: 45 }] })),
      /customRoomTypes/,
    );
  });

  test('an over-long stored label is dropped on read, never truncated', () => {
    // Truncating would leave a half-word the hotel never wrote, presented as if
    // they had. Dropping is the only honest option for a row that can only exist
    // via corruption or a hand-edit.
    const parsed = parseHousekeepingSetup({
      customDuties: ['x'.repeat(500), 'Van runs'],
      customRoomTypes: [
        { label: 'y'.repeat(500), minutes: 45 },
        { label: 'Loft', minutes: 45 },
      ],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.customDuties, ['Van runs']);
    assert.deepEqual(parsed.customRoomTypes, [{ label: 'Loft', minutes: 45 }]);
  });

  test('an empty or whitespace-only label is refused on write and dropped on read', () => {
    for (const blank of ['', '   ', '\t\n']) {
      assert.match(expectError(goodSubmission({ customDuties: [blank] })), /customDuties/, `for ${JSON.stringify(blank)}`);
      assert.match(
        expectError(goodSubmission({ customRoomTypes: [{ label: blank, minutes: 45 }] })),
        /customRoomTypes/,
        `for ${JSON.stringify(blank)}`,
      );
    }
    assert.deepEqual(parseHousekeepingSetup({ customDuties: ['', '  ', 'Van runs'] })?.customDuties, ['Van runs']);
  });

  test('a non-string duty is refused on write and dropped on read', () => {
    assert.match(expectError(goodSubmission({ customDuties: [42] })), /customDuties/);
    assert.match(expectError(goodSubmission({ customDuties: [null] })), /customDuties/);
    assert.match(expectError(goodSubmission({ customDuties: [{ label: 'Van runs' }] })), /customDuties/);
    assert.deepEqual(parseHousekeepingSetup({ customDuties: [42, null, {}, 'Van runs'] })?.customDuties, ['Van runs']);
  });

  test('a control character in a label is refused — Postgres would reject the whole save', () => {
    // A NUL inside a JSON string makes Postgres refuse the statement outright,
    // so one invisible pasted byte would fail the save with an error no manager
    // could act on. Caught here, where we can name the field.
    const withNul = 'Van' + String.fromCharCode(0) + ' runs';
    const withBell = 'Van' + String.fromCharCode(7) + ' runs';
    assert.match(expectError(goodSubmission({ customDuties: [withNul] })), /customDuties/);
    assert.match(expectError(goodSubmission({ customDuties: [withBell] })), /customDuties/);
    assert.match(
      expectError(goodSubmission({ customRoomTypes: [{ label: withNul, minutes: 45 }] })),
      /customRoomTypes/,
    );
    assert.deepEqual(parseHousekeepingSetup({ customDuties: [withNul, 'Van runs'] })?.customDuties, ['Van runs']);
  });

  test('accented and non-Latin labels are perfectly fine', () => {
    // Half this product’s users work in Spanish. Refusing "Lavandería profunda"
    // would be a bug, not a safety feature.
    const value = expectValue(
      goodSubmission({ customDuties: ['Limpieza de piscina', 'Café de la mañana'] }),
    );
    assert.equal(value.customDuties.length, 2);
  });
});

describe('custom entries — the count caps keep the row and the screen bounded', () => {
  test('WRITE accepts exactly the cap and refuses one more', () => {
    const roomsAtCap = Array.from({ length: MAX_CUSTOM_ROOM_TYPES }, (_, i) => ({
      label: `Room type ${i}`,
      minutes: 30,
    }));
    assert.equal(
      expectValue(goodSubmission({ customRoomTypes: roomsAtCap })).customRoomTypes.length,
      MAX_CUSTOM_ROOM_TYPES,
    );
    assert.match(
      expectError(goodSubmission({ customRoomTypes: [...roomsAtCap, { label: 'One too many', minutes: 30 }] })),
      /customRoomTypes/,
    );

    const dutiesAtCap = Array.from({ length: MAX_CUSTOM_DUTIES }, (_, i) => `Duty ${i}`);
    assert.equal(expectValue(goodSubmission({ customDuties: dutiesAtCap })).customDuties.length, MAX_CUSTOM_DUTIES);
    assert.match(expectError(goodSubmission({ customDuties: [...dutiesAtCap, 'One too many'] })), /customDuties/);
  });

  test('READ caps a corrupt row instead of loading ten thousand entries', () => {
    // The defence against a scripted client or a bad migration bloating one
    // property row and then rendering it all onto a manager’s phone.
    const parsed = parseHousekeepingSetup({
      customRoomTypes: Array.from({ length: 10_000 }, (_, i) => ({ label: `Type ${i}`, minutes: 30 })),
      customDuties: Array.from({ length: 10_000 }, (_, i) => `Duty ${i}`),
    });
    assert.ok(parsed);
    assert.equal(parsed.customRoomTypes.length, MAX_CUSTOM_ROOM_TYPES);
    assert.equal(parsed.customDuties.length, MAX_CUSTOM_DUTIES);
  });
});

describe('custom label helpers — the questionnaire and the server share these', () => {
  test('normalizeCustomLabel trims and collapses inner whitespace only', () => {
    assert.equal(normalizeCustomLabel('  King   Suite  '), 'King Suite');
    assert.equal(normalizeCustomLabel('Van\n\truns'), 'Van runs');
    assert.equal(normalizeCustomLabel('Suite'), 'Suite');
    assert.equal(normalizeCustomLabel('   '), '');
  });

  test('customEntryKey is the case-insensitive comparison the dedup uses', () => {
    assert.equal(customEntryKey('  King   SUITE '), customEntryKey('king suite'));
    assert.notEqual(customEntryKey('Suite'), customEntryKey('Suites'));
  });

  test('isValidCustomLabel agrees with what the validator will accept', () => {
    // The client checks with this while the manager types; if it drifted from
    // the server, the screen would accept an entry the save then refused.
    assert.equal(isValidCustomLabel('Suite'), true);
    assert.equal(isValidCustomLabel('  Suite  '), true);
    assert.equal(isValidCustomLabel(''), false);
    assert.equal(isValidCustomLabel('   '), false);
    assert.equal(isValidCustomLabel('x'.repeat(MAX_CUSTOM_LABEL_LENGTH)), true);
    assert.equal(isValidCustomLabel('x'.repeat(MAX_CUSTOM_LABEL_LENGTH + 1)), false);
    assert.equal(isValidCustomLabel(42), false);
    assert.equal(isValidCustomLabel(null), false);
    assert.equal(isValidCustomLabel(undefined), false);
    assert.equal(isValidCustomLabel('Van' + String.fromCharCode(0)), false);
  });
});

describe('parse must stay TOTAL with the new lists in play', () => {
  test('a wall of hostile custom-list inputs — none of them throws', () => {
    // Same contract as the original hostile wall: a corrupt row must never
    // white-screen Housekeeping for a hotel whose crew is waiting for a board.
    const hostile: unknown[] = [
      { customRoomTypes: 'Suite', customDuties: 42 },
      { customRoomTypes: null, customDuties: null },
      { customRoomTypes: {}, customDuties: {} },
      { customRoomTypes: [undefined, null, NaN], customDuties: [undefined, null, NaN] },
      { customRoomTypes: [Symbol('s')], customDuties: [Symbol('d')] },
      { customRoomTypes: [{ label: 'x'.repeat(10_000), minutes: Infinity }] },
      { customRoomTypes: [{ label: {}, minutes: {} }] },
      { customRoomTypes: [{ label: 'Suite' }], customDuties: [['nested']] },
      { customRoomTypes: [Object.create(null)], customDuties: [Object.create(null)] },
      { customDuties: Array.from({ length: 10_000 }, () => 'Duty') },
      { customRoomTypes: Array.from({ length: 10_000 }, () => null) },
      { customRoomTypes: [{ label: 'Suite', minutes: 45, extra: 'ignored' }] },
      JSON.parse('{"customRoomTypes":[{"label":"Suite","minutes":45}],"customDuties":["Van runs"]}'),
    ];
    hostile.forEach((input, i) => {
      assert.doesNotThrow(() => parseHousekeepingSetup(input), `parse threw on customHostile[${i}]`);
      assert.doesNotThrow(() => isHousekeepingSetupComplete(input), `complete threw on customHostile[${i}]`);
      const parsed = parseHousekeepingSetup(input);
      assert.ok(parsed, `returned null for customHostile[${i}]`);
      assert.ok(Array.isArray(parsed.customRoomTypes), `customRoomTypes not an array for [${i}]`);
      assert.ok(Array.isArray(parsed.customDuties), `customDuties not an array for [${i}]`);
      assert.ok(parsed.customRoomTypes.length <= MAX_CUSTOM_ROOM_TYPES, `room types over cap for [${i}]`);
      assert.ok(parsed.customDuties.length <= MAX_CUSTOM_DUTIES, `duties over cap for [${i}]`);
    });
  });

  test('a validated value survives a full write/read round trip for every answer', () => {
    // Widened version of the existing round-trip test, now carrying custom
    // entries through every status-entry / board-builder combination.
    for (const statusEntry of STATUS_ENTRY_METHODS) {
      for (const boardBuiltBy of BOARD_BUILT_BY_OPTIONS) {
        const value = expectValue(
          goodSubmission({
            statusEntry,
            boardBuiltBy,
            level: 2,
            customRoomTypes: [
              { label: 'Suite', minutes: 45 },
              { label: 'Cabana', minutes: 35 },
            ],
            customDuties: ['Van runs', 'Grill'],
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

  test('the strict validator refuses a non-array for either list', () => {
    assert.match(expectError(goodSubmission({ customRoomTypes: 'Suite' })), /customRoomTypes/);
    assert.match(expectError(goodSubmission({ customRoomTypes: { label: 'Suite' } })), /customRoomTypes/);
    assert.match(expectError(goodSubmission({ customDuties: 'Van runs' })), /customDuties/);
    assert.match(expectError(goodSubmission({ customDuties: { a: 1 } })), /customDuties/);
  });
});

/* ───────────────── The shift start hour the timeline draws from ───────────
 *
 * `shiftStartTime` has been collected by Q4 and stored since migration 0337,
 * and until now NOTHING read it: the timeline axis and the shift window were
 * both pinned to a hardcoded 7am, so a hotel that answered 06:00 or 09:30 had
 * its whole day drawn against a start it never chose and its NOW line landed
 * in the wrong place. This is the reader that closes that gap, and it must be
 * as total as the parser it wraps — it positions every card on the screen and
 * a throw here would take the board down with it.
 */
describe('resolveShiftStartHour', () => {
  test('uses the hour the hotel actually answered', () => {
    assert.equal(resolveShiftStartHour(goodSubmission({ shiftStartTime: '06:00' })), 6);
    assert.equal(resolveShiftStartHour(goodSubmission({ shiftStartTime: '09:30' })), 9);
    assert.equal(resolveShiftStartHour(goodSubmission({ shiftStartTime: '00:15' })), 0);
    assert.equal(resolveShiftStartHour(goodSubmission({ shiftStartTime: '23:45' })), 23);
  });

  test('a hotel that has not answered the questionnaire falls back', () => {
    assert.equal(resolveShiftStartHour(null), FALLBACK_SHIFT_START_HOUR);
    assert.equal(resolveShiftStartHour(undefined), FALLBACK_SHIFT_START_HOUR);
    // Not a setup blob at all — parse returns null, so there is no answer.
    assert.equal(resolveShiftStartHour('08:00'), FALLBACK_SHIFT_START_HOUR);
    assert.equal(resolveShiftStartHour([]), FALLBACK_SHIFT_START_HOUR);
    assert.equal(resolveShiftStartHour({ version: 99 }), FALLBACK_SHIFT_START_HOUR);
  });

  test('a stored blob with a garbled time uses the questionnaire default, not the fallback', () => {
    // The distinction matters: a hotel that answered the questionnaire agreed
    // to 08:00 as the prefilled default, so a corrupted field lands there
    // rather than on the "never asked" 7am.
    for (const bad of ['8:00', '25:00', '', 800, null, undefined, {}]) {
      assert.equal(
        resolveShiftStartHour(goodSubmission({ shiftStartTime: bad })),
        Number.parseInt(DEFAULT_SHIFT_START.slice(0, 2), 10),
        `for ${String(bad)}`,
      );
    }
  });

  test('an explicit fallback is honoured', () => {
    assert.equal(resolveShiftStartHour(null, 5), 5);
  });

  test('never throws, for any input at all', () => {
    const hostile: unknown[] = [
      null, undefined, 0, -1, NaN, Infinity, '', 'x', [], [1, 2], true,
      { version: 1 }, { shiftStartTime: Symbol('x') },
      goodSubmission({ shiftStartTime: { toString: () => { throw new Error('nope'); } } }),
    ];
    for (const value of hostile) {
      const hour = resolveShiftStartHour(value);
      assert.ok(Number.isInteger(hour) && hour >= 0 && hour <= 23, `for ${String(value)}`);
    }
  });
});

/* Type-only sanity: the exported unions are what every other agent codes to. */
const _statusEntries: readonly StatusEntryMethod[] = STATUS_ENTRY_METHODS;
const _boardBuiltBy: readonly BoardBuiltBy[] = BOARD_BUILT_BY_OPTIONS;
void _statusEntries;
void _boardBuiltBy;

/* ─────────────────── Questionnaire copy ───────────────────────────────── */
describe('housekeeping setup copy', () => {
  const en = hkst('en') as Record<string, string>;

  test('no English string is empty', () => {
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof value, 'string', `en.${key} is not a string`);
      assert.notEqual(value.trim(), '', `en.${key} is empty`);
    }
  });

  test('an unknown language falls back to English rather than blowing up', () => {
    assert.deepEqual(hkst('de' as 'en'), en);
  });
});
