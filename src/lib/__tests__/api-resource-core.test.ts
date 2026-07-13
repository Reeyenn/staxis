/**
 * Tests for the pure logic behind useApiResource / useApiAction
 * (src/lib/hooks/api-resource-core.ts).
 *
 * The React hook wires these to fetch/setState/setInterval; the hazards it
 * exists to kill — out-of-order responses, setState-after-unmount, poll
 * overlap, hidden-tab polling, blank-on-failed-poll — are all decided by
 * the functions tested here. Kept React-free because the test runner uses
 * --conditions=react-server (no client hooks available).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOutcome,
  createRequestGate,
  shouldHoldDataOnSourceChange,
  shouldPollTick,
} from '@/lib/hooks/api-resource-core';

describe('createRequestGate — stale-response dropping', () => {
  test('a lone request is current', () => {
    const gate = createRequestGate();
    const t = gate.begin();
    assert.equal(gate.isCurrent(t), true);
  });

  test('out-of-order responses: older ticket loses once a newer request starts', () => {
    // Slow request A fires, then fast request B (e.g. reload) fires. B's
    // response lands and wins; A's response lands later and must be dropped
    // or it clobbers fresher data.
    const gate = createRequestGate();
    const a = gate.begin();
    const b = gate.begin();
    assert.equal(gate.isCurrent(a), false, 'stale request must be dropped');
    assert.equal(gate.isCurrent(b), true, 'newest request must win');
  });

  test('invalidate() kills the outstanding ticket (unmount / disable / URL switch)', () => {
    const gate = createRequestGate();
    const t = gate.begin();
    gate.invalidate();
    assert.equal(gate.isCurrent(t), false);
  });

  test('a request begun after invalidate is current again (re-enable / new URL)', () => {
    const gate = createRequestGate();
    gate.begin();
    gate.invalidate();
    const fresh = gate.begin();
    assert.equal(gate.isCurrent(fresh), true);
  });

  test('three interleaved requests: only the last is current', () => {
    const gate = createRequestGate();
    const t1 = gate.begin();
    const t2 = gate.begin();
    const t3 = gate.begin();
    assert.equal(gate.isCurrent(t1), false);
    assert.equal(gate.isCurrent(t2), false);
    assert.equal(gate.isCurrent(t3), true);
  });

  test('gates are independent (two hooks on one page cannot cross-cancel)', () => {
    const gateA = createRequestGate();
    const gateB = createRequestGate();
    const a = gateA.begin();
    gateB.begin();
    gateB.invalidate();
    assert.equal(gateA.isCurrent(a), true);
  });
});

describe('shouldPollTick — poll gating', () => {
  test('fires only when enabled, visible, and idle', () => {
    assert.equal(shouldPollTick({ enabled: true, hidden: false, inFlight: false }), true);
  });

  test('skips while the tab is hidden (backgrounded housekeeper phone)', () => {
    assert.equal(shouldPollTick({ enabled: true, hidden: true, inFlight: false }), false);
  });

  test('skips while a request is in flight (no overlapping requests)', () => {
    assert.equal(shouldPollTick({ enabled: true, hidden: false, inFlight: true }), false);
  });

  test('skips when disabled (capability/section gating)', () => {
    assert.equal(shouldPollTick({ enabled: false, hidden: false, inFlight: false }), false);
  });

  test('any single blocker is sufficient (full truth table)', () => {
    for (const enabled of [true, false]) {
      for (const hidden of [true, false]) {
        for (const inFlight of [true, false]) {
          const expected = enabled && !hidden && !inFlight;
          assert.equal(
            shouldPollTick({ enabled, hidden, inFlight }),
            expected,
            `enabled=${enabled} hidden=${hidden} inFlight=${inFlight}`,
          );
        }
      }
    }
  });
});

describe('shouldHoldDataOnSourceChange — keepDataOnSourceChange semantics', () => {
  test('default (opt-out): a URL switch never holds — old data drops, spinner shows', () => {
    for (const isFirstIdentity of [true, false]) {
      for (const hasData of [true, false]) {
        assert.equal(
          shouldHoldDataOnSourceChange({
            keepDataOnSourceChange: false,
            isFirstIdentity,
            hasData,
          }),
          false,
          `isFirstIdentity=${isFirstIdentity} hasData=${hasData}`,
        );
      }
    }
  });

  test('opted in: a later source switch with last-good data holds it (no blank, no spinner)', () => {
    assert.equal(
      shouldHoldDataOnSourceChange({
        keepDataOnSourceChange: true,
        isFirstIdentity: false,
        hasData: true,
      }),
      true,
    );
  });

  test('opted in: the FIRST identity still shows the initial loading state', () => {
    assert.equal(
      shouldHoldDataOnSourceChange({
        keepDataOnSourceChange: true,
        isFirstIdentity: true,
        hasData: false,
      }),
      false,
    );
  });

  test('opted in: nothing to hold (no prior data) falls back to the loading state', () => {
    // Holding "nothing" would render a silent blank page — worse than the
    // spinner. E.g. the previous URL errored with keepDataOnError=false.
    assert.equal(
      shouldHoldDataOnSourceChange({
        keepDataOnSourceChange: true,
        isFirstIdentity: false,
        hasData: false,
      }),
      false,
    );
  });
});

describe('applyOutcome — error semantics', () => {
  const rows = [{ id: 'r1' }, { id: 'r2' }];

  test('success replaces data and clears error', () => {
    const next = applyOutcome([{ id: 'old' }], { kind: 'success', data: rows }, false);
    assert.deepEqual(next, { data: rows, error: null });
  });

  test('success clears a previous error regardless of keepDataOnError', () => {
    for (const keep of [true, false]) {
      const next = applyOutcome(null, { kind: 'success', data: rows }, keep);
      assert.equal(next.error, null);
      assert.deepEqual(next.data, rows);
    }
  });

  test('default (keepDataOnError=false): error blanks data', () => {
    const next = applyOutcome(rows, { kind: 'error', message: 'boom' }, false);
    assert.deepEqual(next, { data: null, error: 'boom' });
  });

  test('keepDataOnError=true: failed poll holds last-good data AND surfaces the error', () => {
    // CalloutBanner/laundry semantics — a flapping network mid-shift must
    // not blank the page a housekeeper is working from.
    const next = applyOutcome(rows, { kind: 'error', message: 'network down' }, true);
    assert.deepEqual(next.data, rows);
    assert.equal(next.error, 'network down');
  });

  test('keepDataOnError=true with no prior data still yields null data + error', () => {
    // First-ever load failing has nothing to hold; must not invent data.
    const next = applyOutcome<{ id: string }[]>(
      null,
      { kind: 'error', message: 'boom' },
      true,
    );
    assert.deepEqual(next, { data: null, error: 'boom' });
  });

  test('recovery after a held error: next success swaps in fresh data', () => {
    const afterError = applyOutcome(rows, { kind: 'error', message: 'blip' }, true);
    const fresh = [{ id: 'r3' }];
    const next = applyOutcome(afterError.data, { kind: 'success', data: fresh }, true);
    assert.deepEqual(next, { data: fresh, error: null });
  });
});
