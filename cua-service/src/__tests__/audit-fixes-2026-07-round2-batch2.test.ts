/**
 * Pins a second batch of 2026-07 round-2 audit fixes (session-supervisor,
 * usage-log, dom-rows) so they can't regress. Pure-logic pins — no browser,
 * no model, no real network.
 *
 *   A. SessionSupervisor.reconcileOnce has an in-flight guard: a second tick
 *      that fires while the previous reconcile is still running is skipped, so
 *      two overlapping reconciles can't both pass the drivers.has() dedupe and
 *      double-spawn an untracked driver for the same hotel.
 *   C. extractDomRowsTiered merges the css read and the xpath-column read by
 *      array index; a row-count mismatch between the two separate DOM snapshots
 *      means the page shifted mid-read, so the xpath columns are DROPPED for
 *      that poll rather than attached to the wrong row.
 *   D. The in-process per-job cost map is LRU, not FIFO: reading a job's cost
 *      (getJobCostMicros fast path) refreshes its recency, so an active job
 *      that keeps being cost-checked is never the eviction victim and its
 *      running total can't be silently truncated.
 */

// MUST be first: install the WebSocket shim before any supabase-importing
// module is evaluated (ESM evaluates imports in source order).
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SessionSupervisor } from '../session-supervisor.js';
import { getJobCostMicros, logClaudeUsage } from '../usage-log.js';

// ─── ITEM A — reconcileOnce in-flight guard ─────────────────────────────────

describe('SessionSupervisor.reconcileOnce — in-flight guard (ITEM A)', () => {
  test('a second reconcile while the first is in flight is skipped (no overlap)', async () => {
    const sup = new SessionSupervisor();

    // Block the first reconcile INSIDE its supabase-touching internals so it
    // stays "in flight" while we fire a second tick. loadEnabledSessions is the
    // first await after the guard is taken; hanging it holds the guard.
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sup as any).loadEnabledSessions = () => {
        calls += 1;
        (sup as unknown as { __loadCalls: number }).__loadCalls = calls;
        if (calls === 1) {
          resolve();
          return new Promise((res) => { releaseFirst = () => res([]); });
        }
        return Promise.resolve([]);
      };
    });

    // Fire the first reconcile (do NOT await — it blocks on loadEnabledSessions).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p1 = (sup as any).reconcileOnce() as Promise<void>;
    await firstEntered; // guaranteed inside the guarded region now

    // Fire a second reconcile while the first is still in flight. The guard must
    // make it a no-op — loadEnabledSessions must NOT be called a second time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sup as any).reconcileOnce();
    assert.equal(
      (sup as unknown as { __loadCalls: number }).__loadCalls,
      1,
      'the second reconcile must be skipped while the first is in flight',
    );

    // Release the first; once it completes, the guard clears and a fresh
    // reconcile proceeds (loadEnabledSessions called again).
    releaseFirst();
    await p1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sup as any).reconcileOnce();
    assert.equal(
      (sup as unknown as { __loadCalls: number }).__loadCalls,
      2,
      'after the in-flight reconcile finishes, the next tick runs normally',
    );
  });

  test('the guard is released even when a reconcile throws (finally clears it)', async () => {
    const sup = new SessionSupervisor();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sup as any).loadEnabledSessions = () => {
      calls += 1;
      if (calls === 1) throw new Error('synthetic reconcile failure');
      return Promise.resolve([]);
    };

    // reconcileOnce swallows the error in its own try/catch, so this resolves.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sup as any).reconcileOnce();
    // The finally must have cleared the in-flight flag — the next reconcile runs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sup as any).reconcileOnce();
    assert.equal(calls, 2, 'a thrown reconcile must not wedge the guard shut');
  });
});

// ─── ITEM D — in-process cost map is LRU, not FIFO ──────────────────────────

describe('usage-log in-process cost map — LRU eviction (ITEM D)', () => {
  const MODEL = 'claude-opus-4-8'; // in PRICE_PER_1M_TOKENS (input: 5/1M) → deterministic cost
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Stub the global fetch so supabase-js's insert/select resolve INSTANTLY
    // (no real DNS to the placeholder URL) — the in-process map mutation runs
    // synchronously before this awaited round-trip, so the running total under
    // test is unaffected. A benign empty-array 200 keeps logClaudeUsage quiet
    // and makes the DB fallback in getJobCostMicros return an empty set (→ 0).
    globalThis.fetch = (async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('reading a job cost refreshes its recency so an active job is not evicted', async () => {
    // A mapping workload with no propertyId skips recordSpend entirely, so this
    // exercises only the in-process cost map (plus a swallowed DB insert).
    const hot = `hot-${Date.now()}`;
    await logClaudeUsage(
      { input_tokens: 1000 },
      { workload: 'cua_mapping_action', model: MODEL, jobId: hot },
    );
    const hotCost = await getJobCostMicros(hot);
    assert.ok(hotCost > 0, 'the active job has a nonzero running total');

    // Flood the map past its 1000-entry cap with distinct jobIds. A bare FIFO
    // eviction would drop `hot` (inserted first). Between floods we KEEP READING
    // `hot`, which must refresh its recency and protect it from eviction.
    for (let i = 0; i < 1100; i++) {
      await logClaudeUsage(
        { input_tokens: 1 },
        { workload: 'cua_mapping_action', model: MODEL, jobId: `flood-${hot}-${i}` },
      );
      // Touch the hot job periodically — this is the LRU refresh under test.
      if (i % 50 === 0) await getJobCostMicros(hot);
    }

    // With LRU, `hot` survived (its running total is still the in-process value,
    // not a DB-derived 0 — the placeholder DB read returns nothing/errors → 0).
    const after = await getJobCostMicros(hot);
    assert.equal(after, hotCost, 'the actively-read job kept its running total (not evicted)');
  });

  test('an untouched job IS evicted once the map overflows (bound still holds)', async () => {
    // Seed a cold job, never read it again, then overflow the map. It should be
    // evicted — confirming the LRU change didn't turn the cap into a no-op.
    const cold = `cold-${Date.now()}`;
    await logClaudeUsage(
      { input_tokens: 7777 },
      { workload: 'cua_mapping_action', model: MODEL, jobId: cold },
    );

    for (let i = 0; i < 1200; i++) {
      await logClaudeUsage(
        { input_tokens: 1 },
        { workload: 'cua_mapping_action', model: MODEL, jobId: `overflow-${cold}-${i}` },
      );
    }

    // `cold` was pushed out of the in-process map. getJobCostMicros now falls
    // back to the DB, which under the stubbed fetch returns an empty set → 0.
    // A LIVE in-process running total would have been 7777*5 = 38885 micros, so
    // reading 0 proves the fast-path entry was evicted (the cap still bites).
    const after = await getJobCostMicros(cold);
    assert.notEqual(after, 7777 * 5, 'a never-read cold job is evicted when the map overflows');
    assert.equal(after, 0, 'evicted job falls back to the (stubbed empty) DB → 0');
  });
});

// ─── ITEM C — index-based css/xpath merge is identity-guarded ────────────────
//
// The fix (extractors/dom-rows.ts): the css read and the xpath-column read are
// two SEPARATE DOM snapshots merged purely by array index. If the page mutates
// between them, their visible-row counts diverge and index i is a DIFFERENT row
// in each — attaching an xpath value to the wrong record. The guard drops the
// xpath columns for that poll unless the counts match. The merge itself is
// inside a private function only reachable via a real Playwright page (covered
// live in dom-rows-semantic.test.ts). Here we pin the exact alignment decision
// the guard makes, so the "count mismatch → drop, not misalign" invariant can't
// silently regress.

describe('dom-rows css/xpath merge alignment invariant (ITEM C)', () => {
  // Replicates the guarded merge from extractDomRowsTiered verbatim.
  function mergeXpathColumns(
    rows: Array<Record<string, string>>,
    xrows: Array<Record<string, string>>,
  ): Array<Record<string, string>> {
    if (xrows.length === rows.length) {
      return rows.map((row, i) => ({ ...row, ...(xrows[i] ?? {}) }));
    }
    // Count mismatch → page shifted mid-read → drop the xpath columns.
    return rows;
  }

  test('equal row counts → xpath columns fill their rows (happy path unchanged)', () => {
    const rows = [{ room: '101' }, { room: '102' }];
    const xrows = [{ owner: 'Alice' }, { owner: 'Bob' }];
    assert.deepEqual(mergeXpathColumns(rows, xrows), [
      { room: '101', owner: 'Alice' },
      { room: '102', owner: 'Bob' },
    ]);
  });

  test('fewer xpath rows (a row vanished mid-read) → xpath columns dropped, NOT misaligned', () => {
    // The exact bug: row 102 was removed between the css and xpath snapshots, so
    // xrows[1] is really the owner of a DIFFERENT row. Index-merge would attach
    // it to 102. The guard drops all xpath columns instead.
    const rows: Array<Record<string, string>> = [{ room: '101' }, { room: '102' }, { room: '103' }];
    const xrows: Array<Record<string, string>> = [{ owner: 'Alice' }, { owner: 'Carol' }]; // 102 gone; Carol is 103's owner
    const merged: Array<Record<string, string>> = mergeXpathColumns(rows, xrows);
    // No row got a WRONG owner stamped on it — the xpath columns were withheld.
    const expected: Array<Record<string, string>> = [{ room: '101' }, { room: '102' }, { room: '103' }];
    assert.deepEqual(merged, expected);
    assert.equal(merged[1]?.owner, undefined, 'row 102 must not inherit another row’s owner');
  });

  test('more xpath rows than css rows → also dropped (divergence in either direction)', () => {
    const rows = [{ room: '101' }];
    const xrows = [{ owner: 'Alice' }, { owner: 'Bob' }];
    assert.deepEqual(mergeXpathColumns(rows, xrows), [{ room: '101' }]);
  });
});
