/**
 * Tests for src/lib/ml-routing.ts — the deterministic UUID→shard mapping
 * the cron routes use to fan out to N Python ML services.
 *
 * Key invariants:
 *   - Single-URL config returns that URL for every property.
 *   - Multi-URL config distributes deterministically: same pid → same shard.
 *   - Empty config returns null (caller's cue to skip).
 *   - ML_SERVICE_URLS overrides ML_SERVICE_URL when both are set.
 *   - Distribution is reasonably balanced across many UUIDs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMlShardUrl,
  listMlShardUrls,
  getPrimaryMlShardUrl,
  _internal,
} from '../ml-routing';

// Capture and restore env so we can mutate freely inside each test.
let savedUrl: string | undefined;
let savedUrls: string | undefined;

beforeEach(() => {
  savedUrl = process.env.ML_SERVICE_URL;
  savedUrls = process.env.ML_SERVICE_URLS;
  delete process.env.ML_SERVICE_URL;
  delete process.env.ML_SERVICE_URLS;
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.ML_SERVICE_URL;
  else process.env.ML_SERVICE_URL = savedUrl;
  if (savedUrls === undefined) delete process.env.ML_SERVICE_URLS;
  else process.env.ML_SERVICE_URLS = savedUrls;
});

describe('listMlShardUrls', () => {
  it('returns [] when nothing is configured', () => {
    assert.deepEqual(listMlShardUrls(), []);
  });

  it('returns the single URL when only ML_SERVICE_URL is set', () => {
    process.env.ML_SERVICE_URL = 'https://ml.example.com';
    assert.deepEqual(listMlShardUrls(), ['https://ml.example.com']);
  });

  it('trims whitespace in the single-URL form', () => {
    process.env.ML_SERVICE_URL = '  https://ml.example.com  ';
    assert.deepEqual(listMlShardUrls(), ['https://ml.example.com']);
  });

  it('splits comma-separated ML_SERVICE_URLS', () => {
    process.env.ML_SERVICE_URLS = 'https://a,https://b,https://c';
    assert.deepEqual(listMlShardUrls(), [
      'https://a',
      'https://b',
      'https://c',
    ]);
  });

  it('trims each item and drops empties', () => {
    process.env.ML_SERVICE_URLS = 'https://a,  https://b , ,https://c';
    assert.deepEqual(listMlShardUrls(), [
      'https://a',
      'https://b',
      'https://c',
    ]);
  });

  it('ML_SERVICE_URLS takes precedence over ML_SERVICE_URL', () => {
    process.env.ML_SERVICE_URL = 'https://legacy';
    process.env.ML_SERVICE_URLS = 'https://shard-0,https://shard-1';
    assert.deepEqual(listMlShardUrls(), [
      'https://shard-0',
      'https://shard-1',
    ]);
  });
});

describe('resolveMlShardUrl', () => {
  it('returns null when no env vars set', () => {
    assert.equal(resolveMlShardUrl('abc-1234'), null);
  });

  it('returns the single URL regardless of pid', () => {
    process.env.ML_SERVICE_URL = 'https://only';
    assert.equal(resolveMlShardUrl('8e3a52cb-aaaa-bbbb-cccc-dddddddddddd'), 'https://only');
    assert.equal(resolveMlShardUrl('00000000-0000-0000-0000-000000000000'), 'https://only');
  });

  it('is deterministic — same pid → same shard', () => {
    process.env.ML_SERVICE_URLS = 'https://a,https://b,https://c,https://d';
    const pid = '8e3a52cb-1234-5678-9abc-def012345678';
    const a = resolveMlShardUrl(pid);
    const b = resolveMlShardUrl(pid);
    const c = resolveMlShardUrl(pid);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('different pids can land on different shards', () => {
    process.env.ML_SERVICE_URLS = 'https://a,https://b';
    // Two UUIDs whose first-8-hex prefixes parse to different parities.
    // (0x8e3a52cb is odd, 0x12345678 is even → different shards mod 2.)
    const shardA = resolveMlShardUrl('8e3a52cb-1111-1111-1111-111111111111');
    const shardB = resolveMlShardUrl('12345678-1111-1111-1111-111111111111');
    assert.notEqual(shardA, shardB);
  });

  it('distributes a fleet of random UUIDs reasonably evenly', () => {
    process.env.ML_SERVICE_URLS = 'https://a,https://b,https://c,https://d';
    const counts = { 'https://a': 0, 'https://b': 0, 'https://c': 0, 'https://d': 0 } as Record<string, number>;
    // Generate 400 deterministic but varied UUID-shaped strings.
    for (let i = 0; i < 400; i++) {
      const h = (i * 2654435761) >>> 0;
      const pid = `${h.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`;
      const url = resolveMlShardUrl(pid)!;
      counts[url] = (counts[url] ?? 0) + 1;
    }
    // Each bucket should hold ~100. Accept ±50 for the deterministic
    // sequence — perfect uniformity isn't the goal, "not catastrophic
    // skew" is.
    for (const [, c] of Object.entries(counts)) {
      assert.ok(c >= 50 && c <= 150, `unbalanced bucket: ${c}`);
    }
  });

  it('falls back to shard 0 for non-UUID input', () => {
    process.env.ML_SERVICE_URLS = 'https://a,https://b';
    assert.equal(resolveMlShardUrl('not-a-uuid'), 'https://a');
    assert.equal(resolveMlShardUrl(''), 'https://a');
  });
});

describe('getPrimaryMlShardUrl', () => {
  it('returns null when nothing is configured', () => {
    assert.equal(getPrimaryMlShardUrl(), null);
  });

  it('returns ML_SERVICE_URL when single', () => {
    process.env.ML_SERVICE_URL = 'https://only';
    assert.equal(getPrimaryMlShardUrl(), 'https://only');
  });

  it('returns the first element of ML_SERVICE_URLS when multi', () => {
    process.env.ML_SERVICE_URLS = 'https://primary,https://second';
    assert.equal(getPrimaryMlShardUrl(), 'https://primary');
  });
});

describe('stableHashUuid (internal)', () => {
  it('produces consistent unsigned 32-bit ints', () => {
    const h = _internal.stableHashUuid('8e3a52cb-1234-5678-9abc-def012345678');
    assert.equal(h, 0x8e3a52cb);
    assert.ok(h >= 0);
    assert.ok(h < 2 ** 32);
  });

  it('returns 0 for malformed input', () => {
    assert.equal(_internal.stableHashUuid(''), 0);
    assert.equal(_internal.stableHashUuid('abc'), 0);
    // typeof check guard
    assert.equal(_internal.stableHashUuid(null as unknown as string), 0);
  });
});
