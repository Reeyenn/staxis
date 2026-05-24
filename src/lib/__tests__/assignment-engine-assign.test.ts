/**
 * Integration tests for the greedy assignment driver. These verify
 * end-to-end behavior — fairness, zones, language, overtime, sick
 * callout re-spreads, manager override — at the assignTasks() level.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignTasks,
  rebalanceForSickCallout,
  previewReassignment,
} from '@/lib/assignment-engine';

import { mkTask, mkHk, mkConfig, FIXED_NOW_MS } from './assignment-engine-fixtures';

describe('assignTasks — fairness', () => {
  it('balances minutes across HKs rather than just room count', () => {
    // 4 tasks: one 60-min deep clean and three 15-min stayovers.
    // With two equal HKs, the deep clean should go to one, the three
    // stayovers to the other — same room count but balanced minutes.
    const tasks = [
      mkTask({ id: 't1', cleaning_type: 'deep', estimated_minutes: 60, room_number: '101' }),
      mkTask({ id: 't2', cleaning_type: 'stayover', estimated_minutes: 15, room_number: '102' }),
      mkTask({ id: 't3', cleaning_type: 'stayover', estimated_minutes: 15, room_number: '103' }),
      mkTask({ id: 't4', cleaning_type: 'stayover', estimated_minutes: 15, room_number: '104' }),
    ];
    // homeFloor undefined on both so floor-match doesn't tilt; identical
    // names; identical seniority. The only differentiator is workload.
    const hks = [
      mkHk({ id: 'hk-a', name: 'A', isSenior: true }),
      mkHk({ id: 'hk-b', name: 'B', isSenior: true }),
    ];
    const cfg = mkConfig();
    const result = assignTasks(tasks, hks, cfg);
    const aMin = result.workloadByHk['hk-a'];
    const bMin = result.workloadByHk['hk-b'];
    assert.ok(Math.abs(aMin - bMin) <= 30, `expected balanced minutes; got ${aMin}/${bMin}`);
    assert.equal(aMin + bMin, 105);
  });

  it('places everything when there are enough HKs', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      mkTask({ id: `t${i}`, cleaning_type: 'departure', room_number: `${200 + i}` }),
    );
    const hks = [mkHk({ id: 'a' }), mkHk({ id: 'b' }), mkHk({ id: 'c' })];
    const result = assignTasks(tasks, hks, mkConfig());
    assert.equal(result.unassigned.length, 0);
    assert.equal(result.decisions.length, 8);
  });
});

describe('assignTasks — zones (floor match)', () => {
  it('clusters consecutive rooms on the same floor for one HK', () => {
    // Two HKs with explicit home floors. The engine should keep each on
    // their floor when there's enough work to fill them.
    const tasks = [
      mkTask({ id: '101', room_number: '101' }),
      mkTask({ id: '102', room_number: '102' }),
      mkTask({ id: '103', room_number: '103' }),
      mkTask({ id: '201', room_number: '201' }),
      mkTask({ id: '202', room_number: '202' }),
      mkTask({ id: '203', room_number: '203' }),
    ];
    const hks = [
      mkHk({ id: 'floor1', homeFloor: 1 }),
      mkHk({ id: 'floor2', homeFloor: 2 }),
    ];
    const result = assignTasks(tasks, hks, mkConfig());
    const f1Queue = result.queueByHk['floor1'];
    const f2Queue = result.queueByHk['floor2'];
    // Each HK should end up with all rooms on their floor (or close to it).
    const f1OnFloor1 = f1Queue.filter(id => id.startsWith('1')).length;
    const f2OnFloor2 = f2Queue.filter(id => id.startsWith('2')).length;
    assert.ok(f1OnFloor1 >= 2, `floor1 HK should mostly get floor-1 rooms, got ${f1OnFloor1}`);
    assert.ok(f2OnFloor2 >= 2, `floor2 HK should mostly get floor-2 rooms, got ${f2OnFloor2}`);
  });
});

describe('assignTasks — skill match', () => {
  it('routes inspection_only tasks to the senior HK only', () => {
    const task = mkTask({ id: 'insp', cleaning_type: 'inspection_only', room_number: '301' });
    const trainee = mkHk({ id: 'trainee', isSenior: false });
    const senior = mkHk({ id: 'senior', isSenior: true });
    const result = assignTasks([task], [trainee, senior], mkConfig());
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0].housekeeperId, 'senior');
  });

  it('returns unassigned when only trainees are available for inspection work', () => {
    const task = mkTask({ id: 'insp', cleaning_type: 'inspection_only' });
    const trainees = [mkHk({ id: 't1', isSenior: false }), mkHk({ id: 't2', isSenior: false })];
    const result = assignTasks([task], trainees, mkConfig());
    assert.equal(result.unassigned.length, 1);
    assert.match(result.unassigned[0].reason, /senior/);
  });
});

describe('assignTasks — language match', () => {
  it('prefers a Spanish HK for a Spanish-speaking guest', () => {
    const task = mkTask({ id: 'es-room', room_number: '205', guest_language: 'es' });
    const en = mkHk({ id: 'en-hk', language: 'en' });
    const es = mkHk({ id: 'es-hk', language: 'es' });
    const result = assignTasks([task], [en, es], mkConfig());
    assert.equal(result.decisions[0].housekeeperId, 'es-hk');
  });

  it('does not refuse to place if no language match exists', () => {
    const task = mkTask({ guest_language: 'es' });
    const en = mkHk({ id: 'en-hk', language: 'en' });
    const result = assignTasks([task], [en], mkConfig());
    assert.equal(result.decisions.length, 1);
    assert.equal(result.unassigned.length, 0);
  });
});

describe('assignTasks — overtime penalty', () => {
  it('routes work to the in-cap HK when the other is over hours', () => {
    const tasks = [mkTask({ id: 't1', room_number: '201' })];
    const over = mkHk({ id: 'over', weeklyHours: 45, maxWeeklyHours: 40 });
    const ok = mkHk({ id: 'ok', weeklyHours: 20, maxWeeklyHours: 40 });
    const result = assignTasks(tasks, [over, ok], mkConfig());
    assert.equal(result.decisions[0].housekeeperId, 'ok');
  });

  it('still places work when ALL hks are over hours (no other choice)', () => {
    const tasks = [mkTask({ id: 't1', room_number: '201' })];
    const hks = [
      mkHk({ id: 'a', weeklyHours: 45, maxWeeklyHours: 40 }),
      mkHk({ id: 'b', weeklyHours: 45, maxWeeklyHours: 40 }),
    ];
    const result = assignTasks(tasks, hks, mkConfig());
    // Engine places SOMETHING — better to overload than to silently drop.
    assert.equal(result.decisions.length, 1);
  });
});

describe('assignTasks — trainee penalty', () => {
  it('prefers a senior over a trainee for urgent tasks', () => {
    const task = mkTask({ id: 'rush', priority: 'urgent', room_number: '201' });
    const trainee = mkHk({ id: 'trainee', isSenior: false });
    const senior = mkHk({ id: 'senior', isSenior: true });
    const result = assignTasks([task], [trainee, senior], mkConfig());
    assert.equal(result.decisions[0].housekeeperId, 'senior');
  });

  it('still places urgent task on a trainee if no senior is available', () => {
    const task = mkTask({ id: 'rush', priority: 'urgent' });
    const trainee = mkHk({ id: 'trainee', isSenior: false });
    const result = assignTasks([task], [trainee], mkConfig());
    assert.equal(result.decisions[0].housekeeperId, 'trainee');
  });
});

describe('assignTasks — rush priority queue order', () => {
  it('places urgent tasks at the front of the HK queue', () => {
    // Three tasks: normal, normal, urgent. All on floor 2 so floor-match
    // doesn't decide. One HK — they get all three. Urgent should be #1
    // in the final sorted queue.
    const tasks = [
      mkTask({ id: 'n1', priority: 'normal', room_number: '201' }),
      mkTask({ id: 'n2', priority: 'normal', room_number: '202' }),
      mkTask({ id: 'rush', priority: 'urgent', room_number: '203' }),
    ];
    const hk = mkHk({ id: 'solo', homeFloor: 2 });
    const result = assignTasks(tasks, [hk], mkConfig());
    assert.equal(result.queueByHk['solo'][0], 'rush');
  });
});

describe('rebalanceForSickCallout', () => {
  it('re-spreads an absent HK\'s tasks across the remaining roster', () => {
    // Maria's three rooms after she calls in sick.
    const tasksToRespread = [
      mkTask({ id: 'r1', room_number: '301', cleaning_type: 'departure' }),
      mkTask({ id: 'r2', room_number: '302', cleaning_type: 'departure' }),
      mkTask({ id: 'r3', room_number: '303', cleaning_type: 'departure' }),
    ];
    const remaining = [
      mkHk({ id: 'alice', homeFloor: 1 }),
      mkHk({ id: 'bob', homeFloor: 3 }),
    ];
    // Existing workloads as of the callout: Alice has 200 min, Bob 60 min.
    const workloadByHk = { alice: 200, bob: 60 };
    const result = rebalanceForSickCallout(tasksToRespread, remaining, workloadByHk, mkConfig());
    // All three placed.
    assert.equal(result.decisions.length, 3);
    // Bob (lighter load + on floor 3) should pick up at least 2 of the
    // three floor-3 rooms.
    const bobsQueue = result.queueByHk['bob'];
    assert.ok(bobsQueue.length >= 2, `bob picks up most of the re-spread; got ${bobsQueue.length}`);
  });

  it('reports unassigned when no remaining HK is eligible', () => {
    const task = mkTask({ cleaning_type: 'inspection_only' });
    const onlyTrainees = [mkHk({ id: 'tr', isSenior: false })];
    const result = rebalanceForSickCallout([task], onlyTrainees, {}, mkConfig());
    assert.equal(result.unassigned.length, 1);
  });
});

describe('previewReassignment', () => {
  it('shows minute deltas for both HKs without persisting', () => {
    const task = mkTask({ cleaning_type: 'departure', estimated_minutes: 30 });
    const preview = previewReassignment({
      task,
      fromHkId: 'a',
      toHkId: 'b',
      workloadByHk: { a: 120, b: 90 },
      cfg: mkConfig(),
    });
    assert.equal(preview.from.before, 120);
    assert.equal(preview.from.after, 90);
    assert.equal(preview.to.before, 90);
    assert.equal(preview.to.after, 120);
    assert.equal(preview.taskMinutes, 30);
  });
});

describe('assignTasks — determinism', () => {
  it('produces the same result on repeat calls', () => {
    const tasks = [
      mkTask({ id: 't1', room_number: '101' }),
      mkTask({ id: 't2', room_number: '102' }),
      mkTask({ id: 't3', room_number: '201' }),
    ];
    const hks = [mkHk({ id: 'a' }), mkHk({ id: 'b' })];
    const cfg = mkConfig({ nowMs: FIXED_NOW_MS });
    const r1 = assignTasks(tasks, hks, cfg);
    const r2 = assignTasks(tasks, hks, cfg);
    assert.deepEqual(r1.decisions.map(d => ({ t: d.taskId, h: d.housekeeperId })),
                     r2.decisions.map(d => ({ t: d.taskId, h: d.housekeeperId })));
  });
});
