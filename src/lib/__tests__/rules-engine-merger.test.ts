/**
 * Tests for src/lib/rules-engine/merger.ts.
 *
 * The merger is the part that turns "the room departure rule + the VIP
 * arrival rule + the tight-turnaround rule all fired" into one task
 * row. If composition drifts (priority not taking max, due_by not
 * taking min, extras not de-duping) the engine produces tasks that
 * misrepresent what the rules said.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergePartials } from '@/lib/rules-engine/merger';
import type { RuleFireResult } from '@/lib/rules-engine/types';

import { blankDeparting, blankRoomContext } from './rules-engine-fixtures';

function fire(id: string, partial: RuleFireResult['partial']): RuleFireResult {
  return { id, summary: `${id} fired`, partial };
}

describe('mergePartials', () => {
  test('empty fires array ⇒ null (no task)', () => {
    const ctx = blankRoomContext();
    assert.equal(mergePartials([], ctx), null);
  });

  test('only modifier rules fired (no cleaning_type) ⇒ null', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('vip-arrival', { requires_inspection: true, extras: ['fruit_basket'] }),
      fire('pet-stay', { estimated_minutes_delta: 10, extras: ['pet_clean_checklist'] }),
    ];
    assert.equal(mergePartials(fires, ctx), null);
  });

  test('single base rule ⇒ spec with that cleaning_type + base minutes', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', {
        cleaning_type: 'departure',
        estimated_minutes_base: 35,
        priority: 'normal',
      }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.ok(spec);
    assert.equal(spec!.cleaning_type, 'departure');
    assert.equal(spec!.estimated_minutes, 35);
    assert.equal(spec!.priority, 'normal');
  });

  test('two base rules: higher-rank cleaning_type wins (departure beats stayover)', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('short-stay-every-other-day', {
        cleaning_type: 'refresh',
        estimated_minutes_base: 15,
      }),
      fire('departure-clean', {
        cleaning_type: 'departure',
        estimated_minutes_base: 35,
      }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.cleaning_type, 'departure');
    // Minutes from departure base, not refresh.
    assert.equal(spec!.estimated_minutes, 35);
  });

  test('VIP fallback inspection_only is overridden by departure', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('vip-arrival', {
        cleaning_type: 'inspection_only',
        estimated_minutes_base: 5,
        requires_inspection: true,
        extras: ['fruit_basket'],
      }),
      fire('departure-clean', {
        cleaning_type: 'departure',
        estimated_minutes_base: 35,
      }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.cleaning_type, 'departure');
    assert.equal(spec!.estimated_minutes, 35);
    assert.equal(spec!.requires_inspection, true);
    assert.ok(spec!.extras.includes('fruit_basket'));
  });

  test('priority takes the strongest across rules', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
      fire('tight-turnaround', { priority: 'high' }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.priority, 'high');
  });

  test('due_by takes the earliest across rules', () => {
    const ctx = blankRoomContext();
    const early = new Date('2026-05-26T18:00:00Z');
    const late = new Date('2026-05-26T20:00:00Z');
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
      fire('rule-a', { due_by: late }),
      fire('rule-b', { due_by: early }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.due_by?.toISOString(), '2026-05-26T18:00:00.000Z');
  });

  test('estimated_minutes = base + sum of deltas', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
      fire('pet-stay', { estimated_minutes_delta: 10 }),
      fire('hypothetical-extra', { estimated_minutes_delta: 5 }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.estimated_minutes, 50);
  });

  test('requires_inspection is OR across rules', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
      fire('vip-arrival', { requires_inspection: true }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.requires_inspection, true);
  });

  test('extras are unioned and de-duped', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
      fire('vip-arrival', { extras: ['fruit_basket', 'amenity_setup'] }),
      fire('honeymoon-anniversary', { extras: ['welcome_amenity', 'amenity_setup'] }),
    ];
    const spec = mergePartials(fires, ctx);
    const xs = new Set(spec!.extras);
    assert.equal(xs.size, 3); // fruit_basket, amenity_setup, welcome_amenity
    assert.ok(xs.has('fruit_basket'));
    assert.ok(xs.has('amenity_setup'));
    assert.ok(xs.has('welcome_amenity'));
  });

  test('notes are concatenated with "; "', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', {
        cleaning_type: 'departure',
        estimated_minutes_base: 35,
        notes: ['Departure'],
      }),
      fire('vip-arrival', { notes: ['VIP Platinum, Spanish-speaking'] }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.notes, 'Departure; VIP Platinum, Spanish-speaking');
  });

  test('status: departure + vacant_dirty ⇒ ready_now', () => {
    const ctx = blankRoomContext({
      current_status: 'vacant_dirty',
      departing: blankDeparting(),
    });
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.status, 'ready_now');
  });

  test('status: departure + occupied ⇒ scheduled (guest still there)', () => {
    const ctx = blankRoomContext({
      current_status: 'occupied',
      departing: blankDeparting(),
    });
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.status, 'scheduled');
  });

  test('status: stayover on vacant_dirty ⇒ still scheduled (not a departure)', () => {
    const ctx = blankRoomContext({ current_status: 'vacant_dirty' });
    const fires = [
      fire('short-stay-every-other-day', {
        cleaning_type: 'refresh',
        estimated_minutes_base: 15,
      }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.equal(spec!.status, 'scheduled');
  });

  test('rules_fired entries preserved in order', () => {
    const ctx = blankRoomContext();
    const fires = [
      fire('departure-clean', { cleaning_type: 'departure', estimated_minutes_base: 35 }),
      fire('vip-arrival', { requires_inspection: true }),
      fire('tight-turnaround', { priority: 'high' }),
    ];
    const spec = mergePartials(fires, ctx);
    assert.deepEqual(spec!.rules_fired.map((r) => r.id), [
      'departure-clean',
      'vip-arrival',
      'tight-turnaround',
    ]);
  });
});
