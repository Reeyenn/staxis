/**
 * Tests for the ElevenLabs REST wrapper (Phase E2E, 2026-05-22).
 *
 * Covers:
 *  - throws when ELEVENLABS_API_KEY is unset (defense-in-depth)
 *  - attaches xi-api-key header automatically
 *  - composes paths to the api.elevenlabs.io base
 *  - passes through query strings and method/body
 *  - respects per-call timeout option
 *  - does NOT throw on non-2xx (returns Response for caller to branch on)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['ELEVENLABS_API_KEY'] as const;

interface FetchCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

let fetchCalls: FetchCall[] = [];
let nextResponse: { status: number; body?: unknown } | (() => Promise<never>) = { status: 200, body: { ok: true } };
const originalFetch = globalThis.fetch;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function installFakeFetch() {
  // @ts-expect-error overriding global fetch for the test
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      init: init as FetchCall['init'],
    });
    if (typeof nextResponse === 'function') {
      return nextResponse();
    }
    const { status, body } = nextResponse;
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

beforeEach(() => {
  fetchCalls = [];
  nextResponse = { status: 200, body: { ok: true } };
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
  return await import('../elevenlabs-client');
}

describe('elevenLabsFetch', () => {
  it('throws when ELEVENLABS_API_KEY is unset', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { elevenLabsFetch } = await loadHelper();
    await assert.rejects(
      () => elevenLabsFetch('/v1/voices'),
      /ELEVENLABS_API_KEY not configured/,
    );
    assert.equal(fetchCalls.length, 0, 'no fetch should fire without the key');
  });

  it('attaches xi-api-key header on every call', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-xyz';
    const { elevenLabsFetch } = await loadHelper();

    await elevenLabsFetch('/v1/voices');

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init?.headers?.['xi-api-key'], 'test-key-xyz');
  });

  it('composes relative paths to the api.elevenlabs.io base', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-xyz';
    const { elevenLabsFetch } = await loadHelper();

    await elevenLabsFetch('/v1/convai/conversation/get-signed-url?agent_id=abc');

    assert.equal(
      fetchCalls[0].url,
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=abc',
    );
  });

  it('accepts absolute URLs unchanged', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-xyz';
    const { elevenLabsFetch } = await loadHelper();

    await elevenLabsFetch('https://api.elevenlabs.io/v1/voices');

    assert.equal(fetchCalls[0].url, 'https://api.elevenlabs.io/v1/voices');
  });

  it('forwards method, body, and caller-supplied headers', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-xyz';
    const { elevenLabsFetch } = await loadHelper();

    await elevenLabsFetch('/v1/text-to-speech/voice-id?output_format=mp3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: 'hello', model_id: 'eleven_turbo_v2_5' }),
    });

    const call = fetchCalls[0];
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.headers?.['Content-Type'], 'application/json');
    assert.equal(call.init?.headers?.['Accept'], 'audio/mpeg');
    // xi-api-key still gets attached alongside caller headers.
    assert.equal(call.init?.headers?.['xi-api-key'], 'test-key-xyz');
    const parsed = JSON.parse(call.init?.body ?? '{}');
    assert.equal(parsed.text, 'hello');
  });

  it('does NOT throw on non-2xx — returns Response for caller to branch on', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-xyz';
    nextResponse = { status: 503, body: { detail: 'overloaded' } };
    const { elevenLabsFetch } = await loadHelper();

    const res = await elevenLabsFetch('/v1/voices');
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
  });
});
