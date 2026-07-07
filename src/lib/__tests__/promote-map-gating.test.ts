/**
 * Tests for the per-feed collection gate in src/lib/pms/promote-map.ts
 * (feature/coverage-gated-feeds).
 *
 * The founder's rule: Make-live only turns on feeds proven readable by a preview
 * capture; the rest stay off (disabled_feeds) until a later Re-read re-enables
 * them. promoteMap gains an optional `gateByPropertyCaptures: { propertyId }`;
 * when present AND the target is a draft, it lists the property's preview
 * artifacts in the private mapping-screenshots bucket ONCE, then DOWNLOADS each
 * sample matching a mapped key: proven ⇔ the artifact exists AND its
 * `parsed.ok !== false` (the worker writes a sample even for a partially-failed
 * read, stamped ok:false; a legacy artifact WITHOUT the flag is grandfathered
 * as proven).
 *
 * These tests pin:
 *   1. Unproven feeds land in disabled_feeds on the ACTIVATE update; proven
 *      feeds don't. The activate patch's disabled_feeds is asserted directly.
 *   2. An artifact stamped ok:false is UNPROVEN; absent flag → proven;
 *      garbage JSON / per-feed download error → proven (per-feed fail open).
 *   3. A storage-list error FAILS OPEN — promotes, no disabled_feeds written.
 *   4. No propertyId → the column is NEVER touched (patch omits disabled_feeds).
 *   5. The ok result carries disabledFeeds + allFeedsDisabled.
 *   6. sanitizeFeedKey is applied to match artifacts (a "." in the key → "_").
 *
 * DB + storage are monkey-patched (supabaseAdmin.from / .storage.from), same
 * singleton-patch style as promote-map-signature.test.ts.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { promoteMap } from '@/lib/pms/promote-map';

type FromFn = typeof supabaseAdmin.from;
type StorageFromFn = typeof supabaseAdmin.storage.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalStorageFrom: StorageFromFn = supabaseAdmin.storage.from.bind(supabaseAdmin.storage);

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const PROPERTY_ID = '22222222-2222-2222-2222-222222222222';
const FAMILY = 'choice_advantage';

// The draft's mapped feeds. "arrival.list" exercises the sanitizer (. → _).
const KNOWLEDGE = { actions: { getArrivals: {}, getDepartures: {}, 'arrival.list': {} } };

// What the mocked storage list returns, and whether it errors — set per test.
let storageEntries: Array<{ name: string }> = [];
let storageError: { message: string } | null = null;

// Per-sanitized-key sample.json bodies (raw text so tests can feed garbage).
// A key listed in storageEntries but absent here downloads the default '{}' —
// i.e. a LEGACY artifact without the ok flag (grandfathered as proven).
let storageSampleBodies: Record<string, string> = {};
// Sanitized keys whose download errors (per-feed fail-open path).
let storageDownloadErrorKeys: Set<string> = new Set();

// The disabled_feeds value written by the ACTIVATE update, or a sentinel when
// the column was omitted from the patch entirely (the no-gate contract).
const OMITTED = Symbol('omitted');
let activateDisabledFeeds: unknown = OMITTED;

let targetRow: Record<string, unknown> | null = null;

function installDbMock() {
  supabaseAdmin.from = ((table: string) => {
    const chain: string[] = [];
    let kind: 'select' | 'update' = 'select';
    let updateArg: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      select(...args: unknown[]) { chain.push(`select(${args.join(',')})`); return builder; },
      update(arg: Record<string, unknown>) { kind = 'update'; updateArg = arg; chain.push('update'); return builder; },
      eq(...args: unknown[]) { chain.push(`eq(${args.join(',')})`); return builder; },
      is(...args: unknown[]) { chain.push(`is(${args.join(',')})`); return builder; },
      maybeSingle: async () => {
        if (table === 'pms_knowledge_files' && kind === 'select') {
          return { data: targetRow, error: null };
        }
        if (table === 'pms_knowledge_files' && kind === 'update') {
          const isPromote = chain.some((c) => c.startsWith(`eq(id,${DRAFT_ID})`));
          if (isPromote) {
            // Record what the activate patch set (or didn't) for disabled_feeds.
            activateDisabledFeeds = updateArg && 'disabled_feeds' in updateArg
              ? updateArg.disabled_feeds
              : OMITTED;
            return {
              data: {
                id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'active',
                promoted_to_active_at: new Date().toISOString(),
              },
              error: null,
            };
          }
          return { data: null, error: null }; // demote: no current active
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
    };
    return builder;
  }) as unknown as FromFn;

  // Storage: the gate lists the prefix once, then downloads each candidate
  // sample.json to check its ok flag. The download mock resolves the sanitized
  // key from the path and serves the per-test body ('{}' = legacy, no flag).
  supabaseAdmin.storage.from = ((_bucket: string) => ({
    list: async () => (storageError ? { data: null, error: storageError } : { data: storageEntries, error: null }),
    download: async (path: string) => {
      const key = /\/([^/]+)\.sample\.json$/.exec(path)?.[1] ?? '';
      if (storageDownloadErrorKeys.has(key)) return { data: null, error: { message: 'download blip' } };
      const body = storageSampleBodies[key] ?? '{}';
      // Only .text() is consumed by sampleProvesFeed — a tiny stub is enough.
      return { data: { text: async () => body }, error: null };
    },
  })) as unknown as StorageFromFn;
}

beforeEach(() => {
  storageEntries = [];
  storageError = null;
  storageSampleBodies = {};
  storageDownloadErrorKeys = new Set();
  activateDisabledFeeds = OMITTED;
  targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'draft', signature: '\\xdeadbeef', knowledge: KNOWLEDGE };
  delete process.env.PROMOTE_ALLOW_UNSIGNED;
  installDbMock();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.storage.from = originalStorageFrom;
  delete process.env.PROMOTE_ALLOW_UNSIGNED;
});

describe('promoteMap — per-feed collection gate', () => {
  test('unproven feeds → disabled_feeds; proven feeds excluded', async () => {
    // Only getArrivals + arrival.list have a proven sample. getDepartures does not.
    // arrival.list sanitizes to arrival_list — the artifact must match the SANITIZED key.
    storageEntries = [
      { name: 'getArrivals.sample.json' },
      { name: 'arrival_list.sample.json' },
      { name: 'ignore-me.png' }, // non-sample artifact is ignored
    ];

    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.disabledFeeds, ['getDepartures']);
      assert.equal(res.allFeedsDisabled, false);
    }
    // The ACTIVATE update carried exactly the disabled set.
    assert.deepEqual(activateDisabledFeeds, ['getDepartures']);
  });

  test('every feed proven → disabled_feeds is empty, allFeedsDisabled false', async () => {
    // Default bodies = '{}' → LEGACY artifacts without the ok flag. All three
    // must be grandfathered as proven (the founder's pre-flag previews stay on).
    storageEntries = [
      { name: 'getArrivals.sample.json' },
      { name: 'getDepartures.sample.json' },
      { name: 'arrival_list.sample.json' },
    ];
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.disabledFeeds, []);
      assert.equal(res.allFeedsDisabled, false);
    }
    // Still writes the (empty) array because gating RAN.
    assert.deepEqual(activateDisabledFeeds, []);
  });

  test('an artifact stamped ok:false is UNPROVEN — existence alone is not proof', async () => {
    // All three samples EXIST, but getDepartures' capture partially failed
    // (the worker still wrote its "see what went wrong" preview, ok:false).
    storageEntries = [
      { name: 'getArrivals.sample.json' },
      { name: 'getDepartures.sample.json' },
      { name: 'arrival_list.sample.json' },
    ];
    storageSampleBodies = {
      getArrivals: JSON.stringify({ ok: true, rowCount: 5, fields: [] }),
      getDepartures: JSON.stringify({ ok: false, rowCount: 0, fields: [] }),
      // arrival_list stays default '{}' → legacy, grandfathered proven.
    };
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.disabledFeeds, ['getDepartures']);
      assert.equal(res.allFeedsDisabled, false);
    }
    assert.deepEqual(activateDisabledFeeds, ['getDepartures']);
  });

  test('per-feed download error → that feed counts proven (fail open), promote continues', async () => {
    storageEntries = [
      { name: 'getArrivals.sample.json' },
      { name: 'getDepartures.sample.json' },
      { name: 'arrival_list.sample.json' },
    ];
    storageDownloadErrorKeys = new Set(['getArrivals']); // blips → proven anyway
    storageSampleBodies = { getDepartures: JSON.stringify({ ok: false }) };
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    // Only the EXPLICIT ok:false feed is disabled; the download-blip feed is not.
    if (res.ok) assert.deepEqual(res.disabledFeeds, ['getDepartures']);
    assert.deepEqual(activateDisabledFeeds, ['getDepartures']);
  });

  test('garbage sample JSON → proven (fail open for that feed)', async () => {
    storageEntries = [
      { name: 'getArrivals.sample.json' },
      { name: 'getDepartures.sample.json' },
      { name: 'arrival_list.sample.json' },
    ];
    storageSampleBodies = { getArrivals: 'not json {{{' }; // unparseable → proven
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.disabledFeeds, []);
    assert.deepEqual(activateDisabledFeeds, []);
  });

  test('NO feed proven → every feed disabled, allFeedsDisabled true, still promotes', async () => {
    storageEntries = []; // no previews at all
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.disabledFeeds.sort(), ['arrival.list', 'getArrivals', 'getDepartures']);
      assert.equal(res.allFeedsDisabled, true);
      assert.equal(res.map.status, 'active'); // promoted anyway
    }
  });

  test('storage list error → FAIL OPEN (no disabled_feeds written), still promotes', async () => {
    storageError = { message: 'transient storage blip' };
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.disabledFeeds, []);
      assert.equal(res.allFeedsDisabled, false);
      assert.equal(res.map.status, 'active');
    }
    // Fail-open: gating "ran" but produced [] — the activate still writes [].
    assert.deepEqual(activateDisabledFeeds, []);
  });

  test('no propertyId → disabled_feeds column is NEVER touched', async () => {
    storageEntries = [{ name: 'getArrivals.sample.json' }]; // would matter IF gating ran
    const res = await promoteMap({ id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft' });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.disabledFeeds, []);
      assert.equal(res.allFeedsDisabled, false);
    }
    // Crucial: the activate patch OMITTED disabled_feeds entirely.
    assert.equal(activateDisabledFeeds, OMITTED);
  });

  test('gating is skipped for a deprecated → active rollback (column untouched)', async () => {
    // A rollback re-lights an already-vetted map; even with a propertyId the
    // gate must not run because the target is not a draft.
    targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'deprecated', signature: '\\xbeef', knowledge: KNOWLEDGE };
    storageEntries = [];
    const res = await promoteMap({
      id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'deprecated',
      gateByPropertyCaptures: { propertyId: PROPERTY_ID },
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.disabledFeeds, []);
    assert.equal(activateDisabledFeeds, OMITTED);
  });
});
