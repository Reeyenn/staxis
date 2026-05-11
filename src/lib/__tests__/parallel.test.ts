/**
 * Tests for runWithConcurrency in src/lib/parallel.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runWithConcurrency } from '../parallel';

describe('runWithConcurrency', () => {
  it('returns one outcome per input, in input order', async () => {
    const inputs = [1, 2, 3, 4, 5];
    const outcomes = await runWithConcurrency(inputs, async (n) => n * 2, 2);
    assert.equal(outcomes.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(outcomes[i].input, inputs[i]);
      assert.equal(outcomes[i].ok, true);
      if (outcomes[i].ok) {
        assert.equal((outcomes[i] as { value: number }).value, inputs[i] * 2);
      }
    }
  });

  it('records failures without short-circuiting the rest', async () => {
    const inputs = ['ok-1', 'fail', 'ok-2'];
    const outcomes = await runWithConcurrency(
      inputs,
      async (s) => {
        if (s === 'fail') throw new Error('boom');
        return s.toUpperCase();
      },
      2,
    );
    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[1].ok, false);
    assert.equal(outcomes[2].ok, true);
    if (!outcomes[1].ok) {
      assert.equal((outcomes[1].error as Error).message, 'boom');
    }
  });

  it('never runs more than `concurrency` tasks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const task = async (_: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Tiny await to force scheduling; setTimeout(0) is microtask + macrotask
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return _;
    };
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), task, 3);
    assert.ok(peak <= 3, `expected peak ≤ 3, got ${peak}`);
    assert.ok(peak >= 2, `expected peak ≥ 2 (otherwise concurrency is useless), got ${peak}`);
  });

  it('handles empty input array without spawning workers', async () => {
    const outcomes = await runWithConcurrency<number, number>([], async (n) => n, 5);
    assert.deepEqual(outcomes, []);
  });

  it('clamps concurrency to items.length so empty workers don\'t hang', async () => {
    // 2 items, requested concurrency 10 — should run both, not spawn 10 workers.
    const outcomes = await runWithConcurrency(['a', 'b'], async (s) => s, 10);
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[1].ok, true);
  });

  it('treats concurrency < 1 as 1 (defensive clamp)', async () => {
    const outcomes = await runWithConcurrency([1, 2, 3], async (n) => n, 0);
    assert.equal(outcomes.length, 3);
    for (const o of outcomes) assert.equal(o.ok, true);
  });
});
