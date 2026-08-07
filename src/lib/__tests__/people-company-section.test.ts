/**
 * "You see your hotel's people, plus the company people responsible for YOUR
 * hotel. Nothing else."
 *
 * That is the founder's sentence for the People screen, and this file is the
 * pure half of proving it: given exactly what GET /api/auth/team hands the
 * panel, which humans land in the hotel's own list and which land in the small
 * read-only Company section underneath it.
 *
 * The other half — that the route never hands over a sibling hotel's people in
 * the first place — is pinned against a real database in
 * people-company-section.integration.test.ts. Both halves matter: this one
 * would still pass if the route leaked, and that one would still pass if this
 * merge put a VP back among the housekeepers.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildHotelRoster,
  splitHotelAndCompanyPeople,
  type RosterAccountLike,
  type RosterCompanyJob,
  type RosterStaffLike,
} from '@/app/(hotel)/company/_components/people-roster';

const HOTEL_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const HOTEL_A2 = 'a2a2a2a2-0000-4000-8000-000000000001';
const HOTEL_B = 'b1b1b1b1-0000-4000-8000-000000000001';

function account(
  accountId: string,
  displayName: string,
  role: string,
  staffId: string | null = null,
): RosterAccountLike & { accountId: string } {
  return { accountId, displayName, role, staffId };
}

function staffRow(id: string, name: string, department: string): RosterStaffLike {
  return { id, name, department, isActive: true };
}

function companyJob(
  membershipId: string,
  role: string,
  label: string,
  propertyIds: string[],
): RosterCompanyJob {
  return { membershipId, scope: 'company', role, label: { en: label }, propertyIds };
}

function propertyJob(
  membershipId: string,
  role: string,
  label: string,
  propertyIds: string[],
): RosterCompanyJob {
  return { membershipId, scope: 'property', role, label: { en: label }, propertyIds };
}

function names(people: readonly { name: string }[]): string[] {
  return people.map((person) => person.name).sort();
}

describe('a GM looking at their own hotel', () => {
  // What the route hands a GM at hotel A: their own roster, their company's
  // oversight, and hats already narrowed to the one hotel they can reach.
  const accounts = [
    account('acct-gm', 'Gil Manager', 'general_manager'),
    account('acct-owner', 'Ana Owner', 'owner'),
    account('acct-vp', 'Vera Oversight', 'front_desk'),
    account('acct-fd', 'Frank Desk', 'front_desk', 'staff-frank'),
  ];
  const staff = [
    staffRow('staff-frank', 'Frank Desk', 'front_desk'),
    staffRow('staff-hk', 'Hana Housekeeper', 'housekeeping'),
  ];
  const jobs: Record<string, RosterCompanyJob[]> = {
    'acct-gm': [propertyJob('m-gm', 'general_manager', 'GM', [HOTEL_A])],
    'acct-owner': [companyJob('m-owner', 'owner', 'Owner', [HOTEL_A])],
    'acct-vp': [companyJob('m-vp', 'regional_manager', 'Oversees', [HOTEL_A])],
    'acct-fd': [propertyJob('m-fd', 'front_desk', 'Front Desk', [HOTEL_A])],
  };

  const split = splitHotelAndCompanyPeople(
    buildHotelRoster(accounts, staff),
    jobs,
    HOTEL_A,
  );
  const hotelPeople = split.hotelGroups.flatMap((group) => group.people);

  test('the hotel list holds the people who work here, and only them', () => {
    assert.deepEqual(
      names(hotelPeople),
      ['Frank Desk', 'Gil Manager', 'Hana Housekeeper'],
    );
  });

  test('the company people responsible for this hotel are listed apart', () => {
    assert.deepEqual(names(split.companyPeople), ['Ana Owner', 'Vera Oversight']);
  });

  test('nobody is lost and nobody is shown twice', () => {
    const everyone = [...names(hotelPeople), ...names(split.companyPeople)];
    assert.equal(everyone.length, new Set(everyone).size);
    assert.equal(everyone.length, 5);
  });

  test('a company person carries no staff record, so nothing can be scheduled onto them', () => {
    for (const person of split.companyPeople) {
      assert.equal('staff' in person, false);
      assert.equal(person.account.staffId, null);
    }
  });
});

describe('the person who is both', () => {
  test('a VP who also runs one of the hotels stays on that hotel list', () => {
    const accounts = [account('acct-maria', 'Maria Both', 'general_manager')];
    const jobs: Record<string, RosterCompanyJob[]> = {
      'acct-maria': [
        propertyJob('m-gm', 'general_manager', 'GM', [HOTEL_A]),
        companyJob('m-vp', 'regional_manager', 'Oversees', [HOTEL_A, HOTEL_A2]),
      ],
    };

    const atHotelA = splitHotelAndCompanyPeople(buildHotelRoster(accounts, []), jobs, HOTEL_A);
    assert.deepEqual(
      names(atHotelA.hotelGroups.flatMap((group) => group.people)),
      ['Maria Both'],
      'she runs this one, so this is her hotel',
    );
    assert.deepEqual(names(atHotelA.companyPeople), []);

    const atHotelA2 = splitHotelAndCompanyPeople(buildHotelRoster(accounts, []), jobs, HOTEL_A2);
    assert.deepEqual(
      names(atHotelA2.hotelGroups.flatMap((group) => group.people)),
      [],
      'she does not work at the second hotel',
    );
    assert.deepEqual(
      names(atHotelA2.companyPeople),
      ['Maria Both'],
      'she oversees it, which is a different sentence',
    );
  });

  test('a company person who also holds an employment record here stays on the roster', () => {
    const accounts = [account('acct-vp', 'Vera Oversight', 'front_desk', 'staff-vera')];
    const staff = [staffRow('staff-vera', 'Vera Oversight', 'front_desk')];
    const jobs: Record<string, RosterCompanyJob[]> = {
      'acct-vp': [companyJob('m-vp', 'regional_manager', 'Oversees', [HOTEL_A])],
    };

    const split = splitHotelAndCompanyPeople(buildHotelRoster(accounts, staff), jobs, HOTEL_A);
    assert.deepEqual(names(split.hotelGroups.flatMap((group) => group.people)), ['Vera Oversight']);
    assert.deepEqual(names(split.companyPeople), []);
  });
});

describe('the walls hold', () => {
  test('a company job that does not reach this hotel puts nobody in its Company section', () => {
    const accounts = [account('acct-vp-b', 'Bo Other', 'front_desk')];
    const jobs: Record<string, RosterCompanyJob[]> = {
      'acct-vp-b': [companyJob('m-vp-b', 'regional_manager', 'Oversees', [HOTEL_B])],
    };

    const split = splitHotelAndCompanyPeople(buildHotelRoster(accounts, []), jobs, HOTEL_A);
    assert.deepEqual(names(split.companyPeople), []);
    assert.deepEqual(
      names(split.hotelGroups.flatMap((group) => group.people)),
      ['Bo Other'],
      'a login with no reach here is still whatever the roster already said it was',
    );
  });

  test('the split reads only the selected hotel, so a narrowed job list stays narrowed', () => {
    // This is what the route actually hands a GM at hotel A: the VP's company
    // job with hotel B filtered out of it. The split must not go looking for
    // more, which is why it asks a single question about a single hotel id.
    const accounts = [account('acct-vp', 'Vera Oversight', 'front_desk')];
    const narrowed: Record<string, RosterCompanyJob[]> = {
      'acct-vp': [companyJob('m-vp', 'regional_manager', 'Oversees', [HOTEL_A])],
    };

    const split = splitHotelAndCompanyPeople(buildHotelRoster(accounts, []), narrowed, HOTEL_A);
    const jobs = split.companyPeople[0]?.jobs ?? [];
    assert.deepEqual(jobs.flatMap((job) => job.propertyIds), [HOTEL_A]);
  });

  test('an employment-only person with no login is untouched by the company rule', () => {
    const staff = [staffRow('staff-hk', 'Hana Housekeeper', 'housekeeping')];
    const split = splitHotelAndCompanyPeople(buildHotelRoster([], staff), {}, HOTEL_A);
    assert.deepEqual(names(split.hotelGroups.flatMap((group) => group.people)), ['Hana Housekeeper']);
    assert.deepEqual(split.companyPeople, []);
  });

  test('a hotel with no company at all has no Company section', () => {
    const accounts = [account('acct-owner', 'Wanda Owner', 'owner')];
    const split = splitHotelAndCompanyPeople(buildHotelRoster(accounts, []), {}, HOTEL_A);
    assert.deepEqual(split.companyPeople, []);
    assert.deepEqual(names(split.hotelGroups.flatMap((group) => group.people)), ['Wanda Owner']);
  });
});

describe('the department grouping survives the split', () => {
  test('the hotel groups keep their order and their labels', () => {
    const accounts = [
      account('acct-gm', 'Gil Manager', 'general_manager'),
      account('acct-vp', 'Vera Oversight', 'front_desk'),
    ];
    const staff = [
      staffRow('staff-hk', 'Hana Housekeeper', 'housekeeping'),
      staffRow('staff-mt', 'Milo Maintenance', 'maintenance'),
    ];
    const jobs: Record<string, RosterCompanyJob[]> = {
      'acct-vp': [companyJob('m-vp', 'regional_manager', 'Oversees', [HOTEL_A])],
    };

    const split = splitHotelAndCompanyPeople(buildHotelRoster(accounts, staff), jobs, HOTEL_A);
    assert.deepEqual(
      split.hotelGroups.map((group) => group.key),
      ['management', 'housekeeping', 'front_desk', 'maintenance', 'other'],
    );
    assert.deepEqual(
      names(split.hotelGroups.find((group) => group.key === 'management')!.people),
      ['Gil Manager'],
    );
    assert.deepEqual(
      names(split.hotelGroups.find((group) => group.key === 'housekeeping')!.people),
      ['Hana Housekeeper'],
    );
  });
});
