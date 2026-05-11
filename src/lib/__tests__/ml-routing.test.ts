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
    // The hash is FNV-1a so we can't predict which pair lands where
    // by eye. Find two UUIDs that hash to different parities by
    // probing — the test only cares that "different pids CAN map to
    // different shards", not which specific ones.
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const prefix = i.toString(16).padStart(8, '0');
      const url = resolveMlShardUrl(`${prefix}-1111-1111-1111-111111111111`);
      if (url) seen.add(url);
    }
    assert.equal(seen.size, 2, `expected both shards to be hit, got ${seen.size}`);
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

  it('handles non-UUID input without crashing', () => {
    // FNV-1a is well-defined on any string. Different inputs may land
    // on different shards (that's actually a property of a good hash —
    // we no longer pin all malformed input to shard 0). The empty
    // string is the lone exception: it collapses to the FNV offset
    // basis (a deterministic constant), pinning it to one shard.
    process.env.ML_SERVICE_URLS = 'https://a,https://b';
    // No throw, and the result is one of the configured URLs.
    const r1 = resolveMlShardUrl('not-a-uuid');
    const r2 = resolveMlShardUrl('');
    assert.ok(r1 === 'https://a' || r1 === 'https://b');
    assert.ok(r2 === 'https://a' || r2 === 'https://b');
  });

  it('handles UUID v7 (timestamp-prefixed) without bucket collapse', () => {
    // The earlier first-8-hex-chars hash would have collapsed every
    // UUID v7 created in the same second to one shard (since the first
    // 48 bits are a unix-ms timestamp). Verify FNV-1a spreads them
    // across the configured shards.
    process.env.ML_SERVICE_URLS = 'https://a,https://b,https://c,https://d';
    // Simulate 200 v7-shaped UUIDs created within one second — all
    // share the same first 11 hex chars (the ms timestamp), differ
    // only in the random tail.
    const counts: Record<string, number> = { 'https://a': 0, 'https://b': 0, 'https://c': 0, 'https://d': 0 };
    const sharedPrefix = '01931abc-def0'; // pretend v7 timestamp prefix
    for (let i = 0; i < 200; i++) {
      const tail = (i * 16777619).toString(16).padStart(8, '0').slice(-12);
      const pid = `${sharedPrefix}-7000-8000-${tail}`;
      const url = resolveMlShardUrl(pid)!;
      counts[url] = (counts[url] ?? 0) + 1;
    }
    // All four buckets should be non-empty (≥ 20 to leave headroom).
    // With the old hash, ONE bucket would have 200 and the others 0.
    for (const [, c] of Object.entries(counts)) {
      assert.ok(c >= 20, `v7-style UUIDs collapsed: ${JSON.stringify(counts)}`);
    }
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
  it('produces unsigned 32-bit ints', () => {
    const h = _internal.stableHashUuid('8e3a52cb-1234-5678-9abc-def012345678');
    assert.ok(Number.isInteger(h));
    assert.ok(h >= 0);
    assert.ok(h < 2 ** 32);
  });

  it('is deterministic', () => {
    const a = _internal.stableHashUuid('some-property-id');
    const b = _internal.stableHashUuid('some-property-id');
    assert.equal(a, b);
  });

  it('differs for different inputs', () => {
    const a = _internal.stableHashUuid('property-a');
    const b = _internal.stableHashUuid('property-b');
    assert.notEqual(a, b);
  });

  it('returns the FNV-1a offset basis for empty or non-string input', () => {
    // Bad input → the FNV offset basis (0x811c9dc5), a deterministic
    // constant. We want a stable shard for invalid input, not a crash.
    const basis = 0x811c9dc5;
    assert.equal(_internal.stableHashUuid(''), basis);
    assert.equal(_internal.stableHashUuid(null as unknown as string), basis);
    assert.equal(_internal.stableHashUuid(undefined as unknown as string), basis);
  });
});
