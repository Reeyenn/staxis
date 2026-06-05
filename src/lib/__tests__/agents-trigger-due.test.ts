// Pure due-logic for the schedule tick — tz/day/time + idempotency + retry cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentDue } from '@/lib/agents/engine';
import type { ScheduleTriggerConfig, RunStatus } from '@/lib/agents/types';

const trig: ScheduleTriggerConfig = { type: 'schedule', atLocalTime: '08:00' };
const WED = 3;

test('due at/after the configured local time, not before', () => {
  assert.equal(isAgentDue(trig, [], '08:00', WED), true);
  assert.equal(isAgentDue(trig, [], '09:30', WED), true);
  assert.equal(isAgentDue(trig, [], '07:59', WED), false);
});

test('already-handled today is not due again', () => {
  for (const s of ['success', 'awaiting_approval', 'running'] as RunStatus[]) {
    assert.equal(isAgentDue(trig, [s], '09:00', WED), false, `${s} should block a re-run`);
  }
});

test('a failed run is retryable, up to the cap', () => {
  assert.equal(isAgentDue(trig, ['failed'], '09:00', WED), true);
  assert.equal(isAgentDue(trig, ['failed', 'failed'], '09:00', WED), true);
  assert.equal(isAgentDue(trig, ['failed', 'failed', 'failed'], '09:00', WED), false, 'retry cap reached');
});

test('daysOfWeek gates the run', () => {
  const mon: ScheduleTriggerConfig = { type: 'schedule', atLocalTime: '08:00', daysOfWeek: [1] };
  assert.equal(isAgentDue(mon, [], '08:00', 1), true);
  assert.equal(isAgentDue(mon, [], '08:00', 2), false);
});

test('an empty daysOfWeek never fires (safe default for a malformed trigger)', () => {
  const never: ScheduleTriggerConfig = { type: 'schedule', atLocalTime: '00:00', daysOfWeek: [] };
  for (let d = 0; d < 7; d++) assert.equal(isAgentDue(never, [], '23:59', d), false);
});
