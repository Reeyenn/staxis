/**
 * Tests for component-room collapse logic.
 *
 * The collapse runs purely in-memory in the page component; no DB or
 * fetch involvement, so this is a pure-function unit test.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  collapseChildComponents,
  componentForRoom,
  formatComponentLabel,
  type ComponentRoomLink,
} from '../../lib/housekeeper-workflow/component-rooms';

import type { Room } from '../../types';

function room(number: string): Room {
  return {
    id: number,
    number,
    type: 'checkout',
    priority: 'standard',
    status: 'dirty',
    date: '2026-05-25',
    propertyId: 'p',
  };
}

describe('component-room collapse', () => {
  test('returns the input unchanged when no components configured', () => {
    const rooms = [room('101'), room('102')];
    const out = collapseChildComponents(rooms, []);
    assert.deepEqual(out.map((r) => r.number), ['101', '102']);
  });

  test('drops child rooms when their numbers appear in a component link', () => {
    const rooms = [room('305'), room('305A'), room('305B'), room('305C'), room('306')];
    const links: ComponentRoomLink[] = [
      { parent_room_number: '305', child_room_numbers: ['305A', '305B', '305C'] },
    ];
    const out = collapseChildComponents(rooms, links);
    assert.deepEqual(out.map((r) => r.number), ['305', '306']);
  });

  test('handles multiple component groupings', () => {
    const rooms = [
      room('101'),
      room('102A'),
      room('102B'),
      room('200'),
      room('200A'),
    ];
    const links: ComponentRoomLink[] = [
      { parent_room_number: '102', child_room_numbers: ['102A', '102B'] },
      { parent_room_number: '200', child_room_numbers: ['200A'] },
    ];
    const out = collapseChildComponents(rooms, links);
    assert.deepEqual(out.map((r) => r.number), ['101', '200']);
  });

  test('keeps parents whose own number happens to be in another link as a child', () => {
    // Edge case — a misconfigured property where parent_room_number of
    // one link equals child of another. We still drop the child match
    // (defensive); the manager should fix the config but we don't crash.
    const rooms = [room('101'), room('102')];
    const links: ComponentRoomLink[] = [
      { parent_room_number: '101', child_room_numbers: ['102'] },
      { parent_room_number: '102', child_room_numbers: [] },
    ];
    const out = collapseChildComponents(rooms, links);
    assert.deepEqual(out.map((r) => r.number), ['101']);
  });

  test('componentForRoom returns the matching link, or null', () => {
    const links: ComponentRoomLink[] = [
      { parent_room_number: '305', child_room_numbers: ['305A', '305B'] },
    ];
    assert.ok(componentForRoom('305', links));
    assert.equal(componentForRoom('305A', links), null);
    assert.equal(componentForRoom('999', links), null);
  });

  test('formatComponentLabel joins with separators', () => {
    const link: ComponentRoomLink = {
      parent_room_number: '305',
      child_room_numbers: ['305A', '305B', '305C'],
    };
    assert.equal(formatComponentLabel(link), '305A · 305B · 305C');
  });
});
