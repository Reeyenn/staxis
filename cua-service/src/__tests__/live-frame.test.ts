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

  test('ordering: a frame parked in the dead window after a chain settles can never upload after a newer frame', async () => {
    // Senior review F1. Sequence: chain for A fully settles; X arrives in
    // the microtask window where `busy` may still look set (here: simply
    // parked while busy), then Y is accepted later. Y must win — the
    // parked X must never land after Y.
    const clock = makeClock();
    const firstUpload = deferred<void>();
    let uploadCount = 0;
    const { deps, rec } = makeDeps({
      watching: true,
      clock,
      uploadImpl: async () => {
        uploadCount += 1;
        if (uploadCount === 1) await firstUpload.promise;
      },
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));          // chain 1 starts, upload held open
    await settle();
    pub.publish(b64('x'));          // parked in the pending slot
    firstUpload.resolve();
    // Let chain 1 drain x and settle completely… but x uploads as part of
    // chain 1's drain (that's fine — it IS newer than a). The dead-window
    // case: park ANOTHER frame after the drain loop has already read
    // pendingB64 but before .finally clears busy. Simulate the published-
    // while-stale-parked case directly: after full settle, park can't
    // exist; so assert the acceptance path drops any parked frame instead.
    await settle();
    assert.deepEqual(rec.uploads.map((u) => u.png.toString()), [
      'png-bytes-a', 'png-bytes-x',
    ]);
    clock.advance(2_000);
    // Force the F1 shape explicitly: busy is null now; manufacture a stale
    // parked frame by publishing while a NEW chain is mid-gate, then make
    // sure a LATER accepted frame still wins (acceptance clears the park).
    const gate = deferred<number>();
    let gated = false;
    deps.countWatchingAdmins = async () => {
      if (!gated) { gated = true; return gate.promise; }
      return 1;
    };
    pub.publish(b64('y'));          // chain 2 parks in gate
    pub.publish(b64('stale'));      // parked while chain 2 busy
    gate.resolve(1);
    await settle();                 // chain 2 drains: y, then stale (newest-at-park-time)
    clock.advance(2_000);
    pub.publish(b64('z'));          // acceptance MUST drop any lingering park
    await settle();
    const order = rec.uploads.map((u) => u.png.toString());
    // 'stale' may legitimately appear once (it was the newest at park
    // time), but never AFTER z.
    assert.deepEqual(order[order.length - 1], 'png-bytes-z');
    const staleIdx = order.lastIndexOf('png-bytes-stale');
    const zIdx = order.lastIndexOf('png-bytes-z');
    assert.ok(staleIdx < zIdx, `stale frame uploaded after newer frame: ${order.join(',')}`);
  });

  test('watch-cache expires — a publish after the 15s TTL re-queries the gate', async () => {
    const clock = makeClock();
    const { deps, rec } = makeDeps({ watching: true, clock });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));
    await settle();
    clock.advance(16_000); // past the 15s TTL
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.countCalls, 2);
    assert.equal(rec.uploads.length, 2);
  });

  test('unwatched → watched transition: uploads resume after the cached false expires', async () => {
    const clock = makeClock();
    let adminsOnline = 0;
    const { deps, rec } = makeDeps({
      clock,
      countImpl: async () => adminsOnline,
    });
    const pub = createLiveFramePublisher(JOB_ID, deps);
    pub.publish(b64('a'));          // nobody watching — dropped, false cached
    await settle();
    assert.equal(rec.uploads.length, 0);
    adminsOnline = 1;               // admin opens the board
    clock.advance(5_000);           // still inside the cached false
    pub.publish(b64('b'));
    await settle();
    assert.equal(rec.uploads.length, 0, 'cached false must hold inside TTL');
    clock.advance(11_000);          // cache expired (16s total)
    pub.publish(b64('c'));
    await settle();
    assert.equal(rec.uploads.length, 1);
    assert.deepEqual(rec.uploads[0]!.png, Buffer.from('png-bytes-c'));
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
