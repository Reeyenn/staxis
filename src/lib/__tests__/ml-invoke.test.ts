/**
 * Behavior tests for the triggerMlTraining helper (Phase M3.1).
 *
 * The helper centralizes the fetch + auth + JSON-parse boilerplate that
 * the 4 existing ml-train cron callers inline today AND that the new
 * on-onboard hook (commit 6) needs. These tests pin the contract:
 *  - returns { status: 'not_configured' } when env vars are absent
 *  - hits the right URL/path per layer
 *  - forwards Bearer auth + property_id body
 *  - shapes the result correctly on success, error, and HTTP-non-2xx
 *  - never throws (safe to call fire-and-forget)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['ML_SERVICE_URL', 'ML_SERVICE_URLS', 'ML_SERVICE_SECRET'] as const;

interface FetchCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

let fetchCalls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } | (() => Promise<never>) = { status: 200, body: { status: 'ok' } };
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
  nextResponse = { status: 200, body: { status: 'ok' } };
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
  // Re-import on each call so module-level env reads (none currently, but
  // future-proofed against changes) pick up our test env.
  return await import('../ml-invoke');
}

describe('triggerMlTraining', () => {
  it('returns not_configured when ML_SERVICE_URL missing', async () => {
    delete process.env.ML_SERVICE_URL;
    delete process.env.ML_SERVICE_URLS;
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    const { triggerMlTraining } = await loadHelper();

    const result = await triggerMlTraining('00000000-0000-0000-0000-000000000001', 'demand');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_configured');
    assert.equal(fetchCalls.length, 0, 'should NOT have called fetch when ML service is not configured');
  });

  it('returns not_configured when ML_SERVICE_SECRET missing', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    delete process.env.ML_SERVICE_SECRET;
    const { triggerMlTraining } = await loadHelper();

    const result = await triggerMlTraining('00000000-0000-0000-0000-000000000001', 'demand');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_configured');
    assert.equal(fetchCalls.length, 0);
  });

  it('hits /train/demand for layer=demand with Bearer auth + property_id body', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { status: 'ok', cold_start: true } };
    const { triggerMlTraining } = await loadHelper();

    const result = await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'demand');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.equal(call.url, 'https://ml.example.com/train/demand');
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.headers?.['Authorization'], 'Bearer secret-12345');
    assert.equal(call.init?.headers?.['Content-Type'], 'application/json');
    const parsed = JSON.parse(call.init?.body ?? '{}');
    assert.equal(parsed.property_id, '8a041d6e-d881-4f19-83e0-7250f0e36eaa');
    assert.equal(parsed.item_id, undefined);
  });

  it('hits /train/supply for layer=supply', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    const { triggerMlTraining } = await loadHelper();

    await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'supply');

    assert.equal(fetchCalls[0].url, 'https://ml.example.com/train/supply');
  });

  it('hits /train/inventory-rate and includes item_id when provided', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    const { triggerMlTraining } = await loadHelper();

    await triggerMlTraining(
      '8a041d6e-d881-4f19-83e0-7250f0e36eaa',
      'inventory-rate',
      { itemId: 'item-uuid-123' },
    );

    assert.equal(fetchCalls[0].url, 'https://ml.example.com/train/inventory-rate');
    const parsed = JSON.parse(fetchCalls[0].init?.body ?? '{}');
    assert.equal(parsed.item_id, 'item-uuid-123');
  });

  it('forwards x-request-id header when provided', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    const { triggerMlTraining } = await loadHelper();

    await triggerMlTraining(
      '8a041d6e-d881-4f19-83e0-7250f0e36eaa',
      'demand',
      { requestId: 'req-abc-123' },
    );

    assert.equal(fetchCalls[0].init?.headers?.['x-request-id'], 'req-abc-123');
  });

  it('marks ok=false when ML service returns an error field', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 200, body: { error: 'property_misconfigured: timezone=null' } };
    const { triggerMlTraining } = await loadHelper();

    const result = await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'demand');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'property_misconfigured: timezone=null');
  });

  it('marks ok=false when ML service returns non-2xx', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = { status: 500, body: { detail: 'internal' } };
    const { triggerMlTraining } = await loadHelper();

    const result = await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'demand');

    assert.equal(result.ok, false);
    assert.equal(result.http, 500);
  });

  it('never throws on network error — returns error result instead', async () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    nextResponse = async () => { throw new Error('socket hangup'); };
    const { triggerMlTraining } = await loadHelper();

    // No try/catch — assert it doesn't throw.
    const result = await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'demand');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /socket hangup/);
  });

  it('routes via resolveMlShardUrl — multi-shard config picks deterministically', async () => {
    process.env.ML_SERVICE_URLS = 'https://ml-shard-0.example.com,https://ml-shard-1.example.com';
    delete process.env.ML_SERVICE_URL;
    process.env.ML_SERVICE_SECRET = 'secret-12345';
    const { triggerMlTraining } = await loadHelper();

    // Call the same property twice — must hit the SAME shard both times.
    await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'demand');
    await triggerMlTraining('8a041d6e-d881-4f19-83e0-7250f0e36eaa', 'demand');

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url, fetchCalls[1].url, 'same property must always route to same shard');
    // And the URL must be one of the configured shards.
    const shardUrls = ['https://ml-shard-0.example.com/train/demand', 'https://ml-shard-1.example.com/train/demand'];
    assert.ok(shardUrls.includes(fetchCalls[0].url), `unexpected URL: ${fetchCalls[0].url}`);
  });
});
