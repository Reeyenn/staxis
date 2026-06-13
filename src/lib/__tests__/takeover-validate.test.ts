/**
 * Tests for src/lib/pms/takeover-validate.ts — the request gate for the
 * founder-takeover routes. A bad coordinate here can send the robot a click
 * that executes physically in a real PMS, so bounds + shape are load-bearing.
 *
 * Run via: npx tsx --test src/lib/__tests__/takeover-validate.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTakeoverStart,
  validateTakeoverCommand,
  validateTakeoverCoordinate,
} from '@/lib/pms/takeover-validate';

const JOB = '00000000-0000-4000-8000-000000000000';

describe('validateTakeoverStart', () => {
  test('accepts start with no target', () => {
    const r = validateTakeoverStart({ jobId: JOB, intent: 'start' });
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.intent, 'start'); assert.equal(r.targetKey, null); }
  });

  test('accepts skip with a targetKey + note', () => {
    const r = validateTakeoverStart({ jobId: JOB, intent: 'skip', targetKey: 'getRevenueDaily', note: '  not used  ' });
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.intent, 'skip'); assert.equal(r.targetKey, 'getRevenueDaily'); assert.equal(r.note, 'not used'); }
  });

  test('rejects a non-uuid jobId', () => {
    assert.equal(validateTakeoverStart({ jobId: 'nope', intent: 'start' }).ok, false);
  });

  test('rejects an unknown intent', () => {
    assert.equal(validateTakeoverStart({ jobId: JOB, intent: 'click' }).ok, false);
  });

  test('drops a malformed targetKey (no injection) rather than failing', () => {
    const r = validateTakeoverStart({ jobId: JOB, intent: 'skip', targetKey: 'a b; drop' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.targetKey, null);
  });

  test('rejects a non-object body', () => {
    assert.equal(validateTakeoverStart('x').ok, false);
    assert.equal(validateTakeoverStart(null).ok, false);
  });
});

describe('validateTakeoverCommand', () => {
  test('click requires a finite coordinate AND a frameSeq', () => {
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'click' }).ok, false);
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'click', coordinate: { x: 10, y: 20 } }).ok, false); // no frameSeq
    const r = validateTakeoverCommand({ jobId: JOB, command: 'click', coordinate: { x: 10, y: 20 }, frameSeq: 3 });
    assert.equal(r.ok, true);
    if (r.ok) { assert.deepEqual(r.coordinate, { x: 10, y: 20 }); assert.equal(r.frameSeq, 3); }
  });

  test('rejects NaN / Infinity coordinates', () => {
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'click', coordinate: { x: NaN, y: 1 }, frameSeq: 0 }).ok, false);
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'click', coordinate: { x: 1, y: Infinity }, frameSeq: 0 }).ok, false);
  });

  test('rejects a negative / non-integer frameSeq', () => {
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'click', coordinate: { x: 1, y: 1 }, frameSeq: -1 }).ok, false);
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'click', coordinate: { x: 1, y: 1 }, frameSeq: 1.5 }).ok, false);
  });

  test('finish / cancel need no coordinate', () => {
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'finish' }).ok, true);
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'cancel' }).ok, true);
  });

  test("rejects 'skip' here (skip goes through /takeover, not /takeover-command)", () => {
    assert.equal(validateTakeoverCommand({ jobId: JOB, command: 'skip' }).ok, false);
  });

  test('rejects a non-uuid jobId', () => {
    assert.equal(validateTakeoverCommand({ jobId: 'x', command: 'finish' }).ok, false);
  });
});

describe('validateTakeoverCoordinate', () => {
  test('rounds and accepts in-bounds', () => {
    assert.deepEqual(validateTakeoverCoordinate({ x: 10.4, y: 20.6 }, 1280, 800), { x: 10, y: 21 });
  });
  test('rejects out-of-bounds (>= viewport, < 0)', () => {
    assert.equal(validateTakeoverCoordinate({ x: 1280, y: 0 }, 1280, 800), null);
    assert.equal(validateTakeoverCoordinate({ x: 0, y: 800 }, 1280, 800), null);
    assert.equal(validateTakeoverCoordinate({ x: -1, y: 0 }, 1280, 800), null);
  });
  test('accepts the last in-bounds pixel', () => {
    assert.deepEqual(validateTakeoverCoordinate({ x: 1279, y: 799 }, 1280, 800), { x: 1279, y: 799 });
  });
});
