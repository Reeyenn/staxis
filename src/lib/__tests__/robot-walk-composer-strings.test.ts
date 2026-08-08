/**
 * The nightly walk types these sentences into the same composer people use.
 * Keep this test against the real parser: a cadence word silently changes the
 * API response from a task id to a recurring-template id, so no browser wait can
 * make the old sentence produce the row the walk needs to complete.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseTodo, type ComposerPerson } from '@/lib/feed/parse-todo';
import {
  ROBOT_WALK_ASSIGNED_TODO_TITLE,
  ROBOT_WALK_COMPOSER_STRINGS,
  ROBOT_WALK_TODO_TITLE,
} from '@/lib/automation/robot-walk';

const PEOPLE: ComposerPerson[] = [
  { staffId: 'staff-manager', name: 'Robot Manager' },
  { staffId: 'staff-colleague', name: 'Robot Colleague' },
];

const CLOCKS = [
  '2026-08-08T09:00:00.000Z',
  '2026-08-09T23:30:00.000Z',
  '2026-01-01T00:00:00.000Z',
];

describe('robot walkthrough composer sentences', () => {
  test('every exact sentence stays a one-off task with its own title', () => {
    assert.deepEqual(ROBOT_WALK_COMPOSER_STRINGS, [
      ROBOT_WALK_TODO_TITLE,
      ROBOT_WALK_ASSIGNED_TODO_TITLE,
    ]);

    for (const clock of CLOCKS) {
      for (const typed of ROBOT_WALK_COMPOSER_STRINGS) {
        const parsed = parseTodo(typed, PEOPLE, new Date(clock));
        assert.equal(parsed.title, typed, `title changed on ${clock}`);
        assert.equal(parsed.repeat, null, `"${typed}" became recurring on ${clock}`);
        assert.equal(parsed.when, null, `"${typed}" acquired a date on ${clock}`);
        assert.equal(parsed.weekday, null, `"${typed}" acquired a weekday on ${clock}`);
        assert.equal(parsed.dayOfMonth, null, `"${typed}" acquired a month day on ${clock}`);
        assert.equal(parsed.who, null, `"${typed}" acquired an implicit assignee on ${clock}`);
      }
    }
  });

  test('the retired nightly sentence remains a positive recurring control', () => {
    const oldSentence = 'Robot check: nightly walkthrough';
    const parsed = parseTodo(oldSentence, PEOPLE, new Date(CLOCKS[0]));
    assert.equal(parsed.repeat, 'daily');
    assert.notEqual(parsed.title, oldSentence);
  });
});
