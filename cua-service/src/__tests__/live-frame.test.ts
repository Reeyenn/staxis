/**
 * Tests for cua-service/src/live-frame.ts — the Learning Board live-view
 * publisher. Pins the invariants that make the tee safe to wire into the
 * mapper loop:
 *
 *   - Watch gate: no admin heartbeat (or a failing gate query) ⇒ NO upload,
 *     no notify — zero cost when nobody's looking. Gate result cached.
 *   - Single-object semantics: every upload targets `${jobId}/live.png`.
 *   - Busy flag spans the WHOLE pipeline (gate query included): a frame
 *     arriving mid-gate goes to the 1-deep pending slot — never a second
 *     concurrent pipeline, never an out-of-order overwrite.
 *   - Pending slot is latest-wins: a burst while busy ⇒ exactly 2 uploads,
 *     the newest frame lands last.
 *   - Min-interval + failure backoff drop frames quietly.
 *   - close() awaits in-flight work, removes the object, and permanently
 *     drops later publishes (including a parked pending frame).
 *   - publish() NEVER throws, even when deps throw synchronously.
 *
 * All I/O is injected via the optional `deps` parameter (same convention
 * as critic.test.ts) — no real Supabase call ever fires from these tests.
 */

import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFramePublisher, type LiveFrameDeps } from '../live-frame.js';

const JOB_ID = '11111111-2222-3333-4444-555555555555';

function b64(label: string): string {
  return Buffer.from(`png-bytes-${label}`).toString('base64');
}

/** Let the detached pipeline chain run to quiescence. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Recorder {
  countCalls: number;
  uploads: Array<{ key: string; png: Buffer }>;
  removes: string[];
  notifies: number;
}

function makeDeps(opts: {
  watching?: boolean;
  clock?: ReturnType<typeof makeClock>;
  countImpl?: (cutoffIso: string) => Promise<number>;
  uploadImpl?: (key: string, png: Buffer) => Promise<void>;
  notifyImpl?: () => void;
} = {}): { deps: LiveFrameDeps; rec: Recorder } {
  const rec: Recorder = { countCalls: 0, uploads: [], removes: [], notifies: 0 };
  const deps: LiveFrameDeps = {
    countWatchingAdmins: async (cutoffIso) => {
      rec.countCalls += 1;
      if (opts.countImpl) return opts.countImpl(cutoffIso);
      return (opts.watching ?? true) ? 1 : 0;
    },
    upload: async (key, png) => {
      if (opts.uploadImpl) await opts.uploadImpl(key, png);
      rec.uploads.push({ key, png });
    },
    remove: async (key) => {
      rec.removes.push(key);
    },
    notify: () => {
      rec.notifies += 1;
      if (opts.notifyImpl) opts.notifyImpl();
    },
    now: opts.clock?.now,
  };
  return { deps, rec };
}

describe('live-frame publisher', () => {
  test('no admin watching — frame dropped before any upload or notify', async () => {
    const { deps, rec } = makeDeps({ watching: false });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    assert.equal(rec.countCalls, 1);
    assert.equal(rec.uploads.length, 0);
    assert.equal(rec.notifies, 0);
  });

  test('gate query rejects — fail closed, no upload, publish resolves quietly', async () => {
    const { deps, rec } = makeDeps({
      countImpl: async () => { throw new Error('db down'); },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    assert.equal(rec.uploads.length, 0);
    assert.equal(rec.notifies, 0);
  });

  test('admin watching — uploads exactly to `${jobId}/live.png`, then notifies', async () => {
    const { deps, rec } = makeDeps({ watching: true });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    assert.equal(rec.uploads.length, 1);
    assert.equal(rec.uploads[0]!.key, `${JOB_ID}/live.png`);
    assert.deepEqual(rec.uploads[0]!.png, Buffer.from(`png-bytes-a`));
    assert.equal(rec.notifies, 1);
  });

  test('cutoff passed to the gate is ~2 minutes before now', async () => {
    const clock = makeClock(10_000_000);
    let seenCutoff = '';
    const { deps } = makeDeps({
      clock,
      countImpl: async (cutoffIso) => { seenCutoff = cutoffIso; return 1; },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    assert.equal(seenCutoff, new Date(10_000_000 - 2 * 60_000).toISOString());
  });

  test('watch-gate result is cached — two spaced publishes, one count query', async () => {
    const clock = makeClock();
    const { deps, rec } = makeDeps({ watching: true, clock });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    clock.advance(2_000); // > min interval, < 15s cache TTL
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.uploads.length, 2);
    assert.equal(rec.countCalls, 1);
  });

  test('negative gate result is cached too (no per-frame queries while unwatched)', async () => {
    const clock = makeClock();
    const { deps, rec } = makeDeps({ watching: false, clock });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    clock.advance(2_000);
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.countCalls, 1);
    assert.equal(rec.uploads.length, 0);
  });

  test('busy flag spans the gate query — frame arriving mid-gate goes to pending, never a concurrent pipeline', async () => {
    const clock = makeClock();
    const gate = deferred<number>();
    let inFlightGates = 0;
    let maxInFlightGates = 0;
    const { deps, rec } = makeDeps({
      clock,
      countImpl: async () => {
        inFlightGates += 1;
        maxInFlightGates = Math.max(maxInFlightGates, inFlightGates);
        const n = await gate.promise;
        inFlightGates -= 1;
        return n;
      },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));          // parks in the gate query
    clock.advance(5_000);           // well past min-interval
    pub.publish(b64('b'));          // must go to pending, not start a 2nd gate
    gate.resolve(1);
    await settle();
    assert.equal(maxInFlightGates, 1);
    assert.equal(rec.uploads.length, 2); // a, then the pending b (cache hit)
    assert.equal(rec.countCalls, 1);
    assert.deepEqual(rec.uploads[1]!.png, Buffer.from('png-bytes-b'));
  });

  test('pending slot is latest-wins — burst of 3 while busy ⇒ 2 uploads, newest last', async () => {
    const firstUpload = deferred<void>();
    let uploadCount = 0;
    const { deps, rec } = makeDeps({
      watching: true,
      uploadImpl: async () => {
        uploadCount += 1;
        if (uploadCount === 1) await firstUpload.promise;
      },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();                 // a reaches the held-open upload
    pub.publish(b64('b'));          // pending
    pub.publish(b64('c'));          // replaces b
    firstUpload.resolve();
    await settle();
    assert.equal(rec.uploads.length, 2);
    assert.deepEqual(rec.uploads[0]!.png, Buffer.from('png-bytes-a'));
    assert.deepEqual(rec.uploads[1]!.png, Buffer.from('png-bytes-c'));
  });

  test('min-interval — a second settled publish inside 1200ms is dropped', async () => {
    const clock = makeClock();
    const { deps, rec } = makeDeps({ watching: true, clock });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    clock.advance(500); // < 1200ms floor
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.uploads.length, 1);
  });

  test('storage failure — quiet, backs off, recovers after the backoff window', async () => {
    const clock = makeClock();
    let failFirst = true;
    const { deps, rec } = makeDeps({
      watching: true,
      clock,
      uploadImpl: async () => {
        if (failFirst) { failFirst = false; throw new Error('storage 500'); }
      },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));          // fails → 15s backoff
    await settle();
    assert.equal(rec.uploads.length, 0);
    assert.equal(rec.notifies, 0);
    clock.advance(5_000);           // still inside backoff
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.uploads.length, 0);
    clock.advance(11_000);          // past backoff (16s total)
    pub.publish(b64('c'));
    await settle();
    assert.equal(rec.uploads.length, 1);
    assert.deepEqual(rec.uploads[0]!.png, Buffer.from('png-bytes-c'));
    assert.equal(rec.notifies, 1);
  });

  test('close() awaits the in-flight upload, removes the object, and drops the pending frame', async () => {
    const firstUpload = deferred<void>();
    let uploadCount = 0;
    const { deps, rec } = makeDeps({
      watching: true,
      uploadImpl: async () => {
        uploadCount += 1;
        if (uploadCount === 1) await firstUpload.promise;
      },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();                 // a held mid-upload
    pub.publish(b64('b'));          // pending — must NOT flush after close
    const closing = pub.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await settle();
    assert.equal(closed, false);    // close is waiting on the in-flight upload
    firstUpload.resolve();
    await closing;
    assert.equal(rec.uploads.length, 1);            // only a — b dropped
    assert.deepEqual(rec.removes, [`${JOB_ID}/live.png`]);
    pub.publish(b64('c'));          // post-close publish drops
    await settle();
    assert.equal(rec.uploads.length, 1);
  });

  test('close() is safe when idle and publish after close never uploads', async () => {
    const { deps, rec } = makeDeps({ watching: true });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    await pub.close();
    assert.deepEqual(rec.removes, [`${JOB_ID}/live.png`]);
    pub.publish(b64('a'));
    await settle();
    assert.equal(rec.uploads.length, 0);
    assert.equal(rec.countCalls, 0);
  });

  test('publish never throws — synchronously-throwing clock is swallowed', async () => {
    const { deps } = makeDeps({ watching: true });
    deps.now = () => { throw new Error('clock broke'); };
    const pub = createLiveFramePublisher(JOB_ID, deps);
    assert.doesNotThrow(() => pub.publish(b64('a')));
    await settle();
  });

  test('a throwing notify does not break the pipeline or later frames', async () => {
    const clock = makeClock();
    const { deps, rec } = makeDeps({
      watching: true,
      clock,
      notifyImpl: () => { throw new Error('broadcast down'); },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    clock.advance(2_000);
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.uploads.length, 2); // both frames landed despite notify throwing
  });
});
