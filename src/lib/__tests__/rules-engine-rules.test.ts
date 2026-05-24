/**
 * One section per rule. Each section proves:
 *   (a) the rule fires when its specific condition holds, AND
 *   (b) the rule does NOT fire when an obvious-looking negative case applies.
 *
 * These tests pin the rules' semantics. They do NOT exercise the merger —
 * see rules-engine-merger.test.ts for composition. They do NOT exercise
 * DB writes — see the cron route's deploy-time smoke test for that.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { departureCleanRule } from '@/lib/rules-engine/rules/departure-clean';
import { longStayWeeklyRule } from '@/lib/rules-engine/rules/long-stay-weekly';
import { shortStayEveryOtherDayRule } from '@/lib/rules-engine/rules/short-stay-every-other-day';
import { ecoStayRule } from '@/lib/rules-engine/rules/eco-stay';
import { saturdayDeepRotationRule } from '@/lib/rules-engine/rules/saturday-deep-rotation';
import { vipArrivalRule } from '@/lib/rules-engine/rules/vip-arrival';
import { petStayRule } from '@/lib/rules-engine/rules/pet-stay';
import { lateCheckoutRule } from '@/lib/rules-engine/rules/late-checkout';
import { earlyCheckinRule } from '@/lib/rules-engine/rules/early-checkin';
import { honeymoonAnniversaryRule } from '@/lib/rules-engine/rules/honeymoon-anniversary';
import { tightTurnaroundRule } from '@/lib/rules-engine/rules/tight-turnaround';

import {
  blankArriving,
  blankDeparting,
  blankPropertyContext,
  blankRoomContext,
  blankStaying,
} from './rules-engine-fixtures';

describe('departure-clean', () => {
  test('fires when departing reservation is present', () => {
    const ctx = blankRoomContext({ departing: blankDeparting() });
    const r = departureCleanRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.cleaning_type, 'departure');
    assert.equal(r!.partial.estimated_minutes_base, 35);
  });

  test('uses suite duration when is_suite', () => {
    const ctx = blankRoomContext({
      is_suite: true,
      departing: blankDeparting(),
    });
    const r = departureCleanRule.evaluate(ctx)!;
    assert.equal(r.partial.estimated_minutes_base, 55);
  });

  test('does not fire when no departing reservation', () => {
    const ctx = blankRoomContext({ departing: null });
    assert.equal(departureCleanRule.evaluate(ctx), null);
  });
});

describe('long-stay-weekly-deep', () => {
  test('fires on day 7 of a 14-night stay', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ num_nights: 14, day_of_stay: 7 }),
    });
    const r = longStayWeeklyRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.cleaning_type, 'deep');
  });

  test('does not fire on day 6 (not a multiple of 7)', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ num_nights: 14, day_of_stay: 6 }),
    });
    assert.equal(longStayWeeklyRule.evaluate(ctx), null);
  });

  test('does not fire on stays under 14 nights', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ num_nights: 7, day_of_stay: 7 }),
    });
    assert.equal(longStayWeeklyRule.evaluate(ctx), null);
  });

  test('yields to departure today', () => {
    const ctx = blankRoomContext({
      departing: blankDeparting(),
      staying: blankStaying({ num_nights: 14, day_of_stay: 7 }),
    });
    assert.equal(longStayWeeklyRule.evaluate(ctx), null);
  });

  test('yields to eco-stay opt-in', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({
        num_nights: 14,
        day_of_stay: 7,
        eco_stay_opt_in: true,
      }),
    });
    assert.equal(longStayWeeklyRule.evaluate(ctx), null);
  });
});

describe('short-stay-every-other-day', () => {
  test('fires on day 2 of a 3-night stay ⇒ refresh', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ num_nights: 3, day_of_stay: 2 }),
    });
    const r = shortStayEveryOtherDayRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.cleaning_type, 'refresh');
  });

  test('does not fire on day 1 (odd)', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ num_nights: 3, day_of_stay: 1 }),
    });
    assert.equal(shortStayEveryOtherDayRule.evaluate(ctx), null);
  });

  test('does not fire on long stays (≥14 nights)', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ num_nights: 14, day_of_stay: 2 }),
    });
    assert.equal(shortStayEveryOtherDayRule.evaluate(ctx), null);
  });
});

describe('eco-stay-opt-in', () => {
  test('fires when staying + opted in ⇒ room_check', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ eco_stay_opt_in: true }),
    });
    const r = ecoStayRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.cleaning_type, 'room_check');
    assert.equal(r!.partial.priority, 'low');
  });

  test('does not fire when not opted in', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ eco_stay_opt_in: false }),
    });
    assert.equal(ecoStayRule.evaluate(ctx), null);
  });

  test('yields to departure', () => {
    const ctx = blankRoomContext({
      departing: blankDeparting(),
      staying: blankStaying({ eco_stay_opt_in: true }),
    });
    assert.equal(ecoStayRule.evaluate(ctx), null);
  });
});

describe('saturday-deep-rotation', () => {
  test('fires on a Saturday when room number is in this week\'s rotation slot', () => {
    // 2026-05-30 is a Saturday. Day-of-year = 150; week = floor((150-1)/7) = 21.
    // 21 % 4 == 1, so rooms with (roomNum % 4 == 1) are in this week's slot.
    const ctx = blankRoomContext({
      room_number: '305', // 305 % 4 == 1
      property: blankPropertyContext({
        day_of_week: 6,
        now_utc: new Date('2026-05-30T17:00:00Z'),
        business_date: '2026-05-30',
      }),
      staying: blankStaying(),
    });
    const r = saturdayDeepRotationRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.cleaning_type, 'deep');
  });

  test('does not fire on a Tuesday', () => {
    const ctx = blankRoomContext({
      property: blankPropertyContext({ day_of_week: 2 }),
      staying: blankStaying(),
    });
    assert.equal(saturdayDeepRotationRule.evaluate(ctx), null);
  });

  test('does not fire for a room not in this Saturday\'s slot', () => {
    // Week 21 % 4 == 1. Room 304 % 4 == 0 → not in this slot.
    const ctx = blankRoomContext({
      room_number: '304',
      property: blankPropertyContext({
        day_of_week: 6,
        now_utc: new Date('2026-05-30T17:00:00Z'),
        business_date: '2026-05-30',
      }),
      staying: blankStaying(),
    });
    assert.equal(saturdayDeepRotationRule.evaluate(ctx), null);
  });
});

describe('vip-arrival', () => {
  test('fires when arriving guest is VIP', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({ is_vip: true, loyalty_tier: 'Platinum' }),
    });
    const r = vipArrivalRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.requires_inspection, true);
    assert.ok(r!.partial.extras?.includes('fruit_basket'));
  });

  test('captures language in notes when present', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({
        is_vip: true,
        loyalty_tier: 'Platinum',
        language: 'Spanish-speaking',
      }),
    });
    const r = vipArrivalRule.evaluate(ctx)!;
    assert.ok(r.partial.notes![0].includes('VIP Platinum'));
    assert.ok(r.partial.notes![0].includes('Spanish-speaking'));
  });

  test('does not fire when not VIP', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({ is_vip: false }),
    });
    assert.equal(vipArrivalRule.evaluate(ctx), null);
  });
});

describe('pet-stay', () => {
  test('fires on arriving with pet', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({ has_pet: true }),
    });
    const r = petStayRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.estimated_minutes_delta, 10);
    assert.ok(r!.partial.extras?.includes('pet_clean_checklist'));
    assert.ok(r!.partial.extras?.includes('pet_kit'));
  });

  test('fires on staying with pet (no pet_kit, just checklist)', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ has_pet: true }),
    });
    const r = petStayRule.evaluate(ctx)!;
    assert.ok(r.partial.extras?.includes('pet_clean_checklist'));
    assert.equal(r.partial.extras?.includes('pet_kit'), false);
  });

  test('does not fire without pet flag', () => {
    const ctx = blankRoomContext({
      staying: blankStaying({ has_pet: false }),
    });
    assert.equal(petStayRule.evaluate(ctx), null);
  });
});

describe('late-checkout', () => {
  test('annotates with the approved late checkout time', () => {
    const ctx = blankRoomContext({
      departing: blankDeparting({
        late_checkout_approved: true,
        late_checkout_until: '13:00:00',
      }),
    });
    const r = lateCheckoutRule.evaluate(ctx);
    assert.ok(r);
    assert.ok(r!.partial.notes![0].includes('13:00:00'));
    // Late checkout MUST NOT set due_by; tight-turnaround owns due_by math.
    assert.equal(r!.partial.due_by, undefined);
  });

  test('does not fire when late checkout not approved', () => {
    const ctx = blankRoomContext({ departing: blankDeparting() });
    assert.equal(lateCheckoutRule.evaluate(ctx), null);
  });
});

describe('early-checkin-boost-priority', () => {
  test('fires on explicit request ⇒ priority high', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({ has_early_checkin_request: true }),
    });
    const r = earlyCheckinRule.evaluate(ctx);
    assert.equal(r!.partial.priority, 'high');
  });

  test('fires on approved early check-in ⇒ priority high', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({
        early_checkin_approved: true,
        early_checkin_from: '12:00:00',
      }),
    });
    const r = earlyCheckinRule.evaluate(ctx)!;
    assert.equal(r.partial.priority, 'high');
    assert.ok(r.partial.notes![0].includes('12:00:00'));
  });

  test('does not fire on plain arriving reservation', () => {
    const ctx = blankRoomContext({ arriving: blankArriving() });
    assert.equal(earlyCheckinRule.evaluate(ctx), null);
  });
});

describe('honeymoon-anniversary', () => {
  test('honeymoon ⇒ honeymoon_amenity + welcome_amenity extras', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({ has_honeymoon: true }),
    });
    const r = honeymoonAnniversaryRule.evaluate(ctx);
    assert.ok(r);
    assert.ok(r!.partial.extras?.includes('honeymoon_amenity'));
    assert.ok(r!.partial.extras?.includes('welcome_amenity'));
  });

  test('anniversary ⇒ anniversary_amenity + welcome_amenity', () => {
    const ctx = blankRoomContext({
      arriving: blankArriving({ has_anniversary: true }),
    });
    const r = honeymoonAnniversaryRule.evaluate(ctx)!;
    assert.ok(r.partial.extras?.includes('anniversary_amenity'));
    assert.ok(r.partial.extras?.includes('welcome_amenity'));
  });

  test('neither ⇒ silent', () => {
    const ctx = blankRoomContext({ arriving: blankArriving() });
    assert.equal(honeymoonAnniversaryRule.evaluate(ctx), null);
  });
});

describe('tight-turnaround', () => {
  test('arrival 14:00 with standard 11:00 checkout ⇒ fires (180-min gap), priority high, due-by 13:45', () => {
    const ctx = blankRoomContext({
      departing: blankDeparting(),
      arriving: blankArriving({ arrival_time: '14:00:00' }),
    });
    const r = tightTurnaroundRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.priority, 'high');
    // 14:00 CDT = 19:00 UTC; minus 15 min = 18:45 UTC = 13:45 CDT
    assert.equal(r!.partial.due_by?.toISOString(), '2026-05-26T18:45:00.000Z');
  });

  test('arrival 17:00 with standard 11:00 checkout ⇒ silent (6h gap)', () => {
    const ctx = blankRoomContext({
      departing: blankDeparting(),
      arriving: blankArriving({ arrival_time: '17:00:00' }),
    });
    assert.equal(tightTurnaroundRule.evaluate(ctx), null);
  });

  test('late checkout 13:30 with 14:00 arrival ⇒ fires (30-min gap, much tighter)', () => {
    const ctx = blankRoomContext({
      departing: blankDeparting({
        late_checkout_approved: true,
        late_checkout_until: '13:30:00',
      }),
      arriving: blankArriving({ arrival_time: '14:00:00' }),
    });
    const r = tightTurnaroundRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r!.partial.priority, 'high');
  });

  test('no arriving reservation ⇒ silent', () => {
    const ctx = blankRoomContext({ departing: blankDeparting() });
    assert.equal(tightTurnaroundRule.evaluate(ctx), null);
  });
});
