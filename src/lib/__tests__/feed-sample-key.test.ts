/**
 * Tests for the SHARED feed-artifact contract (src/lib/pms/feed-sample-key.ts,
 * feature/coverage-gated-feeds).
 *
 * The Make-live gate (promoteMap) and the "Captured" preview reader
 * (GET /api/admin/mapper/feed-sample) must agree on:
 *   1. the artifact FILENAME — `live/{propertyId}/{sanitizeFeedKey(key)}.sample.json`
 *      (pinned byte-identical to the original inline rule), and
 *   2. what counts as a PROVEN sample — sampleIndicatesSuccess: only an
 *      EXPLICIT ok:false is unproven; an absent flag (legacy artifact) is
 *      grandfathered proven; garbage fails open to proven.
 * Otherwise promote could disable a feed the panel shows as previewed.
 * A source guard also pins that the feed-sample route actually derives its
 * response `ok` from the shared rule (not a duplicate inline check).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sanitizeFeedKey, sampleIndicatesSuccess } from '@/lib/pms/feed-sample-key';

// The verbatim rule that both feed-sample/route.ts and promote-map.ts used to
// (would) inline. The shared export must equal this for every input.
const ORIGINAL_INLINE = (k: string): string => k.replace(/[^a-z0-9_-]/gi, '_');

describe('sanitizeFeedKey — shared feed-artifact rule', () => {
  const cases = [
    'getArrivals',
    'arrival.list',        // dot → underscore
    'work orders',         // space → underscore
    'ROOM_STATUS',         // uppercase preserved
    'a-b_c',               // hyphen + underscore preserved
    'feed/with:weird*chars',
    'unicodé.名',          // non-ascii → underscore
    '',                    // empty
    '...',                 // all-replaced
    'Trailing.',
  ];

  for (const input of cases) {
    test(`byte-identical to the original inline rule: ${JSON.stringify(input)}`, () => {
      assert.equal(sanitizeFeedKey(input), ORIGINAL_INLINE(input));
    });
  }

  test('replaces every non [a-z0-9_-] char (case-insensitive) with _', () => {
    assert.equal(sanitizeFeedKey('arrival.list'), 'arrival_list');
    assert.equal(sanitizeFeedKey('a b.c'), 'a_b_c');
    // Allowed chars are untouched.
    assert.equal(sanitizeFeedKey('Get-Arrivals_2'), 'Get-Arrivals_2');
  });
});

describe('sampleIndicatesSuccess — shared proven rule', () => {
  test('explicit ok:false → unproven', () => {
    assert.equal(sampleIndicatesSuccess({ ok: false, rowCount: 0, fields: [] }), false);
  });

  test('explicit ok:true → proven', () => {
    assert.equal(sampleIndicatesSuccess({ ok: true, rowCount: 5, fields: [] }), true);
  });

  test('absent ok field (legacy artifact) → grandfathered proven', () => {
    assert.equal(sampleIndicatesSuccess({ capturedAt: 'x', rowCount: 3, fields: [] }), true);
    assert.equal(sampleIndicatesSuccess({}), true);
  });

  test('only BOOLEAN false counts — other falsy/odd ok values stay proven', () => {
    // The worker stamps a boolean; anything else is a malformed artifact and
    // fails open rather than turning a feed off on bad data.
    assert.equal(sampleIndicatesSuccess({ ok: 0 }), true);
    assert.equal(sampleIndicatesSuccess({ ok: 'false' }), true);
    assert.equal(sampleIndicatesSuccess({ ok: null }), true);
  });

  test('garbage / non-object input → proven (fail open)', () => {
    assert.equal(sampleIndicatesSuccess(null), true);
    assert.equal(sampleIndicatesSuccess(undefined), true);
    assert.equal(sampleIndicatesSuccess('garbage'), true);
    assert.equal(sampleIndicatesSuccess(42), true);
  });
});

describe('feed-sample route — ok passthrough source guard', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'app', 'api', 'admin', 'mapper', 'feed-sample', 'route.ts'),
    'utf8',
  );

  test('derives the response ok from the SHARED rule, not an inline duplicate', () => {
    assert.match(src, /ok:\s*sampleIndicatesSuccess\(parsed\)/);
    assert.match(src, /import\s*\{[^}]*sampleIndicatesSuccess[^}]*\}\s*from\s*['"]@\/lib\/pms\/feed-sample-key['"]/);
  });
});
