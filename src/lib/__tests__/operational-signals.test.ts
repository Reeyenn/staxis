/**
 * Operational-signal detection tests (pure). These pin the "what counts as a
 * durable pattern" thresholds + the IDEMPOTENCY-critical slug stability (same
 * pattern → same topic regardless of count, so nightly re-runs UPDATE one memory
 * row instead of spamming). No DB — the aggregators are pure over raw rows.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  signalsFromWorkOrders,
  signalsFromComplaints,
  signalsFromInspections,
  signalsFromCleaning,
  rankAndCapSignals,
  insightSeverityFromTopic,
  templateContent,
  normalizeRoom,
  floorOf,
  MAX_SIGNALS,
  type OperationalSignal,
} from '@/lib/agent/operational-signals';

// Weekend (Fri/Sat/Sun) + weekday ISO timestamps for the noise-by-floor test.
const SAT = '2026-06-06T12:00:00Z'; // getUTCDay = 6
const SUN = '2026-06-07T12:00:00Z'; // 0
const FRI = '2026-06-05T12:00:00Z'; // 5
const TUE = '2026-06-02T12:00:00Z'; // 2 (weekday)

describe('normalizeRoom / floorOf', () => {
  test('normalizeRoom strips zero-pad + whitespace', () => {
    assert.equal(normalizeRoom(' 305 '), '305');
    assert.equal(normalizeRoom('0305'), '305');
    assert.equal(normalizeRoom('007'), '7');
    assert.equal(normalizeRoom(''), null);
    assert.equal(normalizeRoom(null), null);
  });
  test('floorOf takes the floor prefix', () => {
    assert.equal(floorOf('305'), '3');
    assert.equal(floorOf('1203'), '12');
    assert.equal(floorOf('12'), '12');
    assert.equal(floorOf('5'), '5');
  });
});

describe('signalsFromWorkOrders', () => {
  test('≥3 same room+category fires; 2 does not', () => {
    const rows = [
      { room_number: '305', category: 'hvac' },
      { room_number: '305', category: 'hvac' },
      { room_number: '305', category: 'hvac' },
      { room_number: '410', category: 'plumbing' },
      { room_number: '410', category: 'plumbing' },
    ];
    const sigs = signalsFromWorkOrders(rows);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].topic, 'op_maint_305_hvac');
    assert.equal(sigs[0].severity, 'attention');
    assert.equal(sigs[0].count, 3);
  });

  test('different categories on the same room do not merge', () => {
    const rows = [
      { room_number: '305', category: 'hvac' },
      { room_number: '305', category: 'hvac' },
      { room_number: '305', category: 'plumbing' },
    ];
    assert.equal(signalsFromWorkOrders(rows).length, 0); // neither category hits 3
  });

  test('null room is skipped', () => {
    const rows = [
      { room_number: null, category: 'hvac' },
      { room_number: null, category: 'hvac' },
      { room_number: null, category: 'hvac' },
    ];
    assert.equal(signalsFromWorkOrders(rows).length, 0);
  });

  test('SLUG STABILITY: same room+category → same topic regardless of count', () => {
    const four = signalsFromWorkOrders(Array(4).fill({ room_number: '305', category: 'hvac' }));
    const five = signalsFromWorkOrders(Array(5).fill({ room_number: '305', category: 'hvac' }));
    assert.equal(four[0].topic, five[0].topic, 'topic must not encode the count (idempotent re-learning)');
    assert.notEqual(four[0].metric, five[0].metric, 'the count lives in the metric/content, not the topic');
  });
});

describe('signalsFromComplaints', () => {
  test('≥3 same room+category fires', () => {
    const rows = [
      { room_number: '305', category: 'maintenance', severity: 'low', created_at: TUE },
      { room_number: '305', category: 'maintenance', severity: 'low', created_at: TUE },
      { room_number: '305', category: 'maintenance', severity: 'medium', created_at: TUE },
    ];
    const sigs = signalsFromComplaints(rows);
    assert.ok(sigs.some((s) => s.topic === 'op_complaint_305_maintenance'));
  });

  test('≥2 high-severity fires even below the count threshold', () => {
    const rows = [
      { room_number: '210', category: 'cleanliness', severity: 'high', created_at: TUE },
      { room_number: '210', category: 'cleanliness', severity: 'high', created_at: TUE },
    ];
    const sigs = signalsFromComplaints(rows);
    assert.ok(sigs.some((s) => s.topic === 'op_complaint_210_cleanliness'));
  });

  test('weekend noise by floor: ≥4 weekend noise on one floor fires; weekday excluded', () => {
    const rows = [
      { room_number: '401', category: 'noise', severity: 'low', created_at: FRI },
      { room_number: '402', category: 'noise', severity: 'low', created_at: SAT },
      { room_number: '403', category: 'noise', severity: 'low', created_at: SUN },
      { room_number: '404', category: 'noise', severity: 'low', created_at: SAT },
      { room_number: '405', category: 'noise', severity: 'low', created_at: TUE }, // weekday — excluded
    ];
    const sigs = signalsFromComplaints(rows);
    const noise = sigs.find((s) => s.topic === 'op_noise_floor_4');
    assert.ok(noise, 'floor-4 weekend noise should fire');
    assert.equal(noise!.count, 4, 'the Tuesday complaint must not be counted');
  });

  test('3 weekend noise does NOT fire (threshold is 4)', () => {
    const rows = [
      { room_number: '401', category: 'noise', severity: 'low', created_at: FRI },
      { room_number: '402', category: 'noise', severity: 'low', created_at: SAT },
      { room_number: '403', category: 'noise', severity: 'low', created_at: SUN },
    ];
    assert.equal(signalsFromComplaints(rows).some((s) => s.topic === 'op_noise_floor_4'), false);
  });
});

describe('signalsFromInspections', () => {
  test('≥3 fails on one room fires; passes ignored', () => {
    const rows = [
      { room_number: '512', result: 'fail' },
      { room_number: '512', result: 'fail' },
      { room_number: '512', result: 'fail' },
      { room_number: '512', result: 'pass' },
    ];
    const sigs = signalsFromInspections(rows);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].topic, 'op_inspect_fail_512');
    assert.equal(sigs[0].count, 3);
  });
});

describe('signalsFromCleaning', () => {
  test('a room consistently >1.5× the property median fires (info)', () => {
    // Property median ≈ 20; room 999 median = 60 (>30). Need ≥5 samples on 999.
    const rows = [
      ...Array(10).fill({ room_number: '100', duration_minutes: 20, status: 'recorded' }),
      ...Array(6).fill({ room_number: '999', duration_minutes: 60, status: 'recorded' }),
    ];
    const sigs = signalsFromCleaning(rows);
    const slow = sigs.find((s) => s.topic === 'op_clean_slow_999');
    assert.ok(slow, 'slow room should fire');
    assert.equal(slow!.severity, 'info');
  });

  test('discarded (junk) cleans are ignored and <5 samples does not fire', () => {
    const rows = [
      ...Array(10).fill({ room_number: '100', duration_minutes: 20, status: 'recorded' }),
      ...Array(3).fill({ room_number: '999', duration_minutes: 90, status: 'recorded' }), // only 3 samples
      { room_number: '999', duration_minutes: 90, status: 'discarded' },
    ];
    assert.equal(signalsFromCleaning(rows).some((s) => s.topic === 'op_clean_slow_999'), false);
  });

  test('empty input → no signals', () => {
    assert.deepEqual(signalsFromCleaning([]), []);
  });
});

describe('insightSeverityFromTopic', () => {
  test('maps op_ prefixes; returns null for non-operational topics', () => {
    assert.equal(insightSeverityFromTopic('op_maint_305_hvac'), 'attention');
    assert.equal(insightSeverityFromTopic('op_compliance_pool_ph'), 'attention');
    assert.equal(insightSeverityFromTopic('op_clean_slow_999'), 'info');
    assert.equal(insightSeverityFromTopic('breakfast_area_name'), null); // conversation fact
  });
});

describe('templateContent + rankAndCapSignals', () => {
  const mk = (over: Partial<OperationalSignal>): OperationalSignal => ({
    topic: 'op_x',
    category: 'maintenance',
    severity: 'attention',
    targetLabel: 'Room 305',
    metric: '4 hvac work orders in 30 days',
    count: 4,
    windowDays: 30,
    ...over,
  });

  test('templateContent yields a PII-free sentence with the evidence', () => {
    const c = templateContent(mk({}));
    assert.ok(c.includes('Room 305'));
    assert.ok(c.includes('4 hvac work orders in 30 days'));
  });

  test('rankAndCapSignals: attention before info, then higher count, capped', () => {
    const many = [
      mk({ topic: 'i1', severity: 'info', count: 99 }),
      mk({ topic: 'a1', severity: 'attention', count: 3 }),
      mk({ topic: 'a2', severity: 'attention', count: 9 }),
    ];
    const ranked = rankAndCapSignals(many);
    assert.equal(ranked[0].topic, 'a2', 'attention + highest count first');
    assert.equal(ranked[1].topic, 'a1');
    assert.equal(ranked[2].topic, 'i1', 'info ranks last despite a high count');
  });

  test('rankAndCapSignals caps at MAX_SIGNALS', () => {
    const lots = Array.from({ length: MAX_SIGNALS + 5 }, (_, i) => mk({ topic: `op_${i}`, count: i }));
    assert.equal(rankAndCapSignals(lots).length, MAX_SIGNALS);
  });
});
