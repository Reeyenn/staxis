// Discovery pointers: one per visit, the two buttons meaning what they say,
// and never on a housekeeper's screen.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  inventoryPointers,
  pickPointer,
  pointerTopic,
  rememberDroppedTopic,
  POINTER_DELAY_MS,
} from '@/lib/companion/pointers';
import { INVENTORY_POINTER_ORDER, pointerLine } from '@/lib/companion/copy';
import { EMPTY_COMPANION_MEMORY, rememberSpoke } from '@/lib/companion/manners';
import { COMPANION_DECLINES_BEFORE_DROP } from '@/lib/companion/charter';
import { companionMounts } from '@/lib/companion/mount';
import { ALL_ROLES } from '@/lib/roles';

const TODAY = '2026-08-03';
const TOMORROW = '2026-08-04';
const NOW = new Date('2026-08-03T15:00:00.000Z');

describe('one pointer per visit', () => {
  test('invoices is offered before the importer', () => {
    assert.deepEqual([...INVENTORY_POINTER_ORDER], ['inventory_invoices', 'inventory_import']);
    const first = pickPointer(inventoryPointers(), EMPTY_COMPANION_MEMORY, TODAY);
    assert.equal(first?.key, 'inventory_invoices');
  });

  test('two unanswered pointers still produce exactly one', () => {
    const picked = pickPointer(inventoryPointers(), EMPTY_COMPANION_MEMORY, TODAY);
    assert.ok(picked);
    // Showing it stamps today, and the SAME visit cannot produce another.
    const after = rememberSpoke(EMPTY_COMPANION_MEMORY, picked.topic, NOW, TODAY);
    const second = pickPointer(inventoryPointers(), after, TODAY);
    assert.notEqual(second?.key, picked.key);
    assert.equal(second?.key, 'inventory_import');
    // Which is the point: the SECOND one waits for the next visit. Nothing
    // ever renders both, because the caller shows one and stops.
  });

  test('after the first is shown, the next visit today shows nothing new twice', () => {
    let memory = EMPTY_COMPANION_MEMORY;
    const first = pickPointer(inventoryPointers(), memory, TODAY);
    assert.ok(first);
    memory = rememberSpoke(memory, first.topic, NOW, TODAY);
    const second = pickPointer(inventoryPointers(), memory, TODAY);
    assert.ok(second);
    memory = rememberSpoke(memory, second.topic, NOW, TODAY);
    assert.equal(pickPointer(inventoryPointers(), memory, TODAY), null);
  });

  test('"not now" means the next visit, a day later', () => {
    const first = pickPointer(inventoryPointers(), EMPTY_COMPANION_MEMORY, TODAY);
    assert.ok(first);
    const memory = rememberSpoke(EMPTY_COMPANION_MEMORY, first.topic, NOW, TODAY);
    // Same day: gone.
    assert.notEqual(pickPointer(inventoryPointers(), memory, TODAY)?.key, first.key);
    // Next hotel day: back.
    assert.equal(pickPointer(inventoryPointers(), memory, TOMORROW)?.key, first.key);
  });

  test('"do not show again" means never, first time asked', () => {
    const topic = pointerTopic('inventory_import');
    const memory = rememberDroppedTopic(EMPTY_COMPANION_MEMORY, topic, TODAY);
    assert.equal(memory.topics[topic].dropped, true);
    assert.ok(memory.topics[topic].declines >= COMPANION_DECLINES_BEFORE_DROP);
    for (const day of [TODAY, TOMORROW, '2027-01-01']) {
      assert.notEqual(pickPointer(inventoryPointers(), memory, day)?.key, 'inventory_import');
    }
  });

  test('dropping one pointer leaves the other alone', () => {
    const memory = rememberDroppedTopic(EMPTY_COMPANION_MEMORY, pointerTopic('inventory_invoices'), TODAY);
    assert.equal(pickPointer(inventoryPointers(), memory, TODAY)?.key, 'inventory_import');
  });

  test('dropping both leaves nothing at all, forever', () => {
    let memory = EMPTY_COMPANION_MEMORY;
    for (const key of INVENTORY_POINTER_ORDER) {
      memory = rememberDroppedTopic(memory, pointerTopic(key), TODAY);
    }
    assert.equal(pickPointer(inventoryPointers(), memory, TOMORROW), null);
  });

  test('a missing memory is treated as a first visit, not as a crash', () => {
    assert.equal(pickPointer(inventoryPointers(), null, TODAY)?.key, 'inventory_invoices');
    assert.equal(pickPointer(inventoryPointers(), undefined, TODAY)?.key, 'inventory_invoices');
  });

  test('the topics are namespaced so they cannot collide with a finding', () => {
    for (const p of inventoryPointers()) {
      assert.match(p.topic, /^pointer:/);
      assert.ok(p.topic.length <= 200, 'must survive parseCompanionMemory');
    }
  });

  test('it waits for the screen to settle before speaking', () => {
    assert.equal(POINTER_DELAY_MS, 3_000);
  });
});

describe('pointer copy keeps the companion voice', () => {
  test('every pointer has a sentence and an ask, in English, with no em dash', () => {
    for (const key of INVENTORY_POINTER_ORDER) {
      const line = pointerLine(key);
      assert.ok(line.text.trim().length > 0);
      assert.ok(line.question.trim().length > 0);
      for (const s of [line.text, line.question]) {
        assert.doesNotMatch(s, /—/, `${key} used an em dash`);
        assert.doesNotMatch(s, /!/, `${key} shouted`);
        assert.doesNotMatch(s, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${key} used an emoji`);
      }
    }
  });

  test('each pointer names something a person can do, not a feature', () => {
    assert.match(pointerLine('inventory_invoices').text, /invoice/i);
    assert.match(pointerLine('inventory_import').text, /spreadsheet/i);
  });
});

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

  test('a housekeeping role gets no pointer even on the inventory page', () => {
    assert.equal(companionMounts({ pathname: '/inventory', role: 'housekeeping' }).mounts, false);
  });

  test('a manager on the inventory page does get one, or the gate proves nothing', () => {
    assert.equal(companionMounts({ pathname: '/inventory', role: 'general_manager' }).mounts, true);
  });

  test('every role is decided by the gate rather than by this component', () => {
    for (const role of ALL_ROLES) {
      const decision = companionMounts({ pathname: '/inventory', role });
      assert.equal(typeof decision.mounts, 'boolean', `${role} had no decision`);
      if (role === 'housekeeping') assert.equal(decision.mounts, false);
    }
  });
});
