/**
 * Coverage revalidation without a teardown.
 *
 * Every window focus used to blank the hotel list, null the active hotel, flip
 * the shell back to its spinner and remount the tree — because the
 * authorization viewer key changed on every browser boundary and PropertyContext
 * masks anything not stamped with the current key. These drive the decisions
 * that let a refocus revalidate quietly behind the data instead.
 *
 * What is being protected, in order of how badly it hurts when it breaks:
 *
 *   1. REFERENTIAL STABILITY. "Nothing changed" has to mean "nothing
 *      re-rendered". If a revalidation that returns identical coverage still
 *      handed React fresh objects, the blank frame would be gone but the churn
 *      would remain — memos recompute, effects keyed on the property object
 *      re-run, scroll position and in-progress UI still die.
 *   2. THE MERGE NEVER NARROWS. The server resolved coverage through the
 *      company spine. This layer decides which references to REUSE, never which
 *      hotels a viewer may see. A bug that drops a hotel here locks a real
 *      manager out of her own building.
 *   3. REVOCATION IS IMMEDIATE. The instant a refetch comes back without a
 *      hotel, that hotel leaves the exposed list and its capability snapshot is
 *      dropped. Keeping data on screen during revalidation must never mean
 *      keeping access the server just took away.
 *   4. STALENESS IS STILL A CHANGE. Freezing too eagerly is its own bug: a
 *      renamed hotel or an advanced sync time has to propagate.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  reconcilePropertyList,
  resolveAuthorizationLoadMode,
  resolveCoverageSelection,
  sameAuthorizationValue,
} from '@/lib/property-coverage';
import type { Property } from '@/types';

const CREATED_AT = '2026-01-05T12:00:00.000Z';

/** Builds a hotel the way a refetch would: brand-new objects and brand-new
 *  `Date` instances every call, never shared references. Comparing two of
 *  these is exactly the "did the server's answer change?" question. */
function hotel(id: string, overrides: Partial<Property> = {}): Property {
  return {
    id,
    name: `Hotel ${id.toUpperCase()}`,
    totalRooms: 80,
    avgOccupancy: 0.72,
    hourlyWage: 14,
    checkoutMinutes: 30,
    stayoverMinutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 480,
    totalStaffOnRoster: 6,
    createdAt: new Date(CREATED_AT),
    ...overrides,
  };
}

function ids(list: Property[]): string[] {
  return list.map((property) => property.id);
}

describe('property coverage — a quiet revalidation must not re-render', () => {
  test('identical coverage hands back the very same array and hotel objects', () => {
    const onScreen = [hotel('a'), hotel('b')];
    const refetched = [hotel('a'), hotel('b')];

    const merged = reconcilePropertyList(onScreen, refetched);

    // Reference equality is the assertion. React bails out of the re-render
    // only when the state value is the identical object.
    assert.equal(merged, onScreen);
    assert.equal(merged[0], onScreen[0]);
    assert.equal(merged[1], onScreen[1]);
    // And nothing from the refetch leaked in.
    assert.equal(merged.includes(refetched[0]), false);
  });

  test('equal-but-distinct Date fields do not count as a change', () => {
    const onScreen = [hotel('a', { lastSyncedAt: new Date(CREATED_AT) })];
    const refetched = [hotel('a', { lastSyncedAt: new Date(CREATED_AT) })];

    assert.equal(reconcilePropertyList(onScreen, refetched), onScreen);
  });

  test('an optional field the mapper omitted on one pass is not a change', () => {
    const onScreen = [hotel('a')];
    const refetched = [hotel('a', { pmsType: undefined, timezone: undefined })];

    assert.equal(reconcilePropertyList(onScreen, refetched), onScreen);
  });

  test('nested arrays compare by content, not by reference', () => {
    const onScreen = [hotel('a', { roomInventory: ['101', '102'] })];
    const same = [hotel('a', { roomInventory: ['101', '102'] })];
    const different = [hotel('a', { roomInventory: ['101', '103'] })];

    assert.equal(reconcilePropertyList(onScreen, same), onScreen);
    assert.notEqual(reconcilePropertyList(onScreen, different), onScreen);
  });
});

describe('property coverage — real changes still propagate', () => {
  test('a renamed hotel replaces only itself', () => {
    const onScreen = [hotel('a'), hotel('b')];
    const refetched = [hotel('a'), hotel('b', { name: 'Comfort Suites Beaumont' })];

    const merged = reconcilePropertyList(onScreen, refetched);

    assert.notEqual(merged, onScreen, 'a changed hotel must produce a new list');
    assert.equal(merged[0], onScreen[0], 'the untouched hotel keeps its identity');
    assert.equal(merged[1].name, 'Comfort Suites Beaumont');
  });

  test('an advanced sync time is a change, not something to freeze', () => {
    const onScreen = [hotel('a', { lastSyncedAt: new Date('2026-01-05T12:00:00.000Z') })];
    const refetched = [hotel('a', { lastSyncedAt: new Date('2026-01-05T12:30:00.000Z') })];

    assert.notEqual(reconcilePropertyList(onScreen, refetched), onScreen);
  });

  test('revoked access disappears the moment the refetch lands', () => {
    const onScreen = [hotel('a'), hotel('b')];

    const merged = reconcilePropertyList(onScreen, [hotel('a')]);

    assert.deepEqual(ids(merged), ['a']);
    assert.equal(merged[0], onScreen[0]);
  });

  test('newly granted access is exposed immediately', () => {
    const onScreen = [hotel('a')];

    const merged = reconcilePropertyList(onScreen, [hotel('a'), hotel('c')]);

    assert.deepEqual(ids(merged), ['a', 'c']);
    assert.equal(merged[0], onScreen[0]);
  });

  test('a reordered list is a real change, but every hotel is reused', () => {
    const onScreen = [hotel('a'), hotel('b')];

    const merged = reconcilePropertyList(onScreen, [hotel('b'), hotel('a')]);

    assert.notEqual(merged, onScreen);
    assert.deepEqual(ids(merged), ['b', 'a']);
    assert.equal(merged[0], onScreen[1]);
    assert.equal(merged[1], onScreen[0]);
  });

  test('the merge NEVER narrows what the server resolved', () => {
    const cases: Array<[string[], string[]]> = [
      [[], []],
      [[], ['a']],
      [['a'], []],
      [['a'], ['a']],
      [['a', 'b'], ['b', 'a']],
      [['a'], ['a', 'b', 'c']],
      [['a', 'b', 'c'], ['b']],
      [['a', 'b'], ['c', 'd']],
    ];

    for (const [before, after] of cases) {
      const merged = reconcilePropertyList(
        before.map((id) => hotel(id)),
        after.map((id) => hotel(id)),
      );
      assert.deepEqual(
        ids(merged),
        after,
        `coverage ${JSON.stringify(before)} -> ${JSON.stringify(after)} must expose exactly the server's answer`,
      );
    }
  });
});

describe('property coverage — which load masks and which one does not', () => {
  const stamped = {
    stampedViewerUid: 'uid-1',
    stampedAuthorizationKey: 'uid-1:acct-1:owner::legacy-shell:authorization-revision:0',
  };

  test('re-resolving coverage the viewer already holds is a background revalidation', () => {
    assert.equal(
      resolveAuthorizationLoadMode({
        ...stamped,
        loadViewerUid: 'uid-1',
        loadAuthorizationKey: stamped.stampedAuthorizationKey,
      }),
      'revalidation',
    );
  });

  test('a same-UID authorization change is an initial load, so it masks', () => {
    assert.equal(
      resolveAuthorizationLoadMode({
        ...stamped,
        loadViewerUid: 'uid-1',
        loadAuthorizationKey: 'uid-1:acct-1:owner::legacy-shell:authorization-revision:1',
      }),
      'initial',
    );
  });

  test('an account switch is an initial load even at the same revision', () => {
    assert.equal(
      resolveAuthorizationLoadMode({
        ...stamped,
        loadViewerUid: 'uid-2',
        loadAuthorizationKey: stamped.stampedAuthorizationKey,
      }),
      'initial',
    );
  });

  test('a viewer holding nothing yet always gets the masking path', () => {
    assert.equal(
      resolveAuthorizationLoadMode({
        stampedViewerUid: null,
        stampedAuthorizationKey: null,
        loadViewerUid: 'uid-1',
        loadAuthorizationKey: stamped.stampedAuthorizationKey,
      }),
      'initial',
    );
  });
});

describe('property coverage — the hotel the operator is working in', () => {
  test('a revalidation keeps the current hotel and its capability snapshot', () => {
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'revalidation',
        coverageIds: ['a', 'b'],
        activePropertyId: 'b',
        actingHotelId: null,
        storedPropertyId: 'a',
      }),
      { activePropertyId: 'b', resetCapabilitySnapshot: false },
      'a refocus must not re-derive the selection from localStorage',
    );
  });

  test('a revalidation that revokes the current hotel drops it and its capabilities', () => {
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'revalidation',
        coverageIds: ['a'],
        activePropertyId: 'b',
        actingHotelId: null,
        storedPropertyId: 'b',
      }),
      { activePropertyId: 'a', resetCapabilitySnapshot: true },
    );
  });

  test('losing every hotel leaves nothing selected', () => {
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'revalidation',
        coverageIds: [],
        activePropertyId: 'b',
        actingHotelId: null,
        storedPropertyId: 'b',
      }),
      { activePropertyId: null, resetCapabilitySnapshot: true },
    );
  });

  test('an initial load always re-derives and always clears capabilities', () => {
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'initial',
        coverageIds: ['a', 'b'],
        activePropertyId: 'b',
        actingHotelId: null,
        storedPropertyId: 'b',
      }),
      { activePropertyId: 'b', resetCapabilitySnapshot: true },
      "a fresh identity may never inherit the previous one's capability map",
    );
  });

  test('the stored hotel wins over first-in-list when it is still covered', () => {
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'initial',
        coverageIds: ['a', 'b'],
        activePropertyId: null,
        actingHotelId: null,
        storedPropertyId: 'b',
      }),
      { activePropertyId: 'b', resetCapabilitySnapshot: true },
    );
  });

  test('an acting hotel pins the selection regardless of what was stored', () => {
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'revalidation',
        coverageIds: ['a', 'b'],
        activePropertyId: 'b',
        actingHotelId: 'b',
        storedPropertyId: 'a',
      }),
      { activePropertyId: 'b', resetCapabilitySnapshot: false },
    );
    assert.deepEqual(
      resolveCoverageSelection({
        mode: 'revalidation',
        coverageIds: ['a', 'b'],
        activePropertyId: 'a',
        actingHotelId: 'b',
        storedPropertyId: 'a',
      }),
      { activePropertyId: 'b', resetCapabilitySnapshot: true },
    );
  });
});

describe('property coverage — the capability map holds still too', () => {
  // PropertyContext asks this exact question before touching the capability
  // snapshot: same answer as what is on screen -> do not call setState at all,
  // so the overrides object keeps its reference and useCan() stays put.
  const restriction: CapabilityOverrideMap = {
    manage_team: { front_desk: false },
    view_activity_log: { housekeeping: false },
  };

  test('an unchanged access map is recognised as the same answer', () => {
    const refetched: CapabilityOverrideMap = {
      manage_team: { front_desk: false },
      view_activity_log: { housekeeping: false },
    };

    assert.equal(sameAuthorizationValue(restriction, refetched), true);
  });

  test('key order is not a change', () => {
    const refetched: CapabilityOverrideMap = {
      view_activity_log: { housekeeping: false },
      manage_team: { front_desk: false },
    };

    assert.equal(sameAuthorizationValue(restriction, refetched), true);
  });

  test('a lifted restriction is a change', () => {
    assert.equal(
      sameAuthorizationValue(restriction, { view_activity_log: { housekeeping: false } }),
      false,
    );
  });

  test('a restriction widened to another role is a change', () => {
    assert.equal(
      sameAuthorizationValue(restriction, {
        manage_team: { front_desk: false, housekeeping: false },
        view_activity_log: { housekeeping: false },
      }),
      false,
    );
  });

  test('a flipped restriction is a change', () => {
    assert.equal(
      sameAuthorizationValue(restriction, {
        manage_team: { front_desk: true },
        view_activity_log: { housekeeping: false },
      }),
      false,
    );
  });

  test('two empty maps are the same answer', () => {
    assert.equal(sameAuthorizationValue({}, {}), true);
  });
});

describe('property coverage — structural comparison edge cases', () => {
  test('null is distinguished from an empty object and from undefined', () => {
    assert.equal(sameAuthorizationValue(null, {}), false);
    assert.equal(sameAuthorizationValue(null, undefined), false);
    assert.equal(sameAuthorizationValue(null, null), true);
  });

  test('an array is never equal to an object with the same indices', () => {
    assert.equal(sameAuthorizationValue(['a'], { 0: 'a' }), false);
  });

  test('a shorter array is not a prefix match', () => {
    assert.equal(sameAuthorizationValue(['a'], ['a', 'b']), false);
  });

  test('primitives compare by value', () => {
    assert.equal(sameAuthorizationValue(1, 1), true);
    assert.equal(sameAuthorizationValue(1, '1'), false);
    assert.equal(sameAuthorizationValue(false, 0), false);
  });
});
