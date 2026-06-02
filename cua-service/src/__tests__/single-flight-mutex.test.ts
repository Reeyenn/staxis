/**
 * Phase 3 — the exclusive read/write mutex (Codex P0-1 fix). runExclusive()
 * must truly serialize against itself AND against the skip-if-busy schedule()
 * read path: a write blocks new reads, and an in-flight read blocks a write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExclusive, schedule } from '../single-flight.js';

test('runExclusive serializes concurrent callers — never overlapping', async () => {
  const pid = 'mutex-test-serialize';
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const work = (tag: string) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${tag}`);
    await new Promise((r) => setTimeout(r, 25));
    order.push(`end-${tag}`);
    active--;
    return tag;
  };
  const [a, b] = await Promise.all([
    runExclusive(pid, 2000, work('A')),
    runExclusive(pid, 2000, work('B')),
  ]);
  assert.equal(a, 'A');
  assert.equal(b, 'B');
  assert.equal(maxActive, 1, 'the two exclusive runs must never overlap');
  // One fully finished before the other began.
  const ok =
    order.indexOf('end-A') < order.indexOf('start-B') ||
    order.indexOf('end-B') < order.indexOf('start-A');
  assert.ok(ok, `expected non-overlapping order, got ${order.join(',')}`);
});

test('schedule() (read) SKIPS while runExclusive (write) holds the lock', async () => {
  const pid = 'mutex-test-read-skips';
  let readRan = false;
  const writeP = runExclusive(pid, 2000, async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  await new Promise((r) => setTimeout(r, 10)); // let the write take the lock
  const readResult = await schedule(pid, 2000, async () => {
    readRan = true;
    return 'read';
  });
  assert.equal(readResult, null, 'read tick must skip while a write holds the mutex');
  assert.equal(readRan, false, 'the skipped read must not run its fn');
  await writeP;
});

test('runExclusive (write) WAITS OUT an in-flight schedule() read', async () => {
  const pid = 'mutex-test-write-waits';
  const order: string[] = [];
  const readP = schedule(pid, 2000, async () => {
    order.push('read-start');
    await new Promise((r) => setTimeout(r, 40));
    order.push('read-end');
    return 'r';
  });
  await new Promise((r) => setTimeout(r, 5)); // ensure the read is in flight
  const writeP = runExclusive(pid, 2000, async () => {
    order.push('write-start');
    order.push('write-end');
    return 'w';
  });
  await Promise.all([readP, writeP]);
  assert.ok(
    order.indexOf('write-start') > order.indexOf('read-end'),
    `write must start only after the in-flight read ended, got ${order.join(',')}`,
  );
});
