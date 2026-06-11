/**
 * Structured-discovery pipeline tests (feat/cua-mapper-discovery).
 *
 * Drives mapper.ts's attemptStructuredDiscovery with INJECTED deps — no
 * Playwright, no Anthropic API, no network. Each test either proves the happy
 * path emits exactly the right ApiHint, or proves a failure path falls back to
 * the DOM recipe (returns null) — and, where it matters, that the LLM was
 * never called (cost) and the abstain happened for the right reason.
 */

// MUST be first: WebSocket shim + env placeholders before mapper.ts's import
// graph (supabase/env/anthropic all construct at module load).
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptStructuredDiscovery,
  type DiscoveryDeps,
  type StructuredDiscoveryInput,
} from '../mapper.js';
import type { CapturedCall } from '../network-capture.js';
import type { ActionRecipe } from '../types.js';

// Fixture wall-clock: 3pm LOCAL on 2026-06-10 (local-time constructor makes
// the local calendar date deterministic regardless of the machine's TZ).
const NOW_MS = new Date(2026, 5, 10, 15, 0, 0).getTime();
const ANCHOR = '2026-06-10';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

function tableSuccess(): { ok: true; action: ActionRecipe; valueSamples?: Record<string, string[]>; enumMappings?: Record<string, Record<string, string>>; viaBail?: boolean } {
  return {
    ok: true,
    action: {
      steps: [{ kind: 'goto', url: 'https://pms.example.com/dash' }],
      parse: {
        mode: 'table',
        hint: {
          rowSelector: 'tr.res',
          columns: {
            pms_reservation_id: 'td.id',
            guest_name: 'td.name',
            arrival_date: 'td.arr',
            departure_date: 'td.dep',
            room_number: 'td.room',
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
    method: 'GET',
    requestBody: null,
    requestHeaders: { accept: 'application/json' },
    status: 200,
    contentType: 'application/json',
    responseBody: { data: { arrivals: apiRowsRaw() } },
    ...over,
  };
}

const GOOD_PROPOSAL = JSON.stringify({
  candidateIndex: 0,
  jsonPath: 'data.arrivals',
  columns: {
    pms_reservation_id: 'resvId',
    guest_name: 'guest.name',
    arrival_date: 'arrivalDate',
    departure_date: 'departureDate',
    room_number: 'room',
  },
});

interface DepsLog {
  identifyCalls: number;
  fetches: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }>;
  navigated: number;
}

/** Deps whose replay/probe serve a consistent fake server:
 *  - request rendered at the anchor date → today's 6 rows;
 *  - request rendered at anchor−1 → yesterday-dated rows (probe pass). */
function makeDeps(over: Partial<DiscoveryDeps> = {}): { deps: DiscoveryDeps; log: DepsLog } {
  const log: DepsLog = { identifyCalls: 0, fetches: [], navigated: 0 };
  const deps: DiscoveryDeps = {
    extractOracleRows: async () => domRows(),
    identify: async () => {
      log.identifyCalls++;
      return GOOD_PROPOSAL;
    },
    replayFetch: async (req) => {
      log.fetches.push(req);
      if (req.url.includes('06/10/2026')) {
        return { ok: true, data: { data: { arrivals: apiRowsRaw() } } };
      }
      if (req.url.includes('06/09/2026')) {
        return { ok: true, data: { data: { arrivals: apiRowsRaw('2026-06-09').slice(0, 4) } } };
      }
      return { ok: false, reason: 'HTTP 400' };
    },
    gotoPostLogin: async () => { log.navigated++; },
    isOverBudget: async () => false,
    now: () => NOW_MS,
    ...over,
  };
  return { deps, log };
}

function mkInput(over: Partial<StructuredDiscoveryInput> = {}): StructuredDiscoveryInput {
  return {
    actionName: 'getArrivals',
    success: tableSuccess(),
    capturedCalls: [mkCall()],
    loginUrl: 'https://pms.example.com/login',
    feedPageUrl: 'https://pms.example.com/frontdesk/arrivals',
    jobId: 'job-test-1',
    ...over,
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('attemptStructuredDiscovery — verified upgrade', () => {
  test('full pipeline emits a templated, sanitized api hint', async () => {
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.ok(result, 'expected an upgraded success');
    assert.equal(result.action.parse.mode, 'api');
    const hint = result.action.parse.mode === 'api' ? result.action.parse.hint : null;
    assert.ok(hint);
    assert.equal(hint.url, 'https://pms.example.com/api/arrivals?date={today:MM/DD/YYYY}');
    assert.equal(hint.method, 'GET');
    assert.equal(hint.jsonPath, 'data.arrivals');
    assert.deepEqual(hint.columns, {
      pms_reservation_id: 'resvId',
      guest_name: 'guest.name',
      arrival_date: 'arrivalDate',
      departure_date: 'departureDate',
      room_number: 'room',
    });
    assert.deepEqual(hint.headers, { accept: 'application/json' });
    // Exactly ONE LLM call; replay-confirm + probe both ran from postLoginUrl.
    assert.equal(log.identifyCalls, 1);
    assert.equal(log.navigated, 1);
    assert.equal(log.fetches.length, 2);
    assert.ok(log.fetches[0]!.url.includes('06/10/2026'), 'replay rendered at the anchor');
    assert.ok(log.fetches[1]!.url.includes('06/09/2026'), 'probe rendered at anchor−1');
    // DOM steps + valueSamples are preserved untouched.
    assert.deepEqual(result.action.steps, tableSuccess().action.steps);
    assert.deepEqual(result.valueSamples, tableSuccess().valueSamples);
  });

  test('AMBIGUOUS M/D order (06/06) is settled by the probe — a DMY server gets the DD/MM template', async () => {
    // Learn day 2026-06-06: "06/06/2026" matches the anchor as BOTH MM/DD and
    // DD/MM. The probe renders yesterday in each order; the (DMY) server
    // returns wrong-day rows for the MM/DD render and yesterday rows for the
    // DD/MM render — so DD/MM wins. Without this, ~40% of calendar days could
    // lock in a coin-flip order that silently flips month/day later.
    const nowMs = new Date(2026, 5, 6, 15, 0, 0).getTime();
    const dom = [1, 2, 3, 4, 5, 6].map((i) => ({
      pms_reservation_id: `R10${i}7`,
      guest_name: `Guest${i}, Test`,
      arrival_date: '06/06/2026',
      departure_date: '07/06/2026', // DD/MM: July 6th? No — 7 June (DMY PMS)
      room_number: `${100 + i}`,
    }));
    const apiAt = (iso: string): Array<Record<string, unknown>> =>
      [1, 2, 3, 4, 5, 6].map((i) => ({
        resvId: `R10${i}7`,
        guest: { name: `Guest${i}, Test` },
        arrivalDate: iso,
        departureDate: '2026-06-07',
        room: `${100 + i}`,
      }));
    const success = tableSuccess();
    success.valueSamples = { arrival_date: ['06/06/2026'] };
    const { deps } = makeDeps({
      now: () => nowMs,
      extractOracleRows: async () => dom,
      replayFetch: async (req) => {
        if (req.url.includes('06/06/2026')) return { ok: true, data: { data: { arrivals: apiAt('2026-06-06') } } };
        if (req.url.includes('06/05/2026')) return { ok: true, data: { data: { arrivals: apiAt('2026-05-06') } } }; // DMY server read "6 May"
        if (req.url.includes('05/06/2026')) return { ok: true, data: { data: { arrivals: apiAt('2026-06-05') } } }; // 5 June — correct yesterday
        return { ok: false, reason: 'HTTP 400' };
      },
    });
    const call = mkCall({
      url: 'https://pms.example.com/api/arrivals?date=06/06/2026',
      responseBody: { data: { arrivals: apiAt('2026-06-06') } },
    });
    const result = await attemptStructuredDiscovery(mkInput({ success, capturedCalls: [call] }), deps);
    assert.ok(result, 'expected the alternate order to win');
    const hint = result.action.parse.mode === 'api' ? result.action.parse.hint : null;
    assert.equal(hint?.url, 'https://pms.example.com/api/arrivals?date={today:DD/MM/YYYY}');
  });

  test('a column that passes on the captured body but FAILS on live replay is dropped from the hint', async () => {
    const { deps } = makeDeps({
      replayFetch: async (req) => {
        if (req.url.includes('06/10/2026')) {
          // Live replay: rooms differ from what the captured body showed.
          return { ok: true, data: { data: { arrivals: apiRowsRaw().map((r) => ({ ...r, room: '999' })) } } };
        }
        if (req.url.includes('06/09/2026')) {
          return { ok: true, data: { data: { arrivals: apiRowsRaw('2026-06-09').slice(0, 4).map((r) => ({ ...r, room: '999' })) } } };
        }
        return { ok: false, reason: 'HTTP 400' };
      },
    });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.ok(result, 'optional replay casualty must not kill the upgrade');
    const hint = result.action.parse.mode === 'api' ? result.action.parse.hint : null;
    assert.ok(hint);
    assert.equal(hint.columns.room_number, undefined, 'replay-failed optional column must be dropped');
    assert.ok(hint.columns.pms_reservation_id, 'verified columns stay');
  });

  test('no-date-param endpoint skips the probe (server-side business date class)', async () => {
    const call = mkCall({ url: 'https://pms.example.com/api/arrivals/today' });
    const fetched: string[] = [];
    const { deps } = makeDeps({
      replayFetch: async (req) => {
        fetched.push(req.url);
        return { ok: true, data: { data: { arrivals: apiRowsRaw() } } };
      },
    });
    const result = await attemptStructuredDiscovery(mkInput({ capturedCalls: [call] }), deps);
    assert.ok(result);
    assert.equal(result.action.parse.mode, 'api');
    assert.deepEqual(fetched, ['https://pms.example.com/api/arrivals/today'], 'replay-confirm only — no probe');
  });
});

// ─── Fail-safe paths: every one falls back to the DOM recipe ─────────────────

describe('attemptStructuredDiscovery — abstains to DOM', () => {
  test('empty capture → null with ZERO LLM calls (stub-capture world)', async () => {
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput({ capturedCalls: [] }), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
    assert.equal(log.fetches.length, 0);
  });

  test('no plausible candidate (cross-host only) → null with ZERO LLM calls', async () => {
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(
      mkInput({ capturedCalls: [mkCall({ url: 'https://cdn.thirdparty.com/data.json' })] }),
      deps,
    );
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('viaBail success (page may have wandered) → null before any work', async () => {
    const { deps, log } = makeDeps();
    const success = { ...tableSuccess(), viaBail: true as const };
    const result = await attemptStructuredDiscovery(mkInput({ success }), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('non-core target → null', async () => {
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput({ actionName: 'getGuestBalances' }), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('kill switch CUA_STRUCTURED_DISCOVERY_ENABLED=false → null', async () => {
    const prev = process.env.CUA_STRUCTURED_DISCOVERY_ENABLED;
    process.env.CUA_STRUCTURED_DISCOVERY_ENABLED = 'false';
    try {
      const { deps, log } = makeDeps();
      const result = await attemptStructuredDiscovery(mkInput(), deps);
      assert.equal(result, null);
      assert.equal(log.identifyCalls, 0);
    } finally {
      if (prev === undefined) delete process.env.CUA_STRUCTURED_DISCOVERY_ENABLED;
      else process.env.CUA_STRUCTURED_DISCOVERY_ENABLED = prev;
    }
  });

  test('aborted signal → null', async () => {
    const { deps, log } = makeDeps();
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await attemptStructuredDiscovery(mkInput({ signal: ctrl.signal }), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('job over budget → null before the LLM call', async () => {
    const { deps, log } = makeDeps({ isOverBudget: async () => true });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('oracle scrape empty (page wandered / selector dead) → null', async () => {
    const { deps, log } = makeDeps({ extractOracleRows: async () => [] });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('oracle does not contain the model\'s observed samples (wrong table) → null', async () => {
    const success = tableSuccess();
    success.valueSamples = { arrival_date: ['12/25/2031', '12/26/2031'] };
    const { deps, log } = makeDeps();
    const result = await attemptStructuredDiscovery(mkInput({ success }), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('DOM shows a NON-today date (agent left a tomorrow filter) → null', async () => {
    const rows = domRows().map((r) => ({ ...r, arrival_date: '06/12/2026' }));
    const { deps, log } = makeDeps({ extractOracleRows: async () => rows });
    const result = await attemptStructuredDiscovery(mkInput(), deps);
    assert.equal(result, null);
    assert.equal(log.identifyCalls, 0);
  });

  test('LLM says none → null', async () => {
    const { deps } = makeDeps({ identify: async () => '{"none":true}' });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('LLM returns prose with no JSON → null', async () => {
    const { deps } = makeDeps({ identify: async () => 'I am not sure which one matches.' });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('LLM call throws → null (never propagates)', async () => {
    const { deps } = makeDeps({ identify: async () => { throw new Error('api down'); } });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('LLM proposes a WRONG mapping → mechanical reconcile rejects → null', async () => {
    const { deps } = makeDeps({
      identify: async () => JSON.stringify({
        candidateIndex: 0,
        jsonPath: 'data.arrivals',
        columns: {
          pms_reservation_id: 'resvId',
          guest_name: 'guest.name',
          arrival_date: 'departureDate', // swapped — plausible but wrong
          departure_date: 'arrivalDate',
          room_number: 'room',
        },
      }),
    });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('LLM omits a required column → null', async () => {
    const { deps } = makeDeps({
      identify: async () => JSON.stringify({
        candidateIndex: 0,
        jsonPath: 'data.arrivals',
        columns: { pms_reservation_id: 'resvId', guest_name: 'guest.name', arrival_date: 'arrivalDate', room_number: 'room' },
      }),
    });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('CSRF header on the winning candidate → null', async () => {
    const call = mkCall({ requestHeaders: { accept: 'application/json', 'x-csrf-token': 'tok' } });
    const { deps } = makeDeps();
    assert.equal(await attemptStructuredDiscovery(mkInput({ capturedCalls: [call] }), deps), null);
  });

  test('ENVELOPE DECOY: body holds both the verified array and a top-level rows[] → null', async () => {
    // Until the runtime resolves jsonPath exclusively, it would ingest the
    // never-verified top-level array — refuse to emit.
    const call = mkCall({
      responseBody: { data: { arrivals: apiRowsRaw() }, rows: [{ unrelated: true }] },
    });
    const { deps } = makeDeps();
    assert.equal(await attemptStructuredDiscovery(mkInput({ capturedCalls: [call] }), deps), null);
  });

  test('request carries a NON-today date → null (stale-date guard)', async () => {
    const call = mkCall({ url: 'https://pms.example.com/api/arrivals?start=06/10/2026&end=06/17/2026' });
    const { deps } = makeDeps();
    assert.equal(await attemptStructuredDiscovery(mkInput({ capturedCalls: [call] }), deps), null);
  });

  test('replay-confirm fails (endpoint broke without its cookies/CSRF) → null', async () => {
    const { deps } = makeDeps({ replayFetch: async () => ({ ok: false, reason: 'HTTP 403' }) });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('PROBE: server ignores the date param (returns today rows for yesterday) → null', async () => {
    const { deps } = makeDeps({
      replayFetch: async (req) => {
        // Server always answers with TODAY's rows no matter the date param.
        void req;
        return { ok: true, data: { data: { arrivals: apiRowsRaw() } } };
      },
    });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('PROBE: mixed-day rows for the yesterday render → null', async () => {
    const { deps } = makeDeps({
      replayFetch: async (req) => {
        if (req.url.includes('06/10/2026')) return { ok: true, data: { data: { arrivals: apiRowsRaw() } } };
        const mixed = [...apiRowsRaw('2026-06-09').slice(0, 3), ...apiRowsRaw('2026-06-08').slice(3)];
        return { ok: true, data: { data: { arrivals: mixed } } };
      },
    });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('navigation to the replay context fails → null', async () => {
    const { deps } = makeDeps({ gotoPostLogin: async () => { throw new Error('nav blocked'); } });
    assert.equal(await attemptStructuredDiscovery(mkInput(), deps), null);
  });

  test('AMBIGUOUS order + EMPTY probe responses → null (an empty set proves neither order)', async () => {
    const nowMs = new Date(2026, 5, 6, 15, 0, 0).getTime();
    const dom = [1, 2, 3, 4, 5, 6].map((i) => ({
      pms_reservation_id: `R10${i}7`,
      guest_name: `Guest${i}, Test`,
      arrival_date: '06/06/2026',
      departure_date: '07/06/2026',
      room_number: `${100 + i}`,
    }));
    const apiToday = [1, 2, 3, 4, 5, 6].map((i) => ({
      resvId: `R10${i}7`,
      guest: { name: `Guest${i}, Test` },
      arrivalDate: '2026-06-06',
      departureDate: '2026-06-07',
      room: `${100 + i}`,
    }));
    const success = tableSuccess();
    success.valueSamples = { arrival_date: ['06/06/2026'] };
    const { deps } = makeDeps({
      now: () => nowMs,
      extractOracleRows: async () => dom,
      replayFetch: async (req) => {
        if (req.url.includes('06/06/2026')) return { ok: true, data: { data: { arrivals: apiToday } } };
        return { ok: true, data: { data: { arrivals: [] } } }; // empty for BOTH yesterday renders
      },
    });
    const call = mkCall({
      url: 'https://pms.example.com/api/arrivals?date=06/06/2026',
      responseBody: { data: { arrivals: apiToday } },
    });
    assert.equal(await attemptStructuredDiscovery(mkInput({ success, capturedCalls: [call] }), deps), null);
  });

  test('date param on a target with NO semantic date column (room status) → null (untestable)', async () => {
    // The probe can't prove which day a room-status response describes, so a
    // templated date param is unverifiable → abstain. Only no-date-param
    // endpoints qualify for these targets.
    const rsDom = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
      room_number: `${100 + i}`,
      status: i <= 4 ? 'OCC' : 'VAC',
    }));
    const rsRaw = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
      roomNo: `${100 + i}`,
      st: i <= 4 ? 'OCC' : 'VAC',
    }));
    const success = tableSuccess();
    success.action.parse = {
      mode: 'table',
      hint: { rowSelector: 'tr.room', columns: { room_number: 'td.no', status: 'td.st' } },
    };
    delete success.valueSamples;
    success.enumMappings = { status: { OCC: 'occupied', VAC: 'vacant' } };
    const call = mkCall({
      url: 'https://pms.example.com/api/rooms?date=06/10/2026',
      responseBody: { rooms: rsRaw },
    });
    const { deps } = makeDeps({
      extractOracleRows: async () => rsDom,
      identify: async () => JSON.stringify({
        candidateIndex: 0,
        jsonPath: 'rooms',
        columns: { room_number: 'roomNo', status: 'st' },
      }),
    });
    const result = await attemptStructuredDiscovery(
      mkInput({ actionName: 'getRoomStatus', success, capturedCalls: [call] }),
      deps,
    );
    assert.equal(result, null);
  });
});
