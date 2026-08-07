/**
 * THE SUPPORTED WAY TO TURN IT OFF SET OFF THE ALARM.
 *
 * `/api/cron/companion-event-wake` is the one AI job whose healthy state is
 * writing nothing, so the doctor cannot ask "did it produce anything". It asks
 * a cleverer question instead: has every hotel's cursor moved in the last half
 * hour? A cursor only advances when a hotel was actually looked at, so a
 * stopped watcher is caught inside the hour. That is a good check.
 *
 * It had one blind spot, and it was on the path an operator is TOLD to take.
 * docs/cron-triggers.md: "Switching it OFF in the AI Control Center is
 * untouched and is the supported way to stop it." Doing that makes
 * `sweepAllProperties` return before it reads a single hotel, so no cursor
 * moves, so thirty minutes later the doctor warned that the sweep "is not
 * advancing cursors" and told the reader to go and check the logs of a job
 * they had just deliberately switched off. Every five minutes. Forever.
 *
 * A check that cries wolf on the documented action is worse than no check,
 * because the next amber is the real one.
 *
 * The route always knew: it writes `switchedOff` into its heartbeat notes on
 * exactly that path. The check never read it. It never read whether the
 * heartbeat query had FAILED either, which turned an unreadable row into a set
 * of zero counters, and zero counters is what a flawless run looks like.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { companionEventWakeVerdict } from '@/app/api/admin/doctor/route';

/**
 * The heartbeat notes the route ACTUALLY writes, for the two shapes that
 * matter. Taken from the `totals` object in
 * src/app/api/cron/companion-event-wake/route.ts, so a rename over there turns
 * these into stale keys the same way it would in production.
 */
const QUIET_NIGHT = {
  propertiesConsidered: 7,
  quiet: 7,
  listSwitchedOff: 0,
  prepared: 0,
  observed: 0,
  saidNothing: 0,
  dailyWakeCap: 0,
  spendCap: 0,
  spendUnavailable: 0,
  modelUnavailable: 0,
  noCursor: 0,
  readFailed: 0,
  windowAlreadyClaimed: 0,
  windowsClamped: 0,
  costUsd: 0,
  switchedOff: false,
  scoped: false,
} as const;

/** What the route writes when the feature is off: it returns before any hotel. */
const FEATURE_OFF = {
  ...QUIET_NIGHT,
  propertiesConsidered: 0,
  quiet: 0,
  switchedOff: true,
} as const;

describe('the companion event sweep, as the doctor reads it', () => {
  test('a normal ten minutes is quiet', () => {
    const v = companionEventWakeVerdict({ staleCount: 0, notes: { ...QUIET_NIGHT } });
    assert.equal(v.status, 'ok');
    assert.match(v.detail, /healthy/);
  });

  test('switching the feature off does not raise an alarm', () => {
    // Every cursor goes stale the moment the feature is off: that is not a
    // symptom, it is the definition. Seven hotels, none looked at, on purpose.
    const v = companionEventWakeVerdict({ staleCount: 7, notes: { ...FEATURE_OFF } });
    assert.equal(
      v.status,
      'ok',
      'the documented way to stop this feature lights the doctor amber and keeps it '
      + 'there, with a fix that points at a job nobody broke. That is how a founder '
      + `learns to ignore amber. Got: ${v.detail}`,
    );
    assert.match(v.detail, /switched off/i, 'and it has to say WHY nothing is being watched');
  });

  test('a genuinely stopped sweep is still caught', () => {
    // The switch is ON and the cursors are not moving. This is the case the
    // check exists for and it must survive the fix above.
    const v = companionEventWakeVerdict({ staleCount: 7, notes: { ...QUIET_NIGHT } });
    assert.equal(v.status, 'warn');
    assert.match(v.detail, /not looked at in over 30 min/);
  });

  test('an unreadable heartbeat is not read as a flawless run', () => {
    // With no heartbeat row every counter is zero, and zero is exactly what a
    // perfect ten minutes produces. Saying nothing here means the difference
    // between "nothing went wrong" and "I could not tell" disappears.
    const v = companionEventWakeVerdict({ staleCount: 0, notes: {}, heartbeatUnreadable: true });
    assert.equal(
      v.status,
      'warn',
      'a check that cannot read its own evidence reported health',
    );
    assert.match(v.detail, /could not be read/);
  });

  test('a hotel silenced by its daily spend cap is still reported', () => {
    const v = companionEventWakeVerdict({
      staleCount: 0,
      notes: { ...QUIET_NIGHT, spendCap: 2 },
    });
    assert.equal(v.status, 'warn');
    assert.match(v.detail, /silenced by the daily spend cap/);
  });

  test('hotels at their free wake limit are said out loud without being an alarm', () => {
    const v = companionEventWakeVerdict({
      staleCount: 0,
      notes: { ...QUIET_NIGHT, dailyWakeCap: 3 },
    });
    assert.equal(v.status, 'ok');
    assert.match(v.detail, /at today's wake limit/);
  });

  test('no user-facing line uses an em dash', () => {
    for (const notes of [QUIET_NIGHT, FEATURE_OFF, { ...QUIET_NIGHT, spendCap: 1 }]) {
      for (const staleCount of [0, 4]) {
        const v = companionEventWakeVerdict({ staleCount, notes: { ...notes } });
        assert.doesNotMatch(v.detail, /—/);
        if (v.fix) assert.doesNotMatch(v.fix, /—/);
      }
    }
  });
});
