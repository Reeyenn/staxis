import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  suggestActionForGap,
  averageWageCentsPerHour,
  DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR,
} from '../schedule-reactivity/suggest-action';
import type { Gap, PropertyConfig } from '../schedule-reactivity/types';

function makeCfg(over: Partial<PropertyConfig> = {}): PropertyConfig {
  return {
    gapAlertThresholdMinutes: 60,
    gapAlertRedPct: 0.20,
    releaseShiftStrategy: 'latest_added',
    frontDeskCoverageHours: 24,
    maintenanceShiftsPerDay: 1,
    housemanShiftsPerDay: 1,
    breakfastWindowStart: null,
    breakfastWindowEnd: null,
    shiftMinutes: null,
    ...over,
  };
}

function makeGap(over: Partial<Gap> = {}): Gap {
  return {
    propertyId: 'p',
    alertDate: '2026-06-01',
    department: 'housekeeping',
    demandMinutes: 500,
    scheduledMinutes: 400,
    gapMinutes: 100,
    context: {},
    ...over,
  };
}

test('returns null when gap < threshold (boundary at threshold)', () => {
  // |gap|=59 < threshold 60 → null
  const s1 = suggestActionForGap(
    makeGap({ gapMinutes: 59, scheduledMinutes: 441 }),
    makeCfg({ gapAlertThresholdMinutes: 60 }),
    { triggerKind: 'manual_recompute' },
  );
  assert.equal(s1, null);
  // |gap|=60 = threshold 60 → produces suggestion (>=)
  const s2 = suggestActionForGap(
    makeGap({ gapMinutes: 60, scheduledMinutes: 440 }),
    makeCfg({ gapAlertThresholdMinutes: 60 }),
    { triggerKind: 'manual_recompute' },
  );
  assert.ok(s2);
});

test('positive gap → add_shift, negative gap → release_shift', () => {
  const add = suggestActionForGap(
    makeGap({ gapMinutes: 120, scheduledMinutes: 380 }),
    makeCfg(),
    { triggerKind: 'arrival_surge' },
  );
  assert.equal(add!.suggestedAction, 'add_shift');

  const rel = suggestActionForGap(
    makeGap({ gapMinutes: -120, scheduledMinutes: 620, demandMinutes: 500 }),
    makeCfg(),
    { triggerKind: 'cancellation_wave', wageCentsPerHour: 1500 },
  );
  assert.equal(rel!.suggestedAction, 'release_shift');
});

test('severity boundary at redPct', () => {
  // gap=99/demand=500 = 19.8% → yellow
  const yellow = suggestActionForGap(
    makeGap({ gapMinutes: 99, scheduledMinutes: 401 }),
    makeCfg({ gapAlertRedPct: 0.20 }),
    { triggerKind: 'manual_recompute' },
  );
  assert.equal(yellow!.severity, 'yellow');

  // gap=100/500 = 20% → red (>=)
  const red = suggestActionForGap(
    makeGap({ gapMinutes: 100, scheduledMinutes: 400 }),
    makeCfg({ gapAlertRedPct: 0.20 }),
    { triggerKind: 'manual_recompute' },
  );
  assert.equal(red!.severity, 'red');
});

test('release_shift estimates savings when wage provided', () => {
  // 120 min over * $15/hr = 120/60 * 1500 = 3000 cents = $30.00
  const s = suggestActionForGap(
    makeGap({ gapMinutes: -120, scheduledMinutes: 620, demandMinutes: 500 }),
    makeCfg(),
    { triggerKind: 'cancellation_wave', wageCentsPerHour: 1500 },
  );
  assert.equal(s!.suggestedSavingsCents, 3000);
});

test('release_shift records wageDataPending when wage missing', () => {
  const s = suggestActionForGap(
    makeGap({ gapMinutes: -120, scheduledMinutes: 620, demandMinutes: 500 }),
    makeCfg(),
    { triggerKind: 'cancellation_wave' /* no wage */ },
  );
  assert.equal(s!.suggestedSavingsCents, undefined);
  assert.equal(s!.context.wageDataPending, true);
});

test('add_shift never sets suggestedSavingsCents', () => {
  const s = suggestActionForGap(
    makeGap({ gapMinutes: 120, scheduledMinutes: 380 }),
    makeCfg(),
    { triggerKind: 'arrival_surge', wageCentsPerHour: 2500 },
  );
  assert.equal(s!.suggestedAction, 'add_shift');
  assert.equal(s!.suggestedSavingsCents, undefined);
});

test('demand=0 never produces an alert (avoids div-by-0 noise)', () => {
  const s = suggestActionForGap(
    { ...makeGap(), demandMinutes: 0, scheduledMinutes: 200, gapMinutes: -200 },
    makeCfg(),
    { triggerKind: 'manual_recompute', wageCentsPerHour: 1500 },
  );
  assert.equal(s, null);
});

test('averageWageCentsPerHour prefers cents column, falls back to dollar*100', () => {
  assert.equal(
    averageWageCentsPerHour([
      { hourlyWageCents: 1500, hourlyWage: null },
      { hourlyWageCents: null, hourlyWage: 17 },
    ]),
    Math.round((1500 + 1700) / 2),
  );

  // All null → null
  assert.equal(
    averageWageCentsPerHour([
      { hourlyWageCents: null, hourlyWage: null },
    ]),
    null,
  );

  // Zero wages are excluded (treated as "not set").
  assert.equal(
    averageWageCentsPerHour([
      { hourlyWageCents: 0, hourlyWage: 0 },
      { hourlyWageCents: null, hourlyWage: 14 },
    ]),
    1400,
  );
});

test('DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR is $14', () => {
  assert.equal(DEFAULT_PLACEHOLDER_WAGE_CENTS_PER_HOUR, 1400);
});
