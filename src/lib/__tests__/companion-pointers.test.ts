/**
 * DISCOVERY POINTERS — one per visit, three ways out, and never an arrow to
 * nothing.
 *
 * What is being held here:
 *   - the selection rule (one per visit, ordered, dropped topics skipped)
 *   - all three dismissals, INCLUDING using the control, which is the one that
 *     has no button and is therefore the easiest to break silently
 *   - the never-again round trip through the real memory parser, so a No that
 *     did not survive a database round trip fails here rather than a week later
 *   - the role gate, from the companion's own mount rule
 *   - the geometry: a popup beside the control, an arrow that lands ON it, and
 *     a refusal when the control measures as nothing
 *   - the anchor registry, which is the whole of "the model cannot point at
 *     something that is not there"
 *   - a producer walk over the copy, the same shape as the trace's guard: it
 *     CALLS pointerLine and reads the output, so a dash assembled at runtime is
 *     caught and a harmless rename is not.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  pickPointer,
  pointersForPage,
  pointerTopic,
  rememberDroppedTopic,
  POINTER_DELAY_MS,
} from '@/lib/companion/pointers';
import {
  INVENTORY_POINTER_ORDER,
  STAXIS_POINTER_ORDER,
  pointerAcknowledgeButtons,
  pointerLine,
  type CompanionPointerKey,
} from '@/lib/companion/copy';
import {
  EMPTY_COMPANION_MEMORY,
  parseCompanionMemory,
  rememberSpoke,
} from '@/lib/companion/manners';
import { COMPANION_DECLINES_BEFORE_DROP } from '@/lib/companion/charter';
import { companionMounts } from '@/lib/companion/mount';
import {
  COMPANION_ANCHORS,
  COMPANION_ANCHOR_ATTR,
  anchorFor,
  anchorSelector,
  anchorsOnPage,
} from '@/lib/companion/anchors';
import { layoutPointer, EDGE_MARGIN } from '@/lib/companion/trace/geometry';
import { ALL_ROLES } from '@/lib/roles';

const TODAY = '2026-08-05';
const TOMORROW = '2026-08-06';
const NOW = new Date('2026-08-05T15:00:00.000Z');

const ALL_KEYS: readonly CompanionPointerKey[] = [
  ...INVENTORY_POINTER_ORDER,
  ...STAXIS_POINTER_ORDER,
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. ONE PER VISIT
// ═══════════════════════════════════════════════════════════════════════════

describe('one pointer per visit', () => {
  test('the importer is offered before the invoice reader', () => {
    // A hotel arriving with a spreadsheet has no deliveries to photograph yet.
    assert.deepEqual([...INVENTORY_POINTER_ORDER], ['inventory_import', 'inventory_invoices']);
    assert.equal(pickPointer(pointersForPage('inventory'), EMPTY_COMPANION_MEMORY, TODAY)?.key, 'inventory_import');
  });

  test('two unanswered pointers still produce exactly one', () => {
    const picked = pickPointer(pointersForPage('inventory'), EMPTY_COMPANION_MEMORY, TODAY);
    assert.ok(picked);
    const after = rememberSpoke(EMPTY_COMPANION_MEMORY, picked.topic, NOW, TODAY);
    const second = pickPointer(pointersForPage('inventory'), after, TODAY);
    assert.notEqual(second?.key, picked.key);
    assert.equal(second?.key, 'inventory_invoices');
  });

  test('once both have been shown today there is nothing left to say', () => {
    let memory = EMPTY_COMPANION_MEMORY;
    for (let i = 0; i < INVENTORY_POINTER_ORDER.length; i++) {
      const next = pickPointer(pointersForPage('inventory'), memory, TODAY);
      assert.ok(next);
      memory = rememberSpoke(memory, next.topic, NOW, TODAY);
    }
    assert.equal(pickPointer(pointersForPage('inventory'), memory, TODAY), null);
  });

  test('each screen only ever offers its own pointers', () => {
    const inventory = pointersForPage('inventory').map((p) => p.key);
    const staxis = pointersForPage('staxis').map((p) => p.key);
    assert.deepEqual(staxis, ['todo_intro']);
    assert.equal(inventory.includes('todo_intro'), false);
    assert.equal(staxis.some((k) => inventory.includes(k)), false);
  });

  test('a screen with no pointers produces none rather than throwing', () => {
    for (const page of ['dashboard', 'maintenance', 'people', 'knows', 'messages', 'settings'] as const) {
      assert.deepEqual(pointersForPage(page), []);
    }
  });

  test('a missing memory is treated as a first visit, not as a crash', () => {
    assert.equal(pickPointer(pointersForPage('inventory'), null, TODAY)?.key, 'inventory_import');
    assert.equal(pickPointer(pointersForPage('staxis'), undefined, TODAY)?.key, 'todo_intro');
  });

  test('the topics are namespaced so they cannot collide with a finding', () => {
    for (const page of ['inventory', 'staxis'] as const) {
      for (const p of pointersForPage(page)) {
        assert.match(p.topic, /^pointer:/);
        assert.ok(p.topic.length <= 200, 'must survive parseCompanionMemory');
      }
    }
  });

  test('it waits for the screen to settle before speaking', () => {
    assert.equal(POINTER_DELAY_MS, 3_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE THREE WAYS OUT
// ═══════════════════════════════════════════════════════════════════════════

describe('the three ways a pointer ends', () => {
  test('"Not now" means the next visit, a day later, and writes nothing new', () => {
    const first = pickPointer(pointersForPage('inventory'), EMPTY_COMPANION_MEMORY, TODAY);
    assert.ok(first);
    // Showing it is the only write. "Not now" adds nothing on top: that is why
    // the button can promise another day rather than another chance.
    const memory = rememberSpoke(EMPTY_COMPANION_MEMORY, first.topic, NOW, TODAY);
    assert.equal(memory.topics[first.topic].dropped, false);
    assert.notEqual(pickPointer(pointersForPage('inventory'), memory, TODAY)?.key, first.key);
    assert.equal(pickPointer(pointersForPage('inventory'), memory, TOMORROW)?.key, first.key);
  });

  test('"Do not show this again" means never, first time asked', () => {
    const topic = pointerTopic('inventory_import');
    const memory = rememberDroppedTopic(EMPTY_COMPANION_MEMORY, topic, TODAY);
    assert.equal(memory.topics[topic].dropped, true);
    assert.ok(memory.topics[topic].declines >= COMPANION_DECLINES_BEFORE_DROP);
    for (const day of [TODAY, TOMORROW, '2027-01-01']) {
      assert.notEqual(pickPointer(pointersForPage('inventory'), memory, day)?.key, 'inventory_import');
    }
  });

  test('using the control is the same as never, because they have found it', () => {
    // The acknowledgment path has no button, so nothing about it is obvious
    // from reading a component. It is the SAME reducer as the explicit never:
    // one definition of "gone for good", reached two ways.
    const topic = pointerTopic('inventory_invoices');
    const shown = rememberSpoke(EMPTY_COMPANION_MEMORY, topic, NOW, TODAY);
    const tapped = rememberDroppedTopic(shown, topic, TODAY);
    assert.equal(tapped.topics[topic].dropped, true);
    for (const day of [TODAY, TOMORROW, '2027-06-01']) {
      assert.notEqual(pickPointer(pointersForPage('inventory'), tapped, day)?.key, 'inventory_invoices');
    }
  });

  test('the to-do pointer offers exactly one way out, and it is forever', () => {
    const line = pointerLine('todo_intro');
    assert.equal(line.buttons.length, 1);
    assert.equal(line.buttons[0].label, 'Got it');
    assert.equal(line.buttons[0].answer, 'never');
    const memory = rememberDroppedTopic(EMPTY_COMPANION_MEMORY, pointerTopic('todo_intro'), TODAY);
    assert.equal(pickPointer(pointersForPage('staxis'), memory, '2028-01-01'), null);
  });

  test('the inventory pointers offer a later AND a never, in that order', () => {
    for (const key of INVENTORY_POINTER_ORDER) {
      const line = pointerLine(key);
      assert.deepEqual(line.buttons.map((b) => b.answer), ['later', 'never']);
      assert.deepEqual(line.buttons.map((b) => b.label), ['Not now', 'Do not show this again']);
    }
  });

  test('dropping one pointer leaves the other alone', () => {
    const memory = rememberDroppedTopic(EMPTY_COMPANION_MEMORY, pointerTopic('inventory_import'), TODAY);
    assert.equal(pickPointer(pointersForPage('inventory'), memory, TODAY)?.key, 'inventory_invoices');
  });

  test('dropping every pointer leaves nothing at all, forever', () => {
    let memory = EMPTY_COMPANION_MEMORY;
    for (const key of ALL_KEYS) memory = rememberDroppedTopic(memory, pointerTopic(key), TODAY);
    assert.equal(pickPointer(pointersForPage('inventory'), memory, TOMORROW), null);
    assert.equal(pickPointer(pointersForPage('staxis'), memory, TOMORROW), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. NEVER-AGAIN SURVIVES THE DATABASE
// ═══════════════════════════════════════════════════════════════════════════

describe('a never-again survives the round trip it actually makes', () => {
  test('through JSON and the real parser, for every pointer', () => {
    // The memory is a jsonb column read back through parseCompanionMemory, and
    // a No that did not survive that trip would look fine in every unit test
    // and come back the next morning in production. So the trip is the test.
    for (const key of ALL_KEYS) {
      const topic = pointerTopic(key);
      const written = rememberDroppedTopic(EMPTY_COMPANION_MEMORY, topic, TODAY);
      const roundTripped = parseCompanionMemory(JSON.parse(JSON.stringify(written)));
      assert.equal(roundTripped.topics[topic]?.dropped, true, `${key} lost its No`);

      const page = INVENTORY_POINTER_ORDER.includes(key) ? 'inventory' : 'staxis';
      assert.notEqual(pickPointer(pointersForPage(page), roundTripped, '2029-03-03')?.key, key);
    }
  });

  test('a topic key stays inside the length the parser will accept', () => {
    for (const key of ALL_KEYS) {
      const topic = pointerTopic(key);
      const parsed = parseCompanionMemory({
        topics: { [topic]: { declines: 2, dropped: true, lastOfferedDay: TODAY } },
      });
      assert.equal(parsed.topics[topic]?.dropped, true, `${topic} was dropped by the parser`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. WHO IS SPOKEN TO
// ═══════════════════════════════════════════════════════════════════════════

describe('never on a housekeeper screen', () => {
  test('the companion mount rule refuses the housekeeper pages', () => {
    for (const path of ['/housekeeper', '/housekeeper/abc-123', '/laundry', '/laundry/x']) {
      assert.equal(
        companionMounts({ pathname: path, role: 'general_manager' }).mounts,
        false,
        `${path} must be off limits`,
      );
    }
  });

  test('a housekeeping role gets no pointer on any screen a pointer lives on', () => {
    for (const path of ['/inventory', '/feed']) {
      assert.equal(companionMounts({ pathname: path, role: 'housekeeping' }).mounts, false);
    }
  });

  test('a manager on either screen does get one, or the gate proves nothing', () => {
    for (const path of ['/inventory', '/feed']) {
      assert.equal(companionMounts({ pathname: path, role: 'general_manager' }).mounts, true);
    }
  });

  test('every role is decided by the gate rather than by a component', () => {
    for (const role of ALL_ROLES) {
      const decision = companionMounts({ pathname: '/feed', role });
      assert.equal(typeof decision.mounts, 'boolean', `${role} had no decision`);
      if (role === 'housekeeping') assert.equal(decision.mounts, false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE ANCHOR REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

describe('the controls the companion may point at', () => {
  test('every pointer names a control that is really in the registry', () => {
    for (const key of ALL_KEYS) {
      assert.ok(anchorFor(pointerLine(key).anchor), `${key} points at an anchor nobody registered`);
    }
  });

  test('a pointer and its anchor agree about which screen they are on', () => {
    for (const key of INVENTORY_POINTER_ORDER) {
      assert.equal(anchorFor(pointerLine(key).anchor)?.page, 'inventory');
    }
    for (const key of STAXIS_POINTER_ORDER) {
      assert.equal(anchorFor(pointerLine(key).anchor)?.page, 'staxis');
    }
  });

  test('an unknown key resolves to nothing, whatever shape it arrives in', () => {
    const junk = ['', '   nope', 'INVENTORY-IMPORT', 'todo_composer', 'x'.repeat(400), null, undefined, 42, {}];
    for (const bad of junk) {
      assert.equal(anchorFor(bad as string), null, `${String(bad)} must not resolve`);
      assert.equal(anchorSelector(bad as string), null);
    }
  });

  test('the selector is built from the registry key and nothing else', () => {
    assert.equal(anchorSelector('inventory-import'), `[${COMPANION_ANCHOR_ATTR}="inventory-import"]`);
    // A quote or a backslash in a key would be the only way a selector could
    // be broken open, so no key may contain one in the first place.
    for (const a of COMPANION_ANCHORS) {
      assert.match(a.key, /^[a-z0-9-]+$/, `${a.key} is not a plain key`);
    }
  });

  test('page scoping is exact, so a key from one screen is never offered on another', () => {
    assert.deepEqual(anchorsOnPage('inventory').map((a) => a.key).sort(), ['add-delivery', 'inventory-import']);
    assert.deepEqual(anchorsOnPage('staxis').map((a) => a.key), ['todo-composer']);
    assert.deepEqual(anchorsOnPage('dashboard'), []);
    assert.deepEqual(anchorsOnPage(null), []);
    assert.deepEqual(anchorsOnPage(undefined), []);
  });

  test('every key is unique, or two controls would answer to one name', () => {
    const keys = COMPANION_ANCHORS.map((a) => a.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. WHERE THE POPUP GOES AND WHERE THE ARROW LANDS
// ═══════════════════════════════════════════════════════════════════════════

const SCREEN = { width: 1280, height: 800 };
const CARD = { width: 328, height: 150 };

/** Is (x, y) inside this box? Half a pixel of slack for the rounding. */
function within(box: { left: number; top: number; width: number; height: number }, x: number, y: number): boolean {
  return x >= box.left - 0.5 && x <= box.left + box.width + 0.5
    && y >= box.top - 0.5 && y <= box.top + box.height + 0.5;
}

describe('the arrow always lands on the control', () => {
  test('a control with no size is never pointed at', () => {
    // This is the whole "never draw an arrow to nowhere" rule: a button inside
    // a display:none branch measures exactly like this.
    assert.equal(layoutPointer({ left: 40, top: 40, width: 0, height: 0 }, SCREEN, CARD), null);
    assert.equal(layoutPointer({ left: 40, top: 40, width: 120, height: 0 }, SCREEN, CARD), null);
    assert.equal(layoutPointer({ left: 40, top: 40, width: 120, height: 30 }, SCREEN, { width: 0, height: 0 }), null);
  });

  test('the arrowhead sits on the control, from every corner of the window', () => {
    const spots = [
      { left: 600, top: 80, width: 120, height: 36 },   // top middle: room below
      { left: 600, top: 740, width: 120, height: 36 },  // bottom: no room below
      { left: 8, top: 380, width: 120, height: 36 },    // hard left
      { left: 1150, top: 380, width: 120, height: 36 }, // hard right
      { left: 4, top: 4, width: 60, height: 20 },       // the corner
      { left: 1200, top: 760, width: 70, height: 30 },  // the other corner
    ];
    for (const spot of spots) {
      const g = layoutPointer(spot, SCREEN, CARD);
      assert.ok(g, `no geometry for ${JSON.stringify(spot)}`);
      assert.ok(
        within(g.glow, g.head.x, g.head.y),
        `arrowhead outside the control: ${JSON.stringify(g.head)} vs ${JSON.stringify(g.glow)}`,
      );
      // And the line it caps must actually reach it.
      assert.equal(g.line.x2, g.head.x);
      assert.equal(g.line.y2, g.head.y);
    }
  });

  test('the line starts on the popup, not beside it', () => {
    const spots = [
      { left: 600, top: 80, width: 120, height: 36 },
      { left: 8, top: 380, width: 120, height: 36 },
      { left: 1150, top: 700, width: 120, height: 36 },
    ];
    for (const spot of spots) {
      const g = layoutPointer(spot, SCREEN, CARD);
      assert.ok(g);
      assert.ok(
        within(g.card, g.line.x1, g.line.y1),
        `line starts off the popup: ${JSON.stringify(g.line)} vs ${JSON.stringify(g.card)}`,
      );
    }
  });

  test('the popup stays inside the window whatever the control is doing', () => {
    for (let x = 0; x <= 1240; x += 80) {
      for (let y = 0; y <= 760; y += 80) {
        const g = layoutPointer({ left: x, top: y, width: 120, height: 36 }, SCREEN, CARD);
        assert.ok(g, `no geometry at ${x},${y}`);
        assert.ok(g.card.left >= EDGE_MARGIN - 0.5, `ran off the left at ${x},${y}`);
        assert.ok(g.card.top >= EDGE_MARGIN - 0.5, `ran off the top at ${x},${y}`);
        assert.ok(g.card.left + g.card.width <= SCREEN.width - EDGE_MARGIN + 0.5, `ran off the right at ${x},${y}`);
        assert.ok(g.card.top + g.card.height <= SCREEN.height - EDGE_MARGIN + 0.5, `ran off the bottom at ${x},${y}`);
      }
    }
  });

  test('a control near the bottom of the window gets its popup above it', () => {
    const g = layoutPointer({ left: 600, top: 770, width: 120, height: 24 }, SCREEN, CARD);
    assert.ok(g);
    assert.notEqual(g.side, 'below');
    assert.ok(g.card.top + g.card.height <= g.glow.top + 1, 'the popup must not cover the control');
  });

  test('a left-rail button on a short window is pointed at from the side', () => {
    // The stockroom rail is 224px wide and its actions sit high on the page.
    // A tall popup under one of them would run off a laptop window, and the
    // right answer is to move beside it rather than to shrink the sentence.
    const g = layoutPointer({ left: 24, top: 120, width: 200, height: 36 }, { width: 1280, height: 300 }, CARD);
    assert.ok(g);
    assert.equal(g.side, 'right');
    assert.ok(within(g.glow, g.head.x, g.head.y));
  });

  test('a phone-width window still produces a popup that fits', () => {
    const phone = { width: 390, height: 700 };
    const g = layoutPointer({ left: 20, top: 300, width: 350, height: 44 }, phone, CARD);
    assert.ok(g);
    assert.ok(g.card.width <= phone.width - EDGE_MARGIN * 2 + 0.5);
    assert.ok(g.card.left >= EDGE_MARGIN - 0.5);
    assert.ok(g.card.left + g.card.width <= phone.width - EDGE_MARGIN + 0.5);
    assert.ok(within(g.glow, g.head.x, g.head.y));
  });

  test('the popup never sits on top of the control it is describing', () => {
    const spots = [
      { left: 600, top: 80, width: 120, height: 36 },
      { left: 600, top: 400, width: 120, height: 36 },
      { left: 24, top: 120, width: 200, height: 36 },
    ];
    for (const spot of spots) {
      const g = layoutPointer(spot, SCREEN, CARD);
      assert.ok(g);
      const overlapX = Math.min(g.card.left + g.card.width, g.glow.left + g.glow.width)
        - Math.max(g.card.left, g.glow.left);
      const overlapY = Math.min(g.card.top + g.card.height, g.glow.top + g.glow.height)
        - Math.max(g.card.top, g.glow.top);
      assert.ok(overlapX <= 0 || overlapY <= 0, `popup covers the control at ${JSON.stringify(spot)}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. WHAT A POINTER IS ALLOWED TO SAY
// ═══════════════════════════════════════════════════════════════════════════
//
// A producer walk, not a grep: it CALLS pointerLine and reads what comes back,
// so a dash joined on at runtime is caught and a harmless rename is not. Same
// shape as trace-copy-rules.test.ts. The anchor registry is walked too, because
// its `does` line is what the CHAT pointer says out loud.

function pointerProse(key: CompanionPointerKey): string[] {
  const line = pointerLine(key);
  return [...line.paragraphs, ...line.buttons.map((b) => b.label)];
}

function everyPointerSentence(): string[] {
  const out = [
    ...ALL_KEYS.flatMap(pointerProse),
    ...COMPANION_ANCHORS.flatMap((a) => [a.label, a.does]),
    // The chat pointer's own way out. Walked here so no companion string a
    // person can read sits outside a producer walk.
    ...pointerAcknowledgeButtons().map((b) => b.label),
  ];
  assert.ok(out.length >= 12, 'the walk must actually cover every pointer');
  return out;
}

describe('what a pointer says', () => {
  test('no em dashes and no en dashes anywhere a person can read', () => {
    for (const line of everyPointerSentence()) {
      assert.equal(line.includes('—'), false, `em dash in: ${line}`);
      assert.equal(line.includes('–'), false, `en dash in: ${line}`);
    }
  });

  test('the word AI never appears, because the companion does not describe itself', () => {
    for (const line of everyPointerSentence()) {
      assert.doesNotMatch(line, /\bAI\b/, `"AI" in: ${line}`);
    }
  });

  test('English only, with no Spanish sibling anywhere in the shape', () => {
    const json = JSON.stringify([...ALL_KEYS.map(pointerLine), ...COMPANION_ANCHORS]);
    for (const word of ['¿', '¡', 'Habitación', 'Inventario', 'Entrega']) {
      assert.equal(json.includes(word), false, `Spanish: ${word}`);
    }
    assert.equal(/"(es|textEs|summaryEs)"\s*:/.test(json), false);
  });

  test('nothing shouts, nothing is empty, and nothing is an emoji', () => {
    for (const line of everyPointerSentence()) {
      assert.ok(line.trim().length > 0, 'an empty sentence is a blank slab on a screen');
      assert.equal(line.includes('!'), false, `exclamation in: ${line}`);
      assert.doesNotMatch(line, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `emoji in: ${line}`);
    }
  });

  test('no pointer asks permission to show what it is already showing', () => {
    // The rejected build asked "Want me to show you where that is?" and then
    // needed a button pressed before anything happened. The popup IS the
    // pointing now, so no way out may be a reveal step.
    for (const key of ALL_KEYS) {
      for (const button of pointerLine(key).buttons) {
        assert.doesNotMatch(button.label, /show me/i, `${key} still has a reveal step`);
        assert.doesNotMatch(button.label, /\?$/, `${key} has a question for a button`);
      }
    }
  });

  test('each pointer names something a person does, in their own words', () => {
    assert.match(pointerLine('inventory_import').paragraphs[0], /spreadsheet/i);
    assert.match(pointerLine('inventory_invoices').paragraphs[0], /invoice/i);
    assert.match(pointerLine('todo_intro').paragraphs[0], /to-do list/i);
  });

  test('the import pointer opens with a question and then answers it', () => {
    const line = pointerLine('inventory_import');
    assert.equal(line.paragraphs.length, 2);
    assert.match(line.paragraphs[0], /\?$/);
    assert.doesNotMatch(line.paragraphs[1], /\?$/);
  });

  test('every pointer has words and at least one way out that ends it forever', () => {
    for (const key of ALL_KEYS) {
      const line = pointerLine(key);
      assert.ok(line.paragraphs.length > 0);
      assert.ok(line.buttons.length > 0);
      assert.ok(line.buttons.some((b) => b.answer === 'never'), `${key} has no way to end it forever`);
    }
  });
});
