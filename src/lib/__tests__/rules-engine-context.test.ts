/**
 * Tests for src/lib/rules-engine/context.ts.
 *
 * Post-merge sweep fixes (Critical #2 and #3 from the adversarial
 * review): the context builder must drop cancelled / no_show
 * reservations BEFORE they get partitioned into arriving/departing/
 * staying, and must skip rooms whose current status is OOO or OOI.
 *
 * Without these filters, the engine produced spurious tasks for:
 *   - cancelled VIPs (the vip-arrival rule still fired)
 *   - OOO rooms with stale reservations (departure-clean still fired)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assembleRoomContexts } from '@/lib/rules-engine/context';
import { evaluateRoomRules } from '@/lib/rules-engine/rules';
import { mergePartials } from '@/lib/rules-engine/merger';

import { blankPropertyContext } from './rules-engine-fixtures';

const property = blankPropertyContext({
  now_utc: new Date('2026-05-26T11:00:00Z'),
  business_date: '2026-05-26',
});

const baseRoom = {
  room_number: '305',
  room_type: 'Standard King',
  is_suite: false,
  pet_friendly: false,
};

const baseRes = {
  pms_reservation_id: 'res-1',
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
};

describe('cancelled / no_show reservation filter (Critical #2)', () => {
  test('cancelled VIP arrival does NOT produce a context (no spurious vip-arrival fire)', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: 'cancelled' }],
      [],
      [],
    );
    // Room has no other activity → no context built at all.
    assert.equal(contexts.length, 0);
  });

  test('no_show arrival is also filtered out', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: 'no_show' }],
      [],
      [],
    );
    assert.equal(contexts.length, 0);
  });

  test('status=null is treated as still-active (permissive)', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: null }],
      [],
      [],
    );
    assert.equal(contexts.length, 1);
    assert.ok(contexts[0].arriving);
    assert.equal(contexts[0].arriving!.is_vip, true);
  });

  test('status=booked / checked_in / checked_out all produce contexts', () => {
    for (const s of ['booked', 'checked_in', 'checked_out']) {
      const contexts = assembleRoomContexts(
        property,
        [baseRoom],
        [{ ...baseRes, status: s }],
        [],
        [],
      );
      assert.equal(contexts.length, 1, `status=${s} should produce a context`);
    }
  });

  test('cancelled departure: no departure-clean task produced', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [
        // John was departing today but cancelled
        {
          ...baseRes,
          pms_reservation_id: 'res-john',
          arrival_date: '2026-05-24',
          departure_date: '2026-05-26',
          notes: null,
          status: 'cancelled',
        },
      ],
      [],
      [],
    );
    assert.equal(contexts.length, 0);
  });

  test('mixed reservations: cancelled dropped, active kept', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [
        { ...baseRes, pms_reservation_id: 'res-cancelled', status: 'cancelled' },
        {
          ...baseRes,
          pms_reservation_id: 'res-active',
          arrival_time: '15:00:00',
          notes: null, // Active reservation, not VIP
          status: 'booked',
        },
      ],
      [],
      [],
    );
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].arriving!.pms_reservation_id, 'res-active');
    assert.equal(contexts[0].arriving!.is_vip, false); // VIP keyword was on the cancelled one
  });
});

describe('out-of-order room skip (Critical #3)', () => {
  test('OOO room with active reservation: no context built', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: 'booked' }],
      [
        {
          room_number: '305',
          status: 'out_of_order',
          changed_at: '2026-05-25T18:00:00Z',
        },
      ],
      [],
    );
    assert.equal(contexts.length, 0);
  });

  test('out_of_inventory room: also skipped', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: 'booked' }],
      [
        {
          room_number: '305',
          status: 'out_of_inventory',
          changed_at: '2026-05-25T18:00:00Z',
        },
      ],
      [],
    );
    assert.equal(contexts.length, 0);
  });

  test('OOO room WITHOUT any reservation: also skipped (still blocked)', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [],
      [
        {
          room_number: '305',
          status: 'out_of_order',
          changed_at: '2026-05-25T18:00:00Z',
        },
      ],
      // Tickle the "PMS HK plan exists" branch so the room would normally be evaluated
      [
        {
          room_number: '305',
          cleaning_type: null,
          status: 'not_started',
          dnd_active: false,
          late_checkout_approved: false,
          late_checkout_until: null,
          early_checkin_approved: false,
          early_checkin_from: null,
        },
      ],
    );
    assert.equal(contexts.length, 0);
  });

  test('vacant_clean room: NOT blocked (engine builds context)', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: 'booked' }],
      [
        {
          room_number: '305',
          status: 'vacant_clean',
          changed_at: '2026-05-25T18:00:00Z',
        },
      ],
      [],
    );
    assert.equal(contexts.length, 1);
  });
});

describe('end-to-end: cancelled VIP + OOO room produces zero tasks', () => {
  test('cancelled VIP arrival in OOO room — no rule fires at all', () => {
    const contexts = assembleRoomContexts(
      property,
      [baseRoom],
      [{ ...baseRes, status: 'cancelled' }],
      [{ room_number: '305', status: 'out_of_order', changed_at: '2026-05-25T18:00:00Z' }],
      [],
    );
    assert.equal(contexts.length, 0);
    // Sanity: if a context HAD been built, the merger should also produce null.
    // This loop is a defense-in-depth assertion.
    for (const ctx of contexts) {
      const fired = evaluateRoomRules(ctx);
      const spec = mergePartials(fired, ctx);
      assert.equal(spec, null);
    }
  });
});
