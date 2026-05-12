/**
 * Tests for runWithConcurrency in src/lib/parallel.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runWithConcurrency, applyShardFilter } from '../parallel';

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

describe('applyShardFilter', () => {
  const props = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  it('default (no params) returns all items, marked as shard 1/1', () => {
    const result = applyShardFilter(props, new URLSearchParams());
    assert.equal(result.items.length, 8);
    assert.equal(result.shardCount, 1);
    assert.equal(result.shardOffset, 0);
    assert.match(result.header, /no sharding/);
  });

  it('shard_count=4 with offset=0 returns indices 0,4 (every 4th)', () => {
    const result = applyShardFilter(
      props,
      new URLSearchParams('shard_offset=0&shard_count=4'),
    );
    assert.deepEqual(result.items, ['a', 'e']);
    assert.equal(result.shardCount, 4);
    assert.equal(result.shardOffset, 0);
  });

  it('shard_count=4 with offset=2 returns indices 2,6', () => {
    const result = applyShardFilter(
      props,
      new URLSearchParams('shard_offset=2&shard_count=4'),
    );
    assert.deepEqual(result.items, ['c', 'g']);
  });

  it('all shards together cover every item exactly once', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const result = applyShardFilter(
        props,
        new URLSearchParams(`shard_offset=${i}&shard_count=4`),
      );
      for (const item of result.items) {
        assert.ok(!seen.has(item), `${item} appeared in two shards — partition broken`);
        seen.add(item);
      }
    }
    assert.equal(seen.size, props.length, 'every item must land in exactly one shard');
  });

  it('clamps invalid offset (>= count) to 0', () => {
    const result = applyShardFilter(
      props,
      new URLSearchParams('shard_offset=10&shard_count=4'),
    );
    // offset >= count is invalid; falls back to 0
    assert.equal(result.shardOffset, 0);
    assert.deepEqual(result.items, ['a', 'e']);
  });

  it('clamps shard_count to [1, 64]', () => {
    const tooLarge = applyShardFilter(
      props,
      new URLSearchParams('shard_count=999'),
    );
    assert.equal(tooLarge.shardCount, 1, 'shard_count > 64 clamps to 1 (no sharding)');
    const zero = applyShardFilter(props, new URLSearchParams('shard_count=0'));
    assert.equal(zero.shardCount, 1, 'shard_count < 1 clamps to 1');
  });

  it('handles empty input array under any shard config', () => {
    const result = applyShardFilter<string>(
      [],
      new URLSearchParams('shard_offset=2&shard_count=4'),
    );
    assert.deepEqual(result.items, []);
    assert.equal(result.shardCount, 4);
  });
});
