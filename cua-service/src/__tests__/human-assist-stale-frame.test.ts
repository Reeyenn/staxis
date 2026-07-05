/**
 * Pins the 2026-07 round-2 audit ITEM B fix (human-assist.ts) so it can't
 * regress.
 *
 * ITEM B — a REUSED help-request row whose refresh UPDATE fails still shows
 * the PREVIOUS attempt's (possibly wrong-target) screenshot. The admin clicks
 * these frames, so a takeover answer against a stale one could land a physical
 * click on a page the robot has moved off. The fix: on a failed refresh the
 * row is expired (assist route commits only WHERE status='pending', so the
 * answer can no longer be accepted) AND the caller refuses to wait on it —
 * requestHelp falls through to 'unavailable' for that target.
 *
 * `shouldWaitOnReusedRow` is the pure decision at both reuse call sites: only
 * a truthy refresh outcome (refresh landed, or an answer legitimately raced in
 * on its own frame) is safe to wait on; a failed refresh (false) never is.
 */

// MUST be first — human-assist.ts imports ./supabase.js, which builds the
// realtime client at module load and crashes under Node 20 without a WS shim.
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { shouldWaitOnReusedRow } from '../human-assist.js';

describe('shouldWaitOnReusedRow — refuse a stale reused help-request frame (ITEM B)', () => {
  test('a landed refresh (true) is safe to wait on', () => {
    assert.equal(shouldWaitOnReusedRow(true), true);
  });

  test('a failed refresh (false) is NEVER waited on — caller must fall through to unavailable', () => {
    // This is the crux: false = the UPDATE errored, the row still carries the
    // prior attempt's screenshot/target. Returning true here would let the
    // admin answer a stale frame and fire a click on the wrong live page.
    assert.equal(shouldWaitOnReusedRow(false), false);
  });
});
