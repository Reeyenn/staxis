// Behavior tests for the My Hotel → People merge.
//
// This is the part of the Directory fold-in that can actually be wrong: the
// same human used to appear on two screens, and the failure mode of merging
// them is either showing somebody twice or losing them entirely. Every test
// here would fail on a plausible bug in buildHotelRoster.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ALWAYS_VISIBLE_GROUPS,
  buildHotelRoster,
  groupForPerson,
  rosterCounts,
  type RosterAccountLike,
  type RosterStaffLike,
} from '@/app/company/_components/people-roster';

function account(overrides: Partial<RosterAccountLike> & { accountId: string }): RosterAccountLike {
  return {
    displayName: 'Account Person',
    role: 'staff',
    staffId: null,
    ...overrides,
  };
}

function staff(overrides: Partial<RosterStaffLike> & { id: string }): RosterStaffLike {
  return {
    name: 'Staff Person',
    department: 'housekeeping',
    scheduledToday: false,
    isActive: true,
    ...overrides,
  };
}

function flatten(groups: ReturnType<typeof buildHotelRoster>) {
  return groups.flatMap((group) => group.people);
}

describe('buildHotelRoster — one human, one card', () => {
  test('a linked person appears exactly once, carrying both records', () => {
    const groups = buildHotelRoster(
      [account({ accountId: 'acc-1', displayName: 'M. Lopez', role: 'housekeeping', staffId: 'staff-1' })],
      [staff({ id: 'staff-1', name: 'Maria Lopez' })],
    );
    const people = flatten(groups);
    assert.equal(people.length, 1);
    assert.equal(people[0].account?.accountId, 'acc-1');
    assert.equal(people[0].staff?.id, 'staff-1');
    // The employment name wins: it is what the schedule and the board print.
    assert.equal(people[0].name, 'Maria Lopez');
  });

  test('an employment record with no login is still listed', () => {
    const people = flatten(buildHotelRoster([], [staff({ id: 'staff-9', name: 'Ana Ruiz' })]));
    assert.equal(people.length, 1);
    assert.equal(people[0].account, null);
    assert.equal(people[0].staff?.id, 'staff-9');
  });

  test('a login with no employment record is not dropped', () => {
    // The owner who never clocks in. The two-list layout had nowhere to put
    // them once the "leftovers" list only showed unlinked staff rows.
    const groups = buildHotelRoster(
      [account({ accountId: 'acc-owner', displayName: 'Reeyen Patel', role: 'owner' })],
      [],
    );
    const people = flatten(groups);
    assert.equal(people.length, 1);
    assert.equal(people[0].name, 'Reeyen Patel');
    assert.equal(people[0].group, 'management');
  });

  test('an account pointing at a staff row we were not given stays login-only', () => {
    const people = flatten(buildHotelRoster(
      [account({ accountId: 'acc-1', displayName: 'Dana', role: 'front_desk', staffId: 'staff-missing' })],
      [],
    ));
    assert.equal(people.length, 1);
    assert.equal(people[0].staff, null);
    assert.equal(people[0].group, 'front_desk');
  });

  test('two accounts claiming the same staff row do not delete that person', () => {
    // The database allows only one active link, but a stale payload must never
    // make somebody vanish from the roster.
    const people = flatten(buildHotelRoster(
      [
        account({ accountId: 'acc-1', displayName: 'First', staffId: 'staff-1' }),
        account({ accountId: 'acc-2', displayName: 'Second', staffId: 'staff-1' }),
      ],
      [staff({ id: 'staff-1', name: 'Maria Lopez' })],
    ));
    assert.equal(people.length, 2);
    assert.equal(people.filter((person) => person.staff?.id === 'staff-1').length, 1);
    assert.ok(people.some((person) => person.account?.accountId === 'acc-2' && person.staff === null));
  });

  test('nobody is listed twice when every shape is present at once', () => {
    const groups = buildHotelRoster(
      [
        account({ accountId: 'acc-1', displayName: 'Linked', role: 'housekeeping', staffId: 'staff-1' }),
        account({ accountId: 'acc-2', displayName: 'Login only', role: 'general_manager' }),
      ],
      [
        staff({ id: 'staff-1', name: 'Linked Person' }),
        staff({ id: 'staff-2', name: 'Schedule Only' }),
      ],
    );
    const people = flatten(groups);
    assert.equal(people.length, 3);
    assert.equal(new Set(people.map((person) => person.key)).size, 3);
  });
});

describe('buildHotelRoster — grouping and order', () => {
  test('employment department beats the login role', () => {
    const people = flatten(buildHotelRoster(
      [account({ accountId: 'acc-1', role: 'general_manager', staffId: 'staff-1' })],
      [staff({ id: 'staff-1', department: 'front_desk' })],
    ));
    assert.equal(people[0].group, 'front_desk');
  });

  test('a login role that names a department is used when there is no staff row', () => {
    assert.equal(groupForPerson(account({ accountId: 'a', role: 'maintenance' }), null), 'maintenance');
    assert.equal(groupForPerson(account({ accountId: 'a', role: 'owner' }), null), 'management');
    assert.equal(groupForPerson(account({ accountId: 'a', role: 'staff' }), null), 'management');
  });

  test('an unknown or missing department reads as Housekeeping, never disappears', () => {
    assert.equal(groupForPerson(null, staff({ id: 's', department: undefined })), 'housekeeping');
    assert.equal(groupForPerson(null, staff({ id: 's', department: 'laundry' })), 'housekeeping');
  });

  test('whoever is on shift sorts first, then alphabetically', () => {
    const groups = buildHotelRoster([], [
      staff({ id: 's1', name: 'Zoe', scheduledToday: true }),
      staff({ id: 's2', name: 'Ana', scheduledToday: false }),
      staff({ id: 's3', name: 'Bea', scheduledToday: true }),
    ]);
    const housekeeping = groups.find((group) => group.key === 'housekeeping')!;
    assert.deepEqual(housekeeping.people.map((person) => person.name), ['Bea', 'Zoe', 'Ana']);
  });

  test('the three real departments always get a card, management and other do not', () => {
    assert.ok(ALWAYS_VISIBLE_GROUPS.has('housekeeping'));
    assert.ok(ALWAYS_VISIBLE_GROUPS.has('front_desk'));
    assert.ok(ALWAYS_VISIBLE_GROUPS.has('maintenance'));
    assert.ok(!ALWAYS_VISIBLE_GROUPS.has('management'));
    assert.ok(!ALWAYS_VISIBLE_GROUPS.has('other'));
  });
});

describe('rosterCounts', () => {
  test('counts the books, today, and who is close to their cap', () => {
    const counts = rosterCounts([
      { scheduledToday: true, weeklyHours: 38, maxWeeklyHours: 40 },
      { scheduledToday: false, weeklyHours: 12, maxWeeklyHours: 40 },
      { scheduledToday: true, weeklyHours: 20, maxWeeklyHours: 24 },
    ]);
    assert.equal(counts.roster, 3);
    assert.equal(counts.onShift, 2);
    // 38 >= 36 and 20 >= 20; 12 < 36.
    assert.equal(counts.nearOvertime, 2);
  });

  test('a missing cap falls back to 40 rather than reporting everyone as near overtime', () => {
    assert.equal(rosterCounts([{ weeklyHours: 10 }]).nearOvertime, 0);
  });
});
