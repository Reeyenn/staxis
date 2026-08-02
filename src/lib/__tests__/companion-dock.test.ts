/**
 * THE ONE OBJECT IN THE CORNER, AND WHERE IT IS ALLOWED TO BE.
 *
 * The Obsidian redesign made a single 86px mark both the companion at rest and
 * the way into the conversation, and gave the person permission to drag it
 * anywhere on the screen. Three things can go wrong with that, all of them
 * silent, and all of them the kind a person only finds by losing the control:
 *
 *   1. the mark ends up outside the window, usually after a resize
 *   2. a drag is read as a click, so putting it down opens the panel
 *   3. the panel or the peek anchors to where the mark USED to be, or hangs off
 *      the edge of the screen once the mark is near one
 *
 * Everything below exercises the real functions the component calls. There is
 * no component here on purpose: the suite runs under --conditions=react-server
 * where react-dom/server will not load, which is exactly why the geometry lives
 * in a plain module.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DOCK_INSET,
  DOCK_GAP,
  DOCK_STORAGE_KEY,
  MARK_SIZE,
  PANEL_WIDTH,
  clampDockPosition,
  defaultDockPosition,
  isDragGesture,
  panelWidthFor,
  peekFits,
  placePanel,
  placePeek,
  readStoredDock,
  writeStoredDock,
  type DockStorage,
  type Vec,
  type Viewport,
} from '@/lib/companion/dock';
import { ALL_ROLES, type AppRole } from '@/lib/roles';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { companionAllowedOnPath, companionMounts } from '@/lib/companion/mount';
import {
  EMPTY_COMPANION_MEMORY,
  decideCompanionSpeech,
  type CompanionCandidate,
  type MannersInput,
} from '@/lib/companion/manners';

const DESKTOP: Viewport = { width: 1440, height: 900 };
const LAPTOP: Viewport = { width: 1280, height: 720 };
const SLIVER: Viewport = { width: 420, height: 380 };

function fakeStorage(seed?: Record<string, string>): DockStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Is the mark entirely inside the window? */
function insideViewport(pos: Vec, viewport: Viewport): boolean {
  return pos.x >= 0
    && pos.y >= 0
    && pos.x + MARK_SIZE <= viewport.width
    && pos.y + MARK_SIZE <= viewport.height;
}

// ─── Where it rests ─────────────────────────────────────────────────────────

describe('the mark at rest', () => {
  test('starts in the bottom right at the design inset', () => {
    const pos = defaultDockPosition(DESKTOP);
    assert.equal(DESKTOP.width - (pos.x + MARK_SIZE), DOCK_INSET);
    assert.equal(DESKTOP.height - (pos.y + MARK_SIZE), DOCK_INSET);
  });

  test('is still on screen on a window too small for the inset', () => {
    // A 320x240 popped-out window is not a design target, but a mark placed
    // off screen in one is a mark nobody can reach again.
    for (const viewport of [{ width: 320, height: 240 }, { width: 120, height: 110 }]) {
      const pos = defaultDockPosition(viewport);
      assert.ok(pos.x >= 0 && pos.y >= 0, `${viewport.width}x${viewport.height} placed it negative`);
    }
  });
});

// ─── Dragging ───────────────────────────────────────────────────────────────

describe('dragging the mark', () => {
  test('a still hand is a click, and a moved hand is a drag', () => {
    // The whole click-versus-drag contract. Under the threshold must be a
    // click even in the worst direction, because a trackpad click is never
    // perfectly still and swallowing it would make the panel feel broken.
    assert.equal(isDragGesture(0, 0), false);
    assert.equal(isDragGesture(4, 4), false);   // 5.66px diagonal
    assert.equal(isDragGesture(-4, 4), false);
    assert.equal(isDragGesture(6, 0), false);   // exactly at the threshold
    assert.equal(isDragGesture(7, 0), true);
    assert.equal(isDragGesture(0, -7), true);
    assert.equal(isDragGesture(-40, 120), true);
  });

  test('a drag anywhere lands somewhere fully on screen', () => {
    // Every corner and every overshoot, including well past the edges.
    const attempts: Vec[] = [
      { x: -500, y: -500 },
      { x: 99_999, y: 99_999 },
      { x: DESKTOP.width, y: 0 },
      { x: 0, y: DESKTOP.height },
      { x: 640, y: 40 },
      { x: 12, y: 480 },
    ];
    for (const attempt of attempts) {
      const landed = clampDockPosition(attempt, DESKTOP);
      assert.ok(insideViewport(landed, DESKTOP), `${JSON.stringify(attempt)} landed off screen`);
    }
  });

  test('a nonsense coordinate does not become a NaN position', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const landed = clampDockPosition({ x: bad, y: bad }, DESKTOP);
      assert.ok(Number.isFinite(landed.x) && Number.isFinite(landed.y), String(bad));
      assert.ok(insideViewport(landed, DESKTOP));
    }
  });

  test('a position saved on a big screen is pulled back in on a small one', () => {
    // The failure this exists for: drag it to the far right on a desktop
    // monitor, close the laptop lid, reopen on the built-in screen, and the
    // companion is gone.
    const storage = fakeStorage();
    const parked = clampDockPosition({ x: 1300, y: 800 }, DESKTOP);
    writeStoredDock(storage, parked);

    const restored = readStoredDock(storage);
    assert.ok(restored);
    const onLaptop = clampDockPosition(restored, LAPTOP);
    assert.ok(insideViewport(onLaptop, LAPTOP));
    assert.ok(onLaptop.x < parked.x || onLaptop.y < parked.y, 'nothing was pulled back in');
  });

  test('the position survives a reload, and going back to the corner forgets it', () => {
    const storage = fakeStorage();
    assert.equal(readStoredDock(storage), null, 'a fresh device must start in the corner');

    writeStoredDock(storage, { x: 210, y: 96 });
    assert.deepEqual(readStoredDock(storage), { x: 210, y: 96 });
    assert.ok(storage.map.has(DOCK_STORAGE_KEY));

    writeStoredDock(storage, null);
    assert.equal(readStoredDock(storage), null);
    assert.equal(storage.map.has(DOCK_STORAGE_KEY), false);
  });

  test('junk in storage is read as "still in the corner", never as a position', () => {
    for (const junk of [
      'not json', '[]', 'null', '{}', '{"x":1}', '{"x":"3","y":"4"}',
      '{"x":null,"y":2}', `{"x":${'9'.repeat(200)},"y":1}`,
    ]) {
      assert.equal(readStoredDock(fakeStorage({ [DOCK_STORAGE_KEY]: junk })), null, junk.slice(0, 24));
    }
    // NaN and Infinity do not survive JSON, but a hand-written value can carry
    // them as literals, which JSON.parse rejects. Either way: the corner.
    assert.equal(readStoredDock(fakeStorage({ [DOCK_STORAGE_KEY]: '{"x":NaN,"y":0}' })), null);
  });

  test('storage that throws costs a remembered position, never the companion', () => {
    const hostile: DockStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    assert.equal(readStoredDock(hostile), null);
    assert.doesNotThrow(() => writeStoredDock(hostile, { x: 10, y: 10 }));
    assert.doesNotThrow(() => writeStoredDock(hostile, null));
    assert.equal(readStoredDock(null), null);
  });
});

// ─── The panel follows the mark ─────────────────────────────────────────────

describe('the panel re-anchors to wherever the mark is', () => {
  test('at rest it opens above the mark, right edges lined up', () => {
    const mark = defaultDockPosition(DESKTOP);
    const panel = placePanel(mark, DESKTOP);
    assert.equal(panel.placement, 'above');
    // The handoff's anchor: right 26, bottom 26 + 86 + 12.
    assert.equal(panel.bottom, DOCK_INSET + MARK_SIZE + DOCK_GAP);
    assert.equal(DESKTOP.width - (panel.left + PANEL_WIDTH), DOCK_INSET);
    assert.equal(panel.top, null);
  });

  test('a mark dragged to the top of the screen flips its panel below', () => {
    const mark = clampDockPosition({ x: 900, y: 0 }, DESKTOP);
    const panel = placePanel(mark, DESKTOP);
    assert.equal(panel.placement, 'below');
    assert.ok(panel.top !== null);
    assert.equal(panel.bottom, null);
    assert.ok(panel.top! >= mark.y + MARK_SIZE, 'the panel covered the mark');
    assert.ok(panel.top! + panel.maxHeight <= DESKTOP.height, 'the panel ran off the bottom');
  });

  test('a mark in any corner keeps the whole panel on screen', () => {
    const corners: Vec[] = [
      { x: -200, y: -200 },
      { x: 99_999, y: -200 },
      { x: -200, y: 99_999 },
      { x: 99_999, y: 99_999 },
    ];
    for (const viewport of [DESKTOP, LAPTOP, SLIVER]) {
      const width = panelWidthFor(viewport);
      for (const corner of corners) {
        const mark = clampDockPosition(corner, viewport);
        const panel = placePanel(mark, viewport);
        const label = `${viewport.width}x${viewport.height} @ ${mark.x},${mark.y}`;

        assert.ok(panel.left >= 0, `${label}: left edge off screen`);
        assert.ok(panel.left + width <= viewport.width, `${label}: right edge off screen`);
        assert.ok(panel.maxHeight > 0, `${label}: no height`);

        const top = panel.top ?? viewport.height - panel.bottom! - panel.maxHeight;
        assert.ok(top >= -1, `${label}: top edge off screen (${top})`);
        assert.ok(top + panel.maxHeight <= viewport.height + 1, `${label}: bottom edge off screen`);
      }
    }
  });

  test('moving the mark moves the panel with it, every time', () => {
    // The one-object rule expressed as geometry: there is a single position,
    // and the panel is derived from it rather than pinned to a corner. A panel
    // that stayed put would be a second object.
    let previous = placePanel(clampDockPosition({ x: 40, y: 600 }, DESKTOP), DESKTOP);
    for (const x of [240, 500, 760, 1020, 1280]) {
      const panel = placePanel(clampDockPosition({ x, y: 600 }, DESKTOP), DESKTOP);
      assert.ok(
        panel.left >= previous.left,
        `panel did not follow the mark rightwards at x=${x}`,
      );
      previous = panel;
    }
  });

  test('a viewport narrower than the panel gets a narrower panel, not an overflow', () => {
    const narrow: Viewport = { width: 300, height: 700 };
    const width = panelWidthFor(narrow);
    assert.ok(width < PANEL_WIDTH);
    const panel = placePanel(defaultDockPosition(narrow), narrow);
    assert.ok(panel.left >= 0);
    assert.ok(panel.left + width <= narrow.width);
  });
});

// ─── The peek follows the mark ──────────────────────────────────────────────

describe('the peek re-anchors to wherever the mark is', () => {
  test('at rest it sits to the left of the mark, 12px away', () => {
    const mark = defaultDockPosition(DESKTOP);
    const peek = placePeek(mark, DESKTOP);
    assert.equal(peek.side, 'left');
    assert.equal(peek.right, DESKTOP.width - mark.x + DOCK_GAP);
    assert.equal(peek.left, null);
    assert.equal(peek.centerY, mark.y + MARK_SIZE / 2);
    assert.ok(peekFits(peek));
  });

  test('a mark dragged to the left edge flips the peek to its right', () => {
    const mark = clampDockPosition({ x: 0, y: 400 }, DESKTOP);
    const peek = placePeek(mark, DESKTOP);
    assert.equal(peek.side, 'right');
    assert.ok(peek.left !== null);
    assert.ok(peek.left! >= mark.x + MARK_SIZE, 'the peek covered the mark');
    assert.ok(peek.left! + peek.maxWidth <= DESKTOP.width, 'the peek ran off the right');
  });

  test('the pill never claims more width than the side it landed on has', () => {
    for (const viewport of [DESKTOP, LAPTOP, SLIVER]) {
      for (const x of [-200, 0, 60, viewport.width / 2, viewport.width - 60, 99_999]) {
        const mark = clampDockPosition({ x, y: viewport.height / 2 }, viewport);
        const peek = placePeek(mark, viewport);
        const label = `${viewport.width}w @ ${mark.x}`;
        assert.ok(peek.maxWidth >= 0, label);
        if (peek.side === 'left') {
          assert.ok(peek.maxWidth <= mark.x - DOCK_GAP, `${label}: pill overlaps the mark`);
        } else {
          assert.ok(
            peek.left! + peek.maxWidth <= viewport.width,
            `${label}: pill runs off the screen`,
          );
        }
      }
    }
  });

  test('a screen with no room beside the mark shows no peek at all', () => {
    // A 60px sliver of a sentence is not information. Hover simply does
    // nothing, which is the same answer as having no sentence.
    const tiny: Viewport = { width: 200, height: 400 };
    const mark = defaultDockPosition(tiny);
    assert.equal(peekFits(placePeek(mark, tiny)), false);
  });

  test('the peek stays vertically on screen for a mark at either extreme', () => {
    for (const y of [-500, 0, DESKTOP.height, 99_999]) {
      const mark = clampDockPosition({ x: 700, y }, DESKTOP);
      const peek = placePeek(mark, DESKTOP);
      assert.ok(peek.centerY > 0 && peek.centerY < DESKTOP.height, `centerY ${peek.centerY}`);
    }
  });
});

// ─── There is exactly one object ────────────────────────────────────────────

describe('one object, not two', () => {
  test('the companion and the chat appear under exactly the same conditions', () => {
    // They are the same object now: the mark IS the companion at rest and the
    // way into the conversation. If these two gates ever disagreed, one of them
    // would be drawing a second thing in that corner, or drawing nothing where
    // the other drew something.
    const paths = ['/dashboard', '/feed', '/inventory', '/housekeeping', '/people', '/settings'];
    for (const role of ALL_ROLES) {
      for (const path of paths) {
        const mark = companionMounts({ pathname: path, role });
        assert.equal(
          mark.mounts,
          chatIsMountedForRole(role) && companionAllowedOnPath(path),
          `${role} on ${path}`,
        );
      }
    }
  });

  test('a housekeeping hat gets no object anywhere, which is both gates agreeing', () => {
    assert.equal(chatIsMountedForRole('housekeeping' as AppRole), false);
    for (const path of ['/dashboard', '/feed', '/inventory', '/housekeeping']) {
      assert.equal(companionMounts({ pathname: path, role: 'housekeeping' }).mounts, false, path);
    }
  });
});

// ─── The peek's sentence comes from a candidate, or there is no peek ─────────

function mannersFixture(over: Partial<MannersInput> = {}): MannersInput {
  return {
    now: new Date('2026-08-01T17:00:00.000Z'),
    today: '2026-08-01',
    person: { firstName: 'Maria', role: 'general_manager', sharedLogin: false },
    memory: {
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T00:00:00.000Z',
      tourDeclined: true,
    },
    candidates: [],
    onScreen: [],
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    wizardAlreadyRan: true,
    multiHotel: false,
    hotelName: 'Comfort Suites Beaumont',
    ...over,
  };
}

function candidate(over: Partial<CompanionCandidate> = {}): CompanionCandidate {
  return {
    topic: 'finding:linen',
    text: '3 rooms have no clean bath towels.',
    sensitivity: 'operational',
    covers: ['finding:1'],
    destination: 'inventory',
    ...over,
  };
}

describe('the peek says a candidate sentence, or says nothing', () => {
  test('with no candidate there is no offer, so hover has nothing to show', () => {
    const speech = decideCompanionSpeech(mannersFixture({ candidates: [] }));
    assert.equal(speech.kind, 'silent');
  });

  test('a candidate whose only sentence is blank is not turned into a peek', () => {
    const speech = decideCompanionSpeech(mannersFixture({
      candidates: [candidate({ text: '   ' })],
    }));
    assert.equal(speech.kind, 'silent', 'an empty sentence became something to say');
  });

  test('the offer carries the candidate sentence and the candidate severity', () => {
    const speech = decideCompanionSpeech(mannersFixture({
      candidates: [candidate({ severity: 'urgent' })],
    }));
    assert.equal(speech.kind, 'offer');
    assert.ok(speech.kind === 'offer');
    assert.ok(speech.sentence.includes('clean bath towels'), speech.sentence);
    assert.equal(speech.severity, 'urgent');
  });

  test('a candidate with no severity reads as the middle, never as urgent', () => {
    // The mark turns Wrong on urgent. A missing field must not be able to light
    // the corner up amber for something nobody graded.
    const speech = decideCompanionSpeech(mannersFixture({ candidates: [candidate()] }));
    assert.ok(speech.kind === 'offer');
    assert.equal(speech.severity, 'watch');
  });

  test('a topic already turned down twice produces no peek', () => {
    const speech = decideCompanionSpeech(mannersFixture({
      candidates: [candidate({ severity: 'urgent' })],
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        topics: { 'finding:linen': { declines: 2, dropped: true, lastOfferedDay: null } },
      },
    }));
    assert.equal(speech.kind, 'silent');
  });

  test('a sentence already on the screen is not repeated in the corner', () => {
    const speech = decideCompanionSpeech(mannersFixture({
      candidates: [candidate()],
      onScreen: ['finding:1'],
    }));
    assert.equal(speech.kind, 'silent');
  });
});
