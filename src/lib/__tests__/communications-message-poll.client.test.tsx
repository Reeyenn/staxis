import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createSingleFlightRequest } from '@/app/communications/_components/CommsApp';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('Communications message polling single-flight', () => {
  test('poll ticks share a slow successful request, then a later tick can start fresh work', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first, second];
    let starts = 0;
    const run = createSingleFlightRequest(async () => {
      const response = responses[starts];
      starts += 1;
      assert.ok(response, 'unexpected request');
      return response.promise;
    });

    const initial = run();
    await Promise.resolve();
    assert.equal(starts, 1);

    // Model 3s and 6s poll ticks landing before an unusually slow response.
    // They must join the original request rather than invalidate/overlap it.
    const tickAtThreeSeconds = run();
    const tickAtSixSeconds = run();
    assert.strictEqual(tickAtThreeSeconds, initial);
    assert.strictEqual(tickAtSixSeconds, initial);
    assert.equal(starts, 1);

    first.resolve('slow success');
    assert.deepEqual(
      await Promise.all([initial, tickAtThreeSeconds, tickAtSixSeconds]),
      ['slow success', 'slow success', 'slow success'],
    );

    const laterTick = run();
    await Promise.resolve();
    assert.notStrictEqual(laterTick, initial);
    assert.equal(starts, 2, 'settlement must release the next poll');
    second.resolve('fresh success');
    assert.equal(await laterTick, 'fresh success');
  });

  test('a failed request also releases the next poll without overlap', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first, second];
    let starts = 0;
    const run = createSingleFlightRequest(async () => responses[starts++].promise);

    const request = run();
    const overlappingTick = run();
    assert.strictEqual(overlappingTick, request);
    first.reject(new Error('offline'));
    await assert.rejects(request, /offline/);

    const retry = run();
    await Promise.resolve();
    assert.equal(starts, 2);
    second.resolve('recovered');
    assert.equal(await retry, 'recovered');
  });

  test('a post-mutation refresh waits for the poll, then performs a fresh non-overlapping read', async () => {
    const poll = deferred<string>();
    const postMutation = deferred<string>();
    const responses = [poll, postMutation];
    let starts = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const run = createSingleFlightRequest(async () => {
      const response = responses[starts];
      starts += 1;
      assert.ok(response, 'unexpected request');
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        return await response.promise;
      } finally {
        inFlight -= 1;
      }
    });

    const activePoll = run();
    await Promise.resolve();
    const freshReload = run(true);
    assert.notStrictEqual(freshReload, activePoll, 'mutation reload must not adopt a pre-mutation response');
    assert.equal(starts, 1, 'trailing reload must wait instead of overlapping');

    poll.resolve('old snapshot');
    assert.equal(await activePoll, 'old snapshot');
    await Promise.resolve();
    assert.equal(starts, 2, 'fresh reload begins after the active poll settles');
    assert.equal(peakInFlight, 1);

    // An interval tick during the trailing refresh joins it instead of adding
    // a third request to the queue.
    const intervalTick = run();
    assert.strictEqual(intervalTick, freshReload);
    postMutation.resolve('contains sent message');
    assert.equal(await freshReload, 'contains sent message');
    assert.equal(await intervalTick, 'contains sent message');
    assert.equal(peakInFlight, 1);
    assert.equal(starts, 2);
  });

  test('rapid fresh requests coalesce while preserving one read after the newest mutation', async () => {
    const poll = deferred<string>();
    const firstFresh = deferred<string>();
    const newestFresh = deferred<string>();
    const responses = [poll, firstFresh, newestFresh];
    let starts = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const run = createSingleFlightRequest(async () => {
      const response = responses[starts++];
      assert.ok(response, 'unexpected request');
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try { return await response.promise; } finally { inFlight -= 1; }
    });

    const activePoll = run();
    await Promise.resolve();
    const trailing = run(true);
    const rapidDuplicate = run(true);
    assert.strictEqual(rapidDuplicate, trailing, 'rapid taps share the one queued fresh read');
    assert.equal(starts, 1);

    poll.resolve('old');
    await activePoll;
    await Promise.resolve();
    assert.equal(starts, 2);

    // A newer mutation finishes while the queued read is on the wire. It joins
    // the same drain promise but requires one final snapshot afterward.
    const newestMutation = run(true);
    assert.strictEqual(newestMutation, trailing);
    firstFresh.resolve('now stale');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(starts, 3);
    newestFresh.resolve('newest snapshot');

    assert.equal(await trailing, 'newest snapshot');
    assert.equal(await rapidDuplicate, 'newest snapshot');
    assert.equal(await newestMutation, 'newest snapshot');
    assert.equal(peakInFlight, 1);
    assert.equal(starts, 3);
  });

  test('CommsApp wires message loads through the single-flight request', () => {
    const app = readFileSync(join(
      process.cwd(),
      'src/app/communications/_components/CommsApp.tsx',
    ), 'utf8');

    assert.match(app, /threadLoadRef = React\.useRef/);
    assert.match(app, /run: createSingleFlightRequest\(async \(\) =>/);
    assert.match(app, /const requestId = \+\+threadRequestRef\.current/);
    assert.match(app, /loader\.run\(ensureFresh\)/);
    assert.match(app, /onReloadThread=\{\(\) => loadThread\(false, true\)\}/);
  });
});
