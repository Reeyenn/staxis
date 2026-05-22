/**
 * Tests for the predict-side wrappers (Phase E2E, 2026-05-22).
 *
 * Mirror the structure of ml-invoke.test.ts: fake fetch, env-restore between
 * tests, re-import the module on each test so it picks up the env.
 *
 * Covers:
 *  - 'not_configured' when env vars missing
 *  - correct URL/method/body/headers for each wrapper
 *  - shape mismatch flags (array root, wrong field type, predicted of wrong type)
 *  - never throws on network error
 *  - passes through ML service `status`/`error` cleanly
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['ML_SERVICE_URLS', 'ML_SERVICE_SECRET'] as const;

interface FetchCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

let fetchCalls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } | (() => Promise<never>) = { status: 200, body: {} };
const originalFetch = globalThis.fetch;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function installFakeFetch() {
  // @ts-expect-error overriding global fetch for the test
  globalThis.fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    fetchCalls.push({ url: String(url), init });
    if (typeof nextResponse === 'function') {
      return nextResponse();
    }
    const { status, body } = nextResponse;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

beforeEach(() => {
  fetchCalls = [];
  nextResponse = { status: 200, body: {} };
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  installFakeFetch();
});

afterEach(() => {
  restoreFetch();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

async function loadHelper() {
  return await import('../ml-predict-invoke');
}

const PID = '8a041d6e-d881-4f19-83e0-7250f0e36eaa';

describe('predictDemand', () => {
  it('returns not_configured when env vars missing', async () => {
    delete process.env.ML_SERVICE_URLS;
    delete process.env.ML_SERVICE_SECRET;
    const { predictDemand } = await loadHelper();

    const result = await predictDemand(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_configured');
    assert.equal(fetchCalls.length, 0);
  });

  it('hits /predict/demand with the right body and Bearer auth', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = {
      status: 200,
      body: { predicted_minutes_p50: 320.5, predicted_headcount_p50: 4.1, model_version: 'v3' },
    };
    const { predictDemand } = await loadHelper();

    const result = await predictDemand(PID, {
      date: '2026-05-23',
      propertyTimezone: 'America/Chicago',
      requestId: 'req-xyz',
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://ml.example.com/predict/demand');
    assert.equal(fetchCalls[0].init?.headers?.['Authorization'], 'Bearer secret-12345');
    assert.equal(fetchCalls[0].init?.headers?.['x-request-id'], 'req-xyz');
    const body = JSON.parse(fetchCalls[0].init?.body ?? '{}');
    assert.equal(body.property_id, PID);
    assert.equal(body.date, '2026-05-23');
    assert.equal(body.property_timezone, 'America/Chicago');
  });

  it('propagates ML error fields without faking success', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { error: 'property_misconfigured: timezone=null' } };
    const { predictDemand } = await loadHelper();

    const result = await predictDemand(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'property_misconfigured: timezone=null');
  });

  it('returns shape_mismatch on root array', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: [1, 2, 3] };
    const { predictDemand } = await loadHelper();

    const result = await predictDemand(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'shape_mismatch');
    assert.match(result.error ?? '', /root_not_object.*array/);
  });

  it('never throws on network error', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = async () => { throw new Error('socket hangup'); };
    const { predictDemand } = await loadHelper();

    const result = await predictDemand(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /socket hangup/);
  });
});

describe('predictSupply', () => {
  it('hits /predict/supply', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { predicted_rooms: 42 } };
    const { predictSupply } = await loadHelper();

    await predictSupply(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });

    assert.equal(fetchCalls[0].url, 'https://ml.example.com/predict/supply');
  });
});

describe('predictOptimizer', () => {
  it('hits /predict/optimizer', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { status: 'ok' } };
    const { predictOptimizer } = await loadHelper();

    await predictOptimizer(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });

    assert.equal(fetchCalls[0].url, 'https://ml.example.com/predict/optimizer');
  });
});

describe('predictInventoryRates', () => {
  it('hits /predict/inventory-rate WITHOUT a date (ML service derives from tz)', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { predicted: 7, errors: [] } };
    const { predictInventoryRates } = await loadHelper();

    const result = await predictInventoryRates(PID, { propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, true);
    assert.equal(fetchCalls[0].url, 'https://ml.example.com/predict/inventory-rate');
    const body = JSON.parse(fetchCalls[0].init?.body ?? '{}');
    assert.equal(body.property_id, PID);
    assert.equal(body.property_timezone, 'America/Chicago');
    assert.equal(body.date, undefined, 'inventory-rate must NOT send date — server computes it');
  });

  it('flags shape_mismatch when `predicted` is the wrong type', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    // Simulate a future FastAPI bug where predicted becomes a string.
    nextResponse = { status: 200, body: { predicted: 'seven', errors: [] } };
    const { predictInventoryRates } = await loadHelper();

    const result = await predictInventoryRates(PID, { propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'shape_mismatch');
    assert.match(result.error ?? '', /predicted_type.*string/);
  });

  it('accepts responses where `predicted` is absent (legitimate skip)', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { errors: [], note: 'no items eligible' } };
    const { predictInventoryRates } = await loadHelper();

    const result = await predictInventoryRates(PID, { propertyTimezone: 'America/Chicago' });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
  });
});

describe('shard routing', () => {
  it('same property always routes to the same shard for the same path', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml-shard-0.example.com,https://ml-shard-1.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    const { predictDemand } = await loadHelper();

    await predictDemand(PID, { date: '2026-05-23', propertyTimezone: 'America/Chicago' });
    await predictDemand(PID, { date: '2026-05-24', propertyTimezone: 'America/Chicago' });

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url, fetchCalls[1].url, 'same property must always route to same shard');
  });
});
