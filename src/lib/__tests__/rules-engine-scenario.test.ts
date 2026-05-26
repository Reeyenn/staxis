/**
 * The validation scenario from the brief, end-to-end:
 *
 *   Tuesday at Comfort Suites Beaumont. Room 305. John Smith (2-night
 *   stay) checking out today. Next guest Mary Jones — VIP Platinum,
 *   Spanish-speaking, 1 night — arriving 2pm.
 *
 *   Expected: ONE merged task with cleaning_type=departure,
 *   priority=high, due-by=1:45pm local, requires_inspection=true,
 *   extras include fruit_basket, notes include "VIP Platinum" and
 *   "Spanish-speaking", rules_fired include the 3 expected ids.
 *
 * The test runs every rule through the full registry (not just the
 * 3 expected ones), so a regression that ADDS a spurious firing also
 * trips here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRoomRules } from '@/lib/rules-engine/rules';
import { mergePartials } from '@/lib/rules-engine/merger';
import { assembleRoomContexts } from '@/lib/rules-engine/context';
import type { PropertyContext } from '@/lib/rules-engine/types';

import { blankPropertyContext } from './rules-engine-fixtures';

describe('Room 305 — Tuesday turnaround scenario', () => {
  // Engine runs at 6am CDT = 11:00 UTC on 2026-05-26 (Tuesday).
  const property: PropertyContext = blankPropertyContext({
    now_utc: new Date('2026-05-26T11:00:00Z'),
  });

  // Build raw rows as the context builder would receive them from PMS.
  const roomsRaw = [
    {
      room_number: '305',
      room_type: 'Standard King',
      is_suite: false,
      pet_friendly: false,
    },
  ];

  const reservationsRaw = [
    // John Smith: 2-night stay, departing today.
    {
      pms_reservation_id: 'res-john',
      room_number: '305',
      arrival_date: '2026-05-24',
      arrival_time: '15:00:00',
      departure_date: '2026-05-26',
      departure_time: '11:00:00',
      num_nights: 2,
      adults: 1,
      children: 0,
      infants: 0,
      notes: null,
      special_requests: null,
      dietary_needs: null,
      accessibility_needs: null,
      package_name: null,
      rate_code: null,
      status: null,
    },
    // Mary Jones: VIP Platinum, Spanish-speaking, arriving 14:00 today.
    {
      pms_reservation_id: 'res-mary',
      room_number: '305',
      arrival_date: '2026-05-26',
      arrival_time: '14:00:00',
      departure_date: '2026-05-27',
      departure_time: '11:00:00',
      num_nights: 1,
      adults: 1,
      children: 0,
      infants: 0,
      notes: 'VIP Platinum, Spanish-speaking',
      special_requests: null,
      dietary_needs: null,
      accessibility_needs: null,
      package_name: null,
      rate_code: null,
      status: null,
    },
  ];

  // Room is still occupied by John at 6am.
  const statusLogs = [
    {
      room_number: '305',
      status: 'occupied',
      changed_at: '2026-05-24T20:00:00Z',
    },
  ];

  const hkAssignments: never[] = [];

  const contexts = assembleRoomContexts(
    property,
    roomsRaw,
    reservationsRaw,
    statusLogs,
    hkAssignments,
  );

  test('exactly one room context built (room 305)', () => {
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].room_number, '305');
  });

  test('context has departing (John) and arriving (Mary) but no staying', () => {
    const ctx = contexts[0];
    assert.ok(ctx.departing);
    assert.equal(ctx.departing!.pms_reservation_id, 'res-john');
    assert.equal(ctx.departing!.num_nights, 2);
    assert.ok(ctx.arriving);
    assert.equal(ctx.arriving!.pms_reservation_id, 'res-mary');
    assert.equal(ctx.arriving!.is_vip, true);
    assert.equal(ctx.arriving!.loyalty_tier, 'Platinum');
    assert.equal(ctx.arriving!.language, 'Spanish-speaking');
    assert.equal(ctx.staying, null);
  });

  test('the three expected rules fire (no more, no less)', () => {
    const ctx = contexts[0];
    const fired = evaluateRoomRules(ctx);
    const ids = fired.map((f) => f.id).sort();
    assert.deepEqual(ids, ['departure-clean', 'tight-turnaround', 'vip-arrival']);
  });

  test('merged spec matches the brief\'s expected output', () => {
    const ctx = contexts[0];
    const fired = evaluateRoomRules(ctx);
    const spec = mergePartials(fired, ctx);

    assert.ok(spec);
    // type: departure (departure wins over inspection_only fallback from VIP)
    assert.equal(spec!.cleaning_type, 'departure');
    // priority: HIGH (from tight_turnaround)
    assert.equal(spec!.priority, 'high');
    // due_by: 13:45 CDT = 18:45 UTC
    assert.equal(spec!.due_by?.toISOString(), '2026-05-26T18:45:00.000Z');
    // requires_inspection from VIP
    assert.equal(spec!.requires_inspection, true);
    // extras must include fruit_basket
    assert.ok(spec!.extras.includes('fruit_basket'));
    // notes must include "VIP Platinum" and "Spanish-speaking"
    assert.ok(spec!.notes);
    assert.ok(spec!.notes!.includes('VIP Platinum'));
    assert.ok(spec!.notes!.includes('Spanish-speaking'));
    // status: scheduled (John still in room at 6am — current_status = 'occupied')
    assert.equal(spec!.status, 'scheduled');
    // estimated_minutes: 35 (departure base)
    assert.equal(spec!.estimated_minutes, 35);

    const firedIds = spec!.rules_fired.map((r) => r.id).sort();
    assert.deepEqual(firedIds, [
      'departure-clean',
      'tight-turnaround',
      'vip-arrival',
    ]);
  });

  test('once John checks out at 11:15am, status flips to ready_now', () => {
    const ctxAfter = assembleRoomContexts(
      blankPropertyContext({ now_utc: new Date('2026-05-26T16:30:00Z') }),
      roomsRaw,
      reservationsRaw,
      [
        {
          room_number: '305',
          status: 'vacant_dirty',
          changed_at: '2026-05-26T16:15:00Z',
        },
      ],
      hkAssignments,
    );
    const fired = evaluateRoomRules(ctxAfter[0]);
    const spec = mergePartials(fired, ctxAfter[0]);
    assert.equal(spec!.status, 'ready_now');
    assert.equal(spec!.cleaning_type, 'departure');
  });

  test('engine is idempotent: same inputs produce the same spec', () => {
    const ctx = contexts[0];
    const a = mergePartials(evaluateRoomRules(ctx), ctx);
    const b = mergePartials(evaluateRoomRules(ctx), ctx);
    assert.deepEqual(
      {
        cleaning_type: a!.cleaning_type,
        priority: a!.priority,
        due_by: a!.due_by?.toISOString() ?? null,
        estimated_minutes: a!.estimated_minutes,
        requires_inspection: a!.requires_inspection,
        extras: [...a!.extras].sort(),
        notes: a!.notes,
        status: a!.status,
        rules_fired_ids: a!.rules_fired.map((r) => r.id).sort(),
      },
      {
        cleaning_type: b!.cleaning_type,
        priority: b!.priority,
        due_by: b!.due_by?.toISOString() ?? null,
        estimated_minutes: b!.estimated_minutes,
        requires_inspection: b!.requires_inspection,
        extras: [...b!.extras].sort(),
        notes: b!.notes,
        status: b!.status,
        rules_fired_ids: b!.rules_fired.map((r) => r.id).sort(),
      },
    );
  });
});
