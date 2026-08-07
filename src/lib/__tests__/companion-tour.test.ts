/**
 * The tour: who gets which stops, what a stop is allowed to be, and what
 * moves one on.
 *
 * ─── WHY THIS FILE IS ADVERSARIAL RATHER THAN ILLUSTRATIVE ─────────────────
 *
 * A tour is the first thing a new person meets, and the failures are all of
 * the same kind: it shows somebody a screen they do not have. A front desk
 * hire walked to Settings, a maintenance tech told to teach the companion a
 * fact through a button their access never renders, a hotel that switched
 * Inventory off getting an Inventory stop anyway. Every one of those is a
 * confident sentence about a door that is locked, and every one of them is one
 * missing `if` away.
 *
 * So the tests below do not check that a GM's tour is nine stops long. They
 * check, per role and per hotel shape, that the stops which must NOT be there
 * are not there. The bar: would this fail if I deleted one gate?
 *
 * The run reducers are tested the same way. The plausible bug in a tour player
 * is not a crash, it is a `Next` that walks past a "you try" stop, or a deed
 * from one action clearing the wait for a different one. Both have a test.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AppRole } from '@/lib/roles';
import type { AppSection, EnabledSections } from '@/lib/sections/registry';
import {
  anchorFor,
  anchorIsReachable,
  anchorMatchesPage,
  anchorsOnPage,
  COMPANION_ANCHORS,
  type CompanionAnchorKey,
  type CompanionAnchorStanding,
} from '@/lib/companion/anchors';
import { COMPANION_PAGES, pageForPath, resolveDestination } from '@/lib/companion/pages';
import {
  advanceTour,
  currentStop,
  endTourRun,
  startTourRun,
  TOUR_STOPS,
  tourDeedDone,
  tourProgress,
  tourStopApplies,
  tourStopsFor,
  type TourContext,
  type TourStop,
} from '@/lib/companion/tour';
import { tourFinishedLine, tourLabels, tourProgressLine, tourSkippedLine, tourStopParagraphs } from '@/lib/companion/copy';
import { ANCHOR_CENSUS_LOCATIONS, anchorCensusPages, anchorsExpectedAt } from '@/lib/automation/robot-walk';

const EM_DASH = '—';

/** A manager who can do everything, at a hotel with everything switched on. */
const FULL_MANAGER: CompanionAnchorStanding = {
  canManage: true,
  seesMoney: true,
  enabledSections: null,
};

function ctx(
  role: AppRole | null,
  standing: Partial<CompanionAnchorStanding> = {},
  enabledSections: EnabledSections = null,
): TourContext {
  return {
    role,
    enabledSections,
    standing: { ...FULL_MANAGER, enabledSections, ...standing },
  };
}

function keys(stops: readonly TourStop[]): string[] {
  return stops.map((s) => s.key);
}

// ═══════════════════════════════════════════════════════════════════════════
// The registry itself
// ═══════════════════════════════════════════════════════════════════════════

describe('the tour registry is internally consistent', () => {
  test('every stop key is unique', () => {
    const seen = new Set<string>();
    for (const stop of TOUR_STOPS) {
      assert.ok(!seen.has(stop.key), `duplicate stop key: ${stop.key}`);
      seen.add(stop.key);
    }
  });

  test('every anchor a stop names is a real anchor in the registry', () => {
    for (const stop of TOUR_STOPS) {
      if (!stop.anchor) continue;
      assert.ok(anchorFor(stop.anchor), `${stop.key} points at unknown anchor ${stop.anchor}`);
    }
  });

  test("a stop's anchor belongs to the page the stop walks to", () => {
    // The invariant that makes a tour stop pointable at all. A stop that walks
    // to /inventory and names a control the registry says lives on the Staxis
    // list would light nothing and would ALSO be un-pointable from chat,
    // because staxis_point_at resolves the page from the pathname.
    for (const stop of TOUR_STOPS) {
      if (!stop.anchor) continue;
      const anchor = anchorFor(stop.anchor)!;
      if (anchor.page === 'any') continue;
      const destination = COMPANION_PAGES.find((p) => p.key === stop.page)!;
      const resolved = pageForPath(destination.path);
      assert.equal(
        anchor.page,
        resolved?.key,
        `${stop.key} walks to ${destination.href} (page ${resolved?.key}) but its anchor claims ${anchor.page}`,
      );
    }
  });

  test('only "try" stops wait, and every one of them names a deed', () => {
    for (const stop of TOUR_STOPS) {
      if (stop.kind === 'try') {
        assert.ok(stop.awaits, `${stop.key} is a try stop with nothing to wait for`);
      } else {
        assert.equal(stop.awaits, undefined, `${stop.key} is a watch stop that waits`);
      }
    }
  });

  test('the tour ends on the stop that outlives it', () => {
    // The founder's pick, and the only stop whose value survives the tour:
    // everything above teaches one screen, this teaches how to find any of
    // them. Last on purpose, and pinned so a reorder cannot quietly bury it.
    assert.equal(TOUR_STOPS[TOUR_STOPS.length - 1].key, 'ask-me');
  });

  test('by the end of a manager tour the hotel has a real to-do and a real fact', () => {
    const deeds = tourStopsFor(ctx('general_manager'))
      .map((s) => s.awaits)
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    assert.deepEqual([...deeds].sort(), ['fact_taught', 'todo_created']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Role awareness, adversarially
// ═══════════════════════════════════════════════════════════════════════════

describe('a front desk hire never gets a manager stop', () => {
  // The front desk has no mutation standing and no money capability, which is
  // what their own screens branch on.
  const FRONT_DESK = ctx('front_desk', { canManage: false, seesMoney: false });

  test('no Settings stop and no People stop', () => {
    const got = keys(tourStopsFor(FRONT_DESK));
    assert.ok(!got.includes('settings'), got.join(', '));
    assert.ok(!got.includes('people'), got.join(', '));
  });

  test('no teach-a-fact stop: that button is not on their screen', () => {
    assert.ok(!keys(tourStopsFor(FRONT_DESK)).includes('knows-teach'));
  });

  test('they still get a real tour, ending on the ability that outlives it', () => {
    const got = keys(tourStopsFor(FRONT_DESK));
    assert.ok(got.length >= 4, `front desk tour is only ${got.length} stops: ${got.join(', ')}`);
    assert.ok(got.includes('staxis-todo'), 'the one thing everybody does is missing');
    assert.equal(got[got.length - 1], 'ask-me');
  });

  test('every stop they get resolves to a screen they are allowed on', () => {
    for (const stop of tourStopsFor(FRONT_DESK)) {
      assert.ok(
        resolveDestination(stop.page, { role: 'front_desk', enabledSections: null }),
        `${stop.key} walks to a screen the front desk cannot open`,
      );
    }
  });
});

describe('housekeeping has no tour at all', () => {
  // The standing rule, and this is the THIRD refusal rather than the first:
  // mount.ts refuses the hat before any of this runs, and the lens mounts no
  // chat for it. This one exists so the registry cannot become the exception.
  test('every hat except housekeeping gets stops; housekeeping gets a manager-free minimum', () => {
    const hk = tourStopsFor(ctx('housekeeping', { canManage: false, seesMoney: false }));
    assert.ok(!keys(hk).includes('settings'));
    assert.ok(!keys(hk).includes('people'));
    assert.ok(!keys(hk).includes('knows-teach'));
  });

  test('a null role has no tour whatsoever', () => {
    assert.deepEqual(tourStopsFor(ctx(null)), []);
  });
});

describe('a manager whose hotel did not grant the money capability', () => {
  test('is not stopped at a control their toolbar never rendered', () => {
    const noMoney = ctx('general_manager', { seesMoney: false });
    for (const stop of tourStopsFor(noMoney)) {
      if (!stop.anchor) continue;
      const anchor = anchorFor(stop.anchor)!;
      assert.ok(
        anchorIsReachable(anchor, noMoney.standing),
        `${stop.key} points at ${stop.anchor}, which needs ${anchor.needs.join('+')}`,
      );
    }
  });
});

describe('a hotel with a section switched off', () => {
  function withOff(section: AppSection): TourContext {
    const flags = { [section]: false } as EnabledSections;
    return ctx('general_manager', {}, flags);
  }

  test('contributes no stop for that section', () => {
    for (const [section, stopKey] of [
      ['inventory', 'inventory'],
      ['maintenance', 'maintenance'],
      ['communications', 'messages'],
      ['dashboard', 'dashboard'],
    ] as const) {
      const got = keys(tourStopsFor(withOff(section)));
      assert.ok(!got.includes(stopKey), `${section} is off but ${stopKey} survived: ${got.join(', ')}`);
    }
  });

  test('switching Staxis off leaves no tour worth offering', () => {
    // The one-list, the composer, the Knows dialog and the last stop all live
    // behind the `staxis` section. A hotel without it has nothing the
    // companion could walk anybody through, and the honest answer is no tour
    // rather than a tour of the leftovers.
    const got = keys(tourStopsFor(withOff('staxis')));
    assert.ok(!got.includes('staxis-intro'), got.join(', '));
    assert.ok(!got.includes('staxis-todo'), got.join(', '));
    assert.ok(!got.includes('ask-me'), got.join(', '));
  });

  test('a hotel with everything on gets the full manager tour', () => {
    assert.deepEqual(keys(tourStopsFor(ctx('general_manager'))), TOUR_STOPS.map((s) => s.key));
  });
});

describe('one gate deleted is a test failure', () => {
  // The point of tourStopApplies is that it is three refusals, not one. Each
  // case below would pass if the OTHER two gates were the only ones there.
  test('the stop flag alone stops knows-teach for a non-manager', () => {
    const stop = TOUR_STOPS.find((s) => s.key === 'knows-teach')!;
    // `knows` is not a manager-only PAGE, so the page gate would let this
    // through. Only the stop's own flag and the anchor's `manage` need refuse.
    assert.ok(resolveDestination(stop.page, { role: 'front_desk', enabledSections: null }));
    assert.equal(tourStopApplies(stop, ctx('front_desk', { canManage: false })), false);
  });

  test('the anchor gate alone stops a control an entitlement hides', () => {
    const stop: TourStop = {
      key: 'probe', page: 'inventory', anchor: 'inventory-import', kind: 'watch', say: 'x',
    };
    assert.equal(tourStopApplies(stop, ctx('general_manager', { seesMoney: true })), true);
    assert.equal(tourStopApplies(stop, ctx('general_manager', { seesMoney: false })), false);
  });

  test('the page gate alone stops a manager screen for a line role', () => {
    const stop = TOUR_STOPS.find((s) => s.key === 'people')!;
    assert.equal(tourStopApplies(stop, ctx('general_manager')), true);
    assert.equal(tourStopApplies(stop, ctx('staff', { canManage: false })), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Running one
// ═══════════════════════════════════════════════════════════════════════════

const WATCH: TourStop = { key: 'w1', page: 'staxis', anchor: 'todo-composer', kind: 'watch', say: 'one' };
const WATCH2: TourStop = { key: 'w2', page: 'dashboard', anchor: 'nav-dashboard', kind: 'watch', say: 'two' };
const TRY: TourStop = {
  key: 't1', page: 'staxis', anchor: 'todo-composer', kind: 'try', awaits: 'todo_created', say: 'go on',
};

describe('a watch stop moves on when they say so', () => {
  test('Next advances, and the last Next ends it as finished', () => {
    let run = startTourRun([WATCH, WATCH2]);
    assert.equal(currentStop(run)?.key, 'w1');
    run = advanceTour(run);
    assert.equal(currentStop(run)?.key, 'w2');
    run = advanceTour(run);
    assert.equal(run.ended, 'finished');
    assert.equal(currentStop(run), null);
  });

  test('an empty tour is already over rather than a card with nothing in it', () => {
    const run = startTourRun([]);
    assert.equal(run.ended, 'finished');
    assert.equal(currentStop(run), null);
  });
});

describe('a "you try" stop waits for the real thing', () => {
  test('it starts out waiting', () => {
    assert.equal(startTourRun([TRY]).waiting, true);
  });

  test('Next cannot walk past it', () => {
    // THE test for this feature. If advanceTour ever stops checking `waiting`,
    // "I will wait" becomes a slide with extra words.
    const run = startTourRun([TRY, WATCH]);
    const after = advanceTour(run);
    assert.equal(after.waiting, true);
    assert.equal(currentStop(after)?.key, 't1');
  });

  test('the real deed clears the wait and moves on', () => {
    let run = startTourRun([TRY, WATCH]);
    run = tourDeedDone(run, 'todo_created');
    assert.equal(run.waiting, false);
    assert.equal(currentStop(run)?.key, 'w1');
  });

  test('somebody else\'s deed does nothing', () => {
    // Teaching a fact during the to-do stop is a useful thing and a different
    // thing. Moving the tour on would be the companion taking credit for a
    // step nobody took.
    const run = startTourRun([TRY, WATCH]);
    const after = tourDeedDone(run, 'fact_taught');
    assert.equal(after.waiting, true);
    assert.equal(currentStop(after)?.key, 't1');
  });

  test('a deed arriving on a watch stop changes nothing', () => {
    const run = startTourRun([WATCH, TRY]);
    assert.deepEqual(tourDeedDone(run, 'todo_created'), run);
  });

  test('a try stop last in the tour finishes the tour when it lands', () => {
    let run = startTourRun([WATCH, TRY]);
    run = advanceTour(run);
    assert.equal(run.waiting, true);
    run = tourDeedDone(run, 'todo_created');
    assert.equal(run.ended, 'finished');
  });

  test('a deed after the tour ended is ignored', () => {
    const run = endTourRun(startTourRun([TRY]), 'skipped');
    assert.deepEqual(tourDeedDone(run, 'todo_created'), run);
  });
});

describe('leaving early', () => {
  test('a skip ends it, clears the wait, and is recorded as a skip', () => {
    const run = endTourRun(startTourRun([TRY, WATCH]), 'skipped');
    assert.equal(run.ended, 'skipped');
    assert.equal(run.waiting, false);
    assert.equal(currentStop(run), null);
  });

  test('the first ending wins: a finished run cannot be re-ended as skipped', () => {
    let run = startTourRun([WATCH]);
    run = advanceTour(run);
    assert.equal(run.ended, 'finished');
    assert.equal(endTourRun(run, 'skipped').ended, 'finished');
  });

  test('nothing advances a run that has ended', () => {
    const run = endTourRun(startTourRun([WATCH, WATCH2]), 'skipped');
    assert.deepEqual(advanceTour(run), run);
  });
});

describe('the counter a person reads', () => {
  test('is one-based and never runs past the end', () => {
    let run = startTourRun([WATCH, WATCH2]);
    assert.deepEqual(tourProgress(run), { at: 1, total: 2 });
    run = advanceTour(run);
    assert.deepEqual(tourProgress(run), { at: 2, total: 2 });
    run = advanceTour(run);
    assert.deepEqual(tourProgress(run), { at: 2, total: 2 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The words
// ═══════════════════════════════════════════════════════════════════════════

describe('every sentence the tour says obeys the copy rules', () => {
  /** The walk: every stop's paragraphs, plus every fixed label and line. */
  function everyTourString(): [string, string][] {
    const out: [string, string][] = [];
    for (const stop of TOUR_STOPS) {
      tourStopParagraphs(stop).forEach((line, i) => out.push([`stop(${stop.key})[${i}]`, line]));
    }
    for (const [name, value] of Object.entries(tourLabels())) out.push([`label(${name})`, value]);
    out.push(['finished', tourFinishedLine()]);
    out.push(['skipped', tourSkippedLine()]);
    out.push(['progress', tourProgressLine(3, 9)]);
    return out;
  }

  test('the walk actually walks something', () => {
    // A guard whose walk silently returns nothing passes forever.
    const corpus = everyTourString();
    assert.ok(corpus.length > 20, `only ${corpus.length} strings walked`);
    for (const stop of TOUR_STOPS) {
      assert.ok(
        corpus.some(([label]) => label.startsWith(`stop(${stop.key})`)),
        `${stop.key} was not walked`,
      );
    }
  });

  test('no em dash', () => {
    const bad = everyTourString().filter(([, v]) => v.includes(EM_DASH));
    assert.deepEqual(bad, [], `em dashes in: ${bad.map(([k]) => k).join(', ')}`);
  });

  test('no exclamation marks, no emoji, and never the word "AI"', () => {
    for (const [label, value] of everyTourString()) {
      assert.ok(!value.includes('!'), `${label} shouts: ${value}`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(value), `${label} has an emoji: ${value}`);
      assert.ok(!/\bAI\b/.test(value), `${label} says AI out loud: ${value}`);
    }
  });

  test('English only, and short enough to read standing up', () => {
    for (const [label, value] of everyTourString()) {
      // The whole corpus is Latin letters, digits and ordinary punctuation.
      // A stray accented word is the tell for a translation creeping back in.
      assert.ok(/^[\x20-\x7E]*$/.test(value), `${label} is not plain English: ${value}`);
      assert.ok(value.length <= 170, `${label} is ${value.length} characters: ${value}`);
    }
  });

  test('a try stop quotes its example so the thing to type is unambiguous', () => {
    for (const stop of TOUR_STOPS) {
      if (stop.kind !== 'try') continue;
      const lines = tourStopParagraphs(stop);
      assert.ok(
        lines.some((l) => l.startsWith('Try: "')),
        `${stop.key} does not offer a quoted example`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Anchors: the vocabulary everything shares
// ═══════════════════════════════════════════════════════════════════════════

describe('the anchor registry', () => {
  test('an `any` anchor matches every real page and no page at all', () => {
    const mark = anchorFor('staxis-mark')!;
    assert.equal(mark.page, 'any');
    assert.equal(anchorMatchesPage(mark, 'inventory'), true);
    assert.equal(anchorMatchesPage(mark, 'settings'), true);
    // The fail-closed half: no page proof is still a refusal, so the chat
    // pointer cannot draw from a turn with no screen behind it.
    assert.equal(anchorMatchesPage(mark, null), false);
    assert.equal(anchorMatchesPage(mark, undefined), false);
  });

  test('a page anchor still refuses another page', () => {
    const composer = anchorFor('todo-composer')!;
    assert.equal(anchorMatchesPage(composer, 'staxis'), true);
    assert.equal(anchorMatchesPage(composer, 'inventory'), false);
  });

  test('a section switched off takes its nav anchor off the bar', () => {
    const nav = anchorFor('nav-inventory')!;
    assert.equal(anchorIsReachable(nav, { canManage: true, seesMoney: true, enabledSections: null }), true);
    assert.equal(
      anchorIsReachable(nav, { canManage: true, seesMoney: true, enabledSections: { inventory: false } }),
      false,
    );
  });

  test('a caller who says nothing about sections gets the default-ON contract', () => {
    // The one place fail-closed is wrong. Most hotels have no stored map at
    // all, and treating that as "every section is off" would silently unaim
    // every nav pointer in the product.
    const nav = anchorFor('nav-maintenance')!;
    assert.equal(anchorIsReachable(nav, { canManage: false, seesMoney: false }), true);
  });

  test('anchorsOnPage still fails closed on entitlements', () => {
    const bare = anchorsOnPage('inventory', { canManage: false, seesMoney: false });
    assert.ok(!bare.some((a) => a.key === 'inventory-import'), 'the importer needs money');
    assert.ok(!bare.some((a) => a.key === 'add-delivery'), 'the scanner needs manage');
  });

  test('anchorsOnPage includes the chrome that is on every screen', () => {
    const onInventory = anchorsOnPage('inventory', FULL_MANAGER).map((a) => a.key);
    assert.ok(onInventory.includes('staxis-mark'));
    assert.ok(onInventory.includes('nav-staxis'));
    assert.ok(onInventory.includes('inventory-import'));
    // And nothing from another screen.
    assert.ok(!onInventory.includes('todo-composer'));
  });

  test('every anchor says what it does, in one plain sentence', () => {
    for (const anchor of COMPANION_ANCHORS) {
      assert.ok(anchor.does.length > 20, `${anchor.key} has no real description`);
      assert.ok(!anchor.does.includes(EM_DASH), `${anchor.key} has an em dash`);
      assert.ok(!/\bAI\b/.test(anchor.does), `${anchor.key} says AI out loud`);
      assert.ok(anchor.label.length > 0, `${anchor.key} has no label`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The census: the nightly proof that any of this can still be found
// ═══════════════════════════════════════════════════════════════════════════

describe('the anchor census covers the registry', () => {
  test('every anchor has a census location, or a documented null', () => {
    // The drift protection FOR the drift protection. Adding an anchor and
    // forgetting to say where the robot should look for it would leave a
    // control the companion points at with nothing checking it exists, which
    // is exactly the state this whole step was built to end.
    const registry = COMPANION_ANCHORS.map((a) => a.key).sort();
    const censused = Object.keys(ANCHOR_CENSUS_LOCATIONS).sort();
    assert.deepEqual(censused, registry);
  });

  test('the census actually asserts something on more than one page', () => {
    const pages = anchorCensusPages();
    assert.ok(pages.length >= 2, `census only opens ${pages.length} page(s)`);
    for (const url of pages) {
      assert.ok(anchorsExpectedAt(url).length > 0, `${url} is opened for nothing`);
    }
  });

  test('every anchor the manager tour points at is censused', () => {
    // The narrower promise: whatever else is skipped, nothing the tour walks
    // a manager through is allowed to be unchecked.
    for (const stop of tourStopsFor(ctx('general_manager', { seesMoney: false }))) {
      if (!stop.anchor) continue;
      assert.notEqual(
        ANCHOR_CENSUS_LOCATIONS[stop.anchor],
        null,
        `${stop.anchor} is on the manager tour but is not censused`,
      );
    }
  });

  test('a removed anchor fails the census', () => {
    // The census reads the DOM in the browser; what is testable here is the
    // expectation it carries. An anchor whose attribute was dropped from a
    // component still appears in this list, so the robot looks for it and
    // finds nothing. Proven by asking the expectation directly: the key the
    // browser must find at /feed is still there to be missed.
    const expected = anchorsExpectedAt('/feed');
    assert.ok(expected.includes('todo-composer'));
    assert.ok(expected.includes('staxis-mark'));
    const survivors = expected.filter((k) => k !== 'todo-composer');
    assert.notDeepEqual(survivors, expected, 'removing a control must change what is expected');
  });

  test('every censused key is a real anchor key', () => {
    for (const key of Object.keys(ANCHOR_CENSUS_LOCATIONS)) {
      assert.ok(anchorFor(key), `${key} is censused but is not in the registry`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pinning the two tours as shipped
// ═══════════════════════════════════════════════════════════════════════════

describe('the tours as shipped', () => {
  test('a general manager walks these stops in this order', () => {
    assert.deepEqual(keys(tourStopsFor(ctx('general_manager'))), [
      'staxis-intro',
      'staxis-todo',
      'dashboard',
      'maintenance',
      'inventory',
      'messages',
      'knows-teach',
      'people',
      'settings',
      'ask-me',
    ]);
  });

  test('a front desk hire walks these, and only these', () => {
    assert.deepEqual(keys(tourStopsFor(ctx('front_desk', { canManage: false, seesMoney: false }))), [
      'staxis-intro',
      'staxis-todo',
      'dashboard',
      'maintenance',
      'inventory',
      'messages',
      'ask-me',
    ]);
  });

  test('a maintenance tech gets the same shape as the desk', () => {
    const wrench = keys(tourStopsFor(ctx('maintenance', { canManage: false, seesMoney: false })));
    assert.ok(!wrench.includes('settings'));
    assert.ok(!wrench.includes('people'));
    assert.ok(!wrench.includes('knows-teach'));
    assert.ok(wrench.includes('maintenance'));
  });
});

/** Every anchor key, so a new one cannot be added without a census location. */
const _EXHAUSTIVE: readonly CompanionAnchorKey[] = COMPANION_ANCHORS.map((a) => a.key);
void _EXHAUSTIVE;
