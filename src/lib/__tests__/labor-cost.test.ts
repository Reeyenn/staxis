/**
 * Unit tests for the pure Labor Cost helpers.
 *
 * These lock in the rules the Dashboard tile + /api/dashboard/labor-cost rely
 * on, and that the orchestrator's adversarial review flagged specifically:
 *   - Overnight shifts (end_time < start_time) must not produce negative hours.
 *   - Wage resolution order: person override → role default → staff.hourly_wage
 *     (dollars→cents) → benchmark, with the right `source` so missing_wages is
 *     honest.
 *   - Daily overtime at 1.5× is per-person, never summed across people.
 *   - Money stays in CENTS — no $/100 drift.
 *   - Target band good/warn/over boundaries.
 *   - canViewLaborCost gates to the management trio only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HOURLY_WAGE_CENTS,
  DEFAULT_LABOR_TARGET_PCT,
  LABOR_WARN_BAND_PTS,
  canViewLaborCost,
  classifyLaborBand,
  parseTimeToMinutes,
  shiftMinutes,
  resolveWageCents,
  laborCentsForMinutes,
  totalLaborCents,
  laborCostPct,
} from '@/lib/labor-cost';

describe('parseTimeToMinutes', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    assert.equal(parseTimeToMinutes('08:00'), 480);
    assert.equal(parseTimeToMinutes('08:00:00'), 480);
    assert.equal(parseTimeToMinutes('00:00'), 0);
    assert.equal(parseTimeToMinutes('23:59'), 23 * 60 + 59);
  });
  it('treats seconds as a fraction of a minute', () => {
    assert.equal(parseTimeToMinutes('08:00:30'), 480.5);
  });
  it('rejects garbage and out-of-range hours/minutes', () => {
    assert.equal(parseTimeToMinutes('24:00'), null);
    assert.equal(parseTimeToMinutes('08:60'), null);
    assert.equal(parseTimeToMinutes('not-a-time'), null);
    assert.equal(parseTimeToMinutes(''), null);
    assert.equal(parseTimeToMinutes(null), null);
    assert.equal(parseTimeToMinutes(undefined), null);
  });
});

describe('shiftMinutes (overnight-safe)', () => {
  it('computes a same-day shift', () => {
    assert.equal(shiftMinutes('08:00', '16:00'), 480);
    assert.equal(shiftMinutes('09:00', '17:30'), 510);
  });
  it('computes an overnight shift where end < start', () => {
    // 23:00 → 07:00 is an 8-hour overnight, NOT a negative number.
    assert.equal(shiftMinutes('23:00', '07:00'), 480);
    assert.equal(shiftMinutes('22:30', '06:00'), 450);
  });
  it('treats equal start/end as zero (degenerate), not 24h', () => {
    assert.equal(shiftMinutes('08:00', '08:00'), 0);
  });
  it('caps at 24h and returns 0 on unparseable input', () => {
    assert.equal(shiftMinutes('bad', '16:00'), 0);
    assert.equal(shiftMinutes('08:00', null), 0);
    assert.ok(shiftMinutes('00:00', '23:59') <= 24 * 60);
  });
});

describe('resolveWageCents (resolution order)', () => {
  it('prefers a per-person override above everything', () => {
    const r = resolveWageCents({
      personOverrideCents: 2500,
      roleDefaultCents: 1800,
      staffHourlyWageDollars: 20,
    });
    assert.deepEqual(r, { cents: 2500, source: 'person' });
  });
  it('falls back to the role default when no override', () => {
    const r = resolveWageCents({
      personOverrideCents: null,
      roleDefaultCents: 1800,
      staffHourlyWageDollars: 20,
    });
    assert.deepEqual(r, { cents: 1800, source: 'role' });
  });
  it('falls back to staff.hourly_wage (DOLLARS → cents) when no settings', () => {
    const r = resolveWageCents({
      personOverrideCents: null,
      roleDefaultCents: null,
      staffHourlyWageDollars: 14.5,
    });
    // 14.5 dollars → 1450 cents, NOT 14.5 cents and NOT 145000.
    assert.deepEqual(r, { cents: 1450, source: 'staff' });
  });
  it('falls back to the benchmark when nothing is on file (missing wage)', () => {
    const r = resolveWageCents({
      personOverrideCents: null,
      roleDefaultCents: null,
      staffHourlyWageDollars: null,
    });
    assert.equal(r.source, 'default');
    assert.equal(r.cents, DEFAULT_HOURLY_WAGE_CENTS);
  });
  it('ignores zero/negative wages at each rung', () => {
    assert.equal(resolveWageCents({ personOverrideCents: 0, roleDefaultCents: 1800 }).source, 'role');
    assert.equal(resolveWageCents({ roleDefaultCents: -5, staffHourlyWageDollars: 12 }).source, 'staff');
    assert.equal(resolveWageCents({ staffHourlyWageDollars: 0 }).source, 'default');
  });
});

describe('laborCentsForMinutes (daily OT at 1.5×)', () => {
  it('costs a plain 8h day with no overtime', () => {
    // 8h * $20/hr = $160.00 = 16000 cents.
    assert.equal(laborCentsForMinutes(480, 2000), 16000);
  });
  it('applies 1.5× past 8h/day', () => {
    // 10h @ $20: 8h regular ($160) + 2h OT @ $30 ($60) = $220 = 22000 cents.
    assert.equal(laborCentsForMinutes(600, 2000), 22000);
  });
  it('handles a partial hour', () => {
    // 7.5h @ $14.60 = 730/60... use round-per-component: regular only.
    // 450 min / 60 * 1460 = 10950 cents.
    assert.equal(laborCentsForMinutes(450, 1460), 10950);
  });
  it('returns 0 for zero/negative minutes or wage', () => {
    assert.equal(laborCentsForMinutes(0, 2000), 0);
    assert.equal(laborCentsForMinutes(-100, 2000), 0);
    assert.equal(laborCentsForMinutes(480, 0), 0);
  });
});

describe('totalLaborCents (OT is per-person, not pooled)', () => {
  it('does NOT pool minutes across people into overtime', () => {
    // Two people at 6h each (720 min total) @ $20 must be straight time
    // ($120 + $120 = $240), NOT 4h of pooled overtime.
    const pooledWrong = laborCentsForMinutes(720, 2000); // if you (wrongly) summed first
    const perPerson = totalLaborCents([
      { minutes: 360, wageCents: 2000 },
      { minutes: 360, wageCents: 2000 },
    ]);
    assert.equal(perPerson, 24000);
    assert.notEqual(perPerson, pooledWrong);
  });
});

describe('laborCostPct', () => {
  it('computes a percentage rounded to one decimal', () => {
    // $160 labor / $1000 revenue = 16.0%
    assert.equal(laborCostPct(16000, 100000), 16);
    // $345 / $1000 = 34.5%
    assert.equal(laborCostPct(34500, 100000), 34.5);
  });
  it('returns null when revenue is null, zero, or negative (honest cost-only)', () => {
    assert.equal(laborCostPct(16000, null), null);
    assert.equal(laborCostPct(16000, 0), null);
    assert.equal(laborCostPct(16000, -100), null);
  });
});

describe('classifyLaborBand', () => {
  const t = DEFAULT_LABOR_TARGET_PCT; // 30
  it('good at or below target', () => {
    assert.equal(classifyLaborBand(10, t), 'good');
    assert.equal(classifyLaborBand(t, t), 'good');
  });
  it('warn within the band above target', () => {
    assert.equal(classifyLaborBand(t + 0.1, t), 'warn');
    assert.equal(classifyLaborBand(t + LABOR_WARN_BAND_PTS, t), 'warn');
  });
  it('over beyond target + band', () => {
    assert.equal(classifyLaborBand(t + LABOR_WARN_BAND_PTS + 0.1, t), 'over');
    assert.equal(classifyLaborBand(99, t), 'over');
  });
});

describe('canViewLaborCost', () => {
  it('allows the management trio', () => {
    for (const role of ['admin', 'owner', 'general_manager']) {
      assert.equal(canViewLaborCost(role), true, role);
    }
  });
  it('denies operational roles and unknowns', () => {
    for (const role of ['front_desk', 'housekeeping', 'maintenance', 'staff', '', null, undefined]) {
      assert.equal(canViewLaborCost(role as string | null | undefined), false, String(role));
    }
  });
});
