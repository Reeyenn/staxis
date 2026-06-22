/**
 * Best-class verification wiring tests (feature/cua-bestclass-verify) for the
 * mapper side: N-sample semantic-entropy abstain on the identify() path, and
 * pass^N replay-consistency. Drives attemptStructuredDiscovery with INJECTED
 * deps — no Playwright, no Anthropic, no network — and flips the CUA_* knobs via
 * process.env per case (the function reads them directly, mirroring
 * CUA_STRUCTURED_DISCOVERY_ENABLED).
 *
 * The pure clustering/entropy math is covered separately in
 * proposal-entropy.test.ts; here we prove the WIRING: the loop draws N times,
 * abstains on disagreement, and the extra replay passes gate a flaky endpoint.
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptStructuredDiscovery,
  type DiscoveryDeps,
  type StructuredDiscoveryInput,
} from '../mapper.js';
import type { CapturedCall } from '../network-capture.js';
import type { ActionRecipe } from '../types.js';

const NOW_MS = new Date(2026, 5, 10, 15, 0, 0).getTime();

// ─── Env knob helper ─────────────────────────────────────────────────────────
const VERIFY_KNOBS = [
  'CUA_DISCOVERY_IDENTIFY_SAMPLES', 'CUA_DISCOVERY_MAX_ENTROPY',
  'CUA_DISCOVERY_MIN_DOMINANCE', 'CUA_VERIFY_REPLAY_PASSES',
];
afterEach(() => { for (const k of VERIFY_KNOBS) delete process.env[k]; });

// ─── Fixtures (mirrors mapper-structured-discovery.test.ts happy path) ────────
function domRows(): Array<Record<string, string>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    pms_reservation_id: `R10${i}7`,
    guest_name: `Guest${i}, Test`,
    arrival_date: '06/10/2026',
    departure_date: '06/11/2026',
    room_number: `${100 + i}`,
  }));
}
function apiRowsRaw(date = '2026-06-10'): Array<Record<string, unknown>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    resvId: `R10${i}7`,
    guest: { name: `Guest${i}, Test` },
    arrivalDate: date,
    departureDate: '2026-06-11',
    room: `${100 + i}`,
  }));
}
function tableSuccess(): { ok: true; action: ActionRecipe; valueSamples?: Record<string, string[]> } {
  return {
    ok: true,
    action: {
      steps: [{ kind: 'goto', url: 'https://pms.example.com/dash' }],
      parse: {
        mode: 'table',
        hint: {
          rowSelector: 'tr.res',
          columns: {
            pms_reservation_id: 'td.id', guest_name: 'td.name',
            arrival_date: 'td.arr', departure_date: 'td.dep', room_number: 'td.room',
          },
        },
      },
    },
    valueSamples: { arrival_date: ['06/10/2026', '06/11/2026'] },
  };
}
function mkCall(over: Partial<CapturedCall> = {}): CapturedCall {
  return {
    url: 'https://pms.example.com/api/arrivals?date=06/10/2026',
    method: 'GET', requestBody: null, requestHeaders: { accept: 'application/json' },
    status: 200, contentType: 'application/json',
    responseBody: { data: { arrivals: apiRowsRaw() } }, ...over,
  };
}
const GOOD = JSON.stringify({
  candidateIndex: 0, jsonPath: 'data.arrivals',
  columns: { pms_reservation_id: 'resvId', guest_name: 'guest.name', arrival_date: 'arrivalDate', departure_date: 'departureDate', room_number: 'room' },
});
// A DIFFERENT meaning: dates swapped.
const SWAPPED = JSON.stringify({
  candidateIndex: 0, jsonPath: 'data.arrivals',
  columns: { pms_reservation_id: 'resvId', guest_name: 'guest.name', arrival_date: 'departureDate', departure_date: 'arrivalDate', room_number: 'room' },
});
// A THIRD distinct meaning: different jsonPath.
const OTHER_PATH = JSON.stringify({
  candidateIndex: 0, jsonPath: 'data',
  columns: { pms_reservation_id: 'resvId', guest_name: 'guest.name', arrival_date: 'arrivalDate', departure_date: 'departureDate', room_number: 'room' },
});

interface DepsLog { identifyCalls: number; identifySamples: number[]; anchorFetches: number; }
function makeDeps(over: Partial<DiscoveryDeps> = {}): { deps: DiscoveryDeps; log: DepsLog } {
  const log: DepsLog = { identifyCalls: 0, identifySamples: [], anchorFetches: 0 };
  const deps: DiscoveryDeps = {
    extractOracleRows: async () => domRows(),
    identify: async (_prompt, sample = 0) => { log.identifyCalls++; log.identifySamples.push(sample); return GOOD; },
    replayFetch: async (req) => {
      if (req.url.includes('06/10/2026')) { log.anchorFetches++; return { ok: true, data: { data: { arrivals: apiRowsRaw() } } }; }
      if (req.url.includes('06/09/2026')) return { ok: true, data: { data: { arrivals: apiRowsRaw('2026-06-09').slice(0, 4) } } };
      return { ok: false, reason: 'HTTP 400' };
    },
    gotoPostLogin: async () => {},
    isOverBudget: async () => false,
    now: () => NOW_MS,
    ...over,
  };
  return { deps, log };
}
function mkInput(over: Partial<StructuredDiscoveryInput> = {}): StructuredDiscoveryInput {
  return {
    actionName: 'getArrivals', success: tableSuccess(), capturedCalls: [mkCall()],
    loginUrl: 'https://pms.example.com/login', feedPageUrl: 'https://pms.example.com/frontdesk/arrivals',
    jobId: 'job-bcv-1', ...over,
  };
}

// ─── N-sample semantic-entropy abstain ───────────────────────────────────────
describe('attemptStructuredDiscovery — N-sample identify (Task 2)', () => {
  test('default (no env) → exactly ONE identify draw, still upgrades (today behaviour)', async () => {
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.ok(result);
    assert.equal(result.action.parse.mode, 'api');
    assert.equal(log.identifyCalls, 1);
  });

  test('N=3 with UNANIMOUS draws → draws 3 times (distinct sample ids) and upgrades', async () => {
    process.env.CUA_DISCOVERY_IDENTIFY_SAMPLES = '3';
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.ok(result, 'unanimous samples should reach consensus and upgrade');
    assert.equal(result.action.parse.mode, 'api');
    assert.equal(log.identifyCalls, 3);
    assert.deepEqual(log.identifySamples, [0, 1, 2], 'each draw gets a distinct sample index for a distinct idempotency key');
  });

  test('N=3 with THREE DISTINCT meanings → ABSTAIN (high semantic entropy), no api emit', async () => {
    process.env.CUA_DISCOVERY_IDENTIFY_SAMPLES = '3';
    const responses = [GOOD, SWAPPED, OTHER_PATH];
    const { deps, log } = makeDeps({
      identify: async (_p, sample = 0) => { log.identifyCalls++; return responses[sample] ?? GOOD; },
    });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.equal(result, null, 'disagreeing samples must abstain to the DOM recipe');
    assert.equal(log.identifyCalls, 3, 'all N draws were taken before abstaining');
  });

  test('N=3 where the plurality is {none} → abstain', async () => {
    process.env.CUA_DISCOVERY_IDENTIFY_SAMPLES = '3';
    const responses = ['{"none":true}', '{"none":true}', GOOD];
    const { deps } = makeDeps({ identify: async (_p, s = 0) => responses[s] ?? GOOD });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.equal(result, null);
  });

  test('N-sampling stops early when the budget is exhausted mid-loop, and ABSTAINS (does not trust a truncated sample set)', async () => {
    process.env.CUA_DISCOVERY_IDENTIFY_SAMPLES = '5';
    let calls = 0;
    const { deps } = makeDeps({
      identify: async () => { calls++; return GOOD; },
      // Over budget only AFTER the first draw — the loop must stop, not keep paying.
      isOverBudget: async () => calls >= 1,
    });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    // Opted into 5 samples but only 1 landed (< majority) → abstain to the safe
    // DOM recipe, and crucially: never paid for the full 5.
    assert.equal(result, null);
    assert.ok(calls < 5, `expected an early stop, drew ${calls}`);
  });
});

// ─── pass^N replay consistency ───────────────────────────────────────────────
describe('attemptStructuredDiscovery — replay pass^N (Task 5)', () => {
  test('default (1 pass) fetches the anchor day once for confirm', async () => {
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.ok(result);
    assert.equal(log.anchorFetches, 1, 'one anchor-day confirm fetch by default');
  });

  test('CUA_VERIFY_REPLAY_PASSES=3 re-fetches the anchor day and still upgrades', async () => {
    process.env.CUA_VERIFY_REPLAY_PASSES = '3';
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.ok(result, 'a stable endpoint passes all replay passes');
    assert.equal(result.action.parse.mode, 'api');
    assert.equal(log.anchorFetches, 3, 'confirm + 2 extra consistency passes');
  });

  test('a flaky endpoint that fails a later replay pass → ABSTAIN', async () => {
    process.env.CUA_VERIFY_REPLAY_PASSES = '3';
    let anchorHits = 0;
    const { deps } = makeDeps({
      replayFetch: async (req) => {
        if (req.url.includes('06/10/2026')) {
          anchorHits++;
          // Pass the confirm + first extra pass, then go stale on the 3rd.
          if (anchorHits >= 3) return { ok: false, reason: 'HTTP 503' };
          return { ok: true, data: { data: { arrivals: apiRowsRaw() } } };
        }
        if (req.url.includes('06/09/2026')) return { ok: true, data: { data: { arrivals: apiRowsRaw('2026-06-09').slice(0, 4) } } };
        return { ok: false, reason: 'HTTP 400' };
      },
    });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.equal(result, null, 'an endpoint that wobbles across passes must abstain');
  });
});
