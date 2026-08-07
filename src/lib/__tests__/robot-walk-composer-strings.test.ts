/**
 * THE ROBOT'S SENTENCES, READ BY THE THING THAT WILL READ THEM.
 *
 * The first live walkthrough failed on `Robot check: nightly walkthrough`, and
 * neither half of the failure looked like a bug from either side.
 *
 * The composer READS what it is given. "nightly" is a cadence, so it filed the
 * to-do as a REPEATING one — and a repeating to-do is not a to-do. It is a
 * rule, stored in `recurring_task_templates`, and the first actual to-do
 * appears whenever the recurring sweep next runs. So the row the walk was
 * waiting for could not have appeared inside its twenty-second budget, or
 * inside twenty minutes, and no longer wait would ever have fixed it.
 *
 * That is the product working. Somebody who types "nightly" is asking for a
 * repeating job and should get one. What was wrong was the robot's sentence,
 * and a sentence is only safe if the parser says so.
 *
 * The title is checked below too, even though it was NOT what broke: the parser
 * tidies its own copy for the chips while the composer sends the sentence
 * exactly as typed, so the stored title was the full one. It is checked because
 * a future change that made the tidied copy the stored one would break every
 * row assertion in the walk, silently, and this is where that would surface.
 *
 * ─── WHY THIS IS NOT A TEST ABOUT "nightly" ────────────────────────────────
 *
 * Pinning that one word would pass the day somebody rewrote a string to say
 * "Robot check: every morning" or "Robot check: for Ana" or "Robot check: on
 * the 3rd". The rule is the general one: whatever the robot types must come
 * back out of `parseTodo` untouched. Same title, nobody assigned, no date, no
 * cadence.
 *
 * And it runs against several clocks, because a parser that understands
 * weekdays and month days answers differently on different days. A string that
 * is clean on the Friday somebody wrote it is not proof of anything.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseTodo } from '@/lib/feed/parse-todo';
import {
  isRobotWalkArtifact,
  ROBOT_WALK_ASSIGNED_TODO_TITLE,
  ROBOT_WALK_COMPOSER_STRINGS,
  ROBOT_WALK_FACT_TEXT,
  ROBOT_WALK_ITEM_NAME,
  ROBOT_WALK_TODO_TITLE,
} from '@/lib/automation/robot-walk';

/** The robot hotel's roster, so a string naming one of them would be caught. */
const PEOPLE = [
  { staffId: 'staff-manager', name: 'Robot Manager', department: 'other' },
  { staffId: 'staff-colleague', name: 'Robot Colleague', department: 'front_desk' },
];

/**
 * A weekday, a weekend late evening (where a hotel-local day boundary is most
 * likely to move an answer), and a new year's day.
 */
const CLOCKS = [
  '2026-08-07T09:00:00.000Z',
  '2026-08-09T23:30:00.000Z',
  '2026-01-01T00:00:00.000Z',
];

function readings(text: string, clock: string) {
  return parseTodo(text, PEOPLE as never, new Date(clock));
}

describe('what the composer makes of the robot’s sentences', () => {
  test('the list is not empty, or every check below is vacuous', () => {
    assert.ok(ROBOT_WALK_COMPOSER_STRINGS.length >= 2);
  });

  test('the title survives, word for word', () => {
    // Not what broke, but the thing that would break everything if the stored
    // title ever became the parser's tidied copy: every row assertion in the
    // walk filters on the sentence as typed.
    for (const clock of CLOCKS) {
      for (const typed of ROBOT_WALK_COMPOSER_STRINGS) {
        assert.equal(
          readings(typed, clock).title,
          typed,
          `on ${clock} the composer files "${typed}" as "${readings(typed, clock).title}"`,
        );
      }
    }
  });

  test('nothing the robot types is read as a repeat', () => {
    // The one that cost the run. A repeat does not create a to-do at all: it
    // creates a rule, and the first to-do appears whenever the recurring sweep
    // next runs. No wait is long enough for that, and the rule then spawns a
    // new to-do every day forever at a hotel nobody is watching.
    for (const clock of CLOCKS) {
      for (const typed of ROBOT_WALK_COMPOSER_STRINGS) {
        assert.equal(
          readings(typed, clock).repeat,
          null,
          `on ${clock} "${typed}" is read as a repeating job (${readings(typed, clock).repeat})`,
        );
      }
    }
  });

  test('nothing the robot types quietly assigns itself to somebody', () => {
    // A sentence that names a person hands the to-do over, and a to-do handed
    // over leaves the author's list — so it would vanish from the list the walk
    // is checking, and land on a real roster entry the walk cannot clear.
    for (const clock of CLOCKS) {
      for (const typed of ROBOT_WALK_COMPOSER_STRINGS) {
        assert.equal(readings(typed, clock).who, null, `"${typed}" assigns somebody on ${clock}`);
      }
    }
  });

  test('nothing the robot types carries a date', () => {
    // A date files the to-do into the future, where it is not on today's list.
    for (const clock of CLOCKS) {
      for (const typed of ROBOT_WALK_COMPOSER_STRINGS) {
        assert.equal(readings(typed, clock).when, null, `"${typed}" carries a date on ${clock}`);
      }
    }
  });

  test('the sentence that actually broke would fail this', () => {
    // The guard has to be able to fail, and this is the proof. If a future
    // parser change stopped reading "nightly" as a cadence, this check would go
    // red and somebody would come and read the rest of this file.
    const broke = 'Robot check: nightly walkthrough';
    const parsed = readings(broke, CLOCKS[0]);
    assert.equal(parsed.repeat, 'daily');
    assert.notEqual(parsed.title, broke);
  });
});

describe('everything the robot leaves behind is findable again', () => {
  test('every artifact carries the marker cleanup matches on', () => {
    // Cleanup only ever deletes what it can prove it created. An artifact whose
    // name lost the prefix is one the robot can never take back.
    for (const text of [
      ROBOT_WALK_TODO_TITLE,
      ROBOT_WALK_ASSIGNED_TODO_TITLE,
      ROBOT_WALK_FACT_TEXT,
      ROBOT_WALK_ITEM_NAME,
    ]) {
      assert.equal(isRobotWalkArtifact(text), true, `"${text}" is not something cleanup would recognise`);
    }
  });

  test('the two to-dos are told apart by more than the marker', () => {
    // Both steps wait on a row filtered by title. Two titles where one contains
    // the other would let the assign step pass on the add step's row.
    assert.notEqual(ROBOT_WALK_TODO_TITLE, ROBOT_WALK_ASSIGNED_TODO_TITLE);
    assert.ok(!ROBOT_WALK_ASSIGNED_TODO_TITLE.includes(ROBOT_WALK_TODO_TITLE));
    assert.ok(!ROBOT_WALK_TODO_TITLE.includes(ROBOT_WALK_ASSIGNED_TODO_TITLE));
  });
});
