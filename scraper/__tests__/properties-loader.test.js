/**
 * scraper/__tests__/properties-loader.test.js
 *
 * Run via: node --test scraper/__tests__/properties-loader.test.js
 *
 * Properties-loader is the seam between "single-property scraper running
 * off env vars" (today) and "multi-property scraper iterating across
 * scraper_credentials rows" (tomorrow). The fallback path is
 * particularly load-bearing: if the table is empty for any reason, we
 * MUST keep polling the legacy single property so we don't silently stop
 * scraping for Mario.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadActiveProperties, _resetCache } = require('../properties-loader');

// ─── helpers ────────────────────────────────────────────────────────────────

function fakeSupabase(rowsOrError) {
  // Build a chain that mirrors supabase-js: .from(t).select(c).eq(k,v).eq(k,v) → result.
  const builder = {
    from() { return builder; },
    select() { return builder; },
    eq() { return builder; },
    then(resolve) {
      if (rowsOrError instanceof Error) {
        return Promise.resolve({ data: null, error: { message: rowsOrError.message } }).then(resolve);
      }
      return Promise.resolve({ data: rowsOrError, error: null }).then(resolve);
    },
  };
  return builder;
}

let savedEnv;
beforeEach(() => {
  _resetCache();
  savedEnv = {
    HOTELOPS_PROPERTY_ID: process.env.HOTELOPS_PROPERTY_ID,
    CA_USERNAME: process.env.CA_USERNAME,
    CA_PASSWORD: process.env.CA_PASSWORD,
    SCRAPER_INSTANCE_ID: process.env.SCRAPER_INSTANCE_ID,
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCache();
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('loadActiveProperties — table-driven path', () => {
  test('returns table rows when scraper_credentials has matching rows', async () => {
    process.env.SCRAPER_INSTANCE_ID = 'default';
    const sb = fakeSupabase([
      {
        property_id: '11111111-1111-1111-1111-111111111111',
        pms_type: 'choice_advantage',
        ca_login_url: 'https://example.com/login',
        ca_username: 'user1',
        ca_password: 'pass1',
        is_active: true,
        scraper_instance: 'default',
      },
      {
        property_id: '22222222-2222-2222-2222-222222222222',
        pms_type: 'choice_advantage',
        ca_login_url: 'https://example.com/login',
        ca_username: 'user2',
        ca_password: 'pass2',
        is_active: true,
        scraper_instance: 'default',
      },
    ]);

    const props = await loadActiveProperties(sb);
    assert.equal(props.length, 2);
    assert.equal(props[0].propertyId, '11111111-1111-1111-1111-111111111111');
    assert.equal(props[1].caUsername, 'user2');
    assert.equal(props[0].fromFallback, false);
  });
});

describe('loadActiveProperties — env fallback', () => {
  test('falls back to env vars when table is empty', async () => {
    process.env.HOTELOPS_PROPERTY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    process.env.CA_USERNAME = 'envuser';
    process.env.CA_PASSWORD = 'envpass';

    const props = await loadActiveProperties(fakeSupabase([]));
    assert.equal(props.length, 1);
    assert.equal(props[0].propertyId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(props[0].caUsername, 'envuser');
    assert.equal(props[0].fromFallback, true);
  });

  test('returns empty array when table is empty AND env is incomplete', async () => {
    delete process.env.HOTELOPS_PROPERTY_ID;
    delete process.env.CA_USERNAME;
    delete process.env.CA_PASSWORD;

    const props = await loadActiveProperties(fakeSupabase([]));
    assert.equal(props.length, 0);
  });

  test('falls back to env vars when supabase errors', async () => {
    process.env.HOTELOPS_PROPERTY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    process.env.CA_USERNAME = 'envuser';
    process.env.CA_PASSWORD = 'envpass';

    const props = await loadActiveProperties(fakeSupabase(new Error('boom')));
    assert.equal(props.length, 1);
    assert.equal(props[0].fromFallback, true);
  });
});

describe('loadActiveProperties — caching', () => {
  test('subsequent calls within the TTL hit cache', async () => {
    process.env.SCRAPER_INSTANCE_ID = 'default';
    let calls = 0;
    const sb = {
      from() { return sb; },
      select() { return sb; },
      eq() { return sb; },
      then(resolve) {
        calls++;
        return Promise.resolve({
          data: [{
            property_id: '11111111-1111-1111-1111-111111111111',
            pms_type: 'choice_advantage',
            ca_login_url: 'https://example.com',
            ca_username: 'u',
            ca_password: 'p',
            is_active: true,
            scraper_instance: 'default',
          }],
          error: null,
        }).then(resolve);
      },
    };

    await loadActiveProperties(sb);
    await loadActiveProperties(sb);
    await loadActiveProperties(sb);
    assert.equal(calls, 1, 'only one DB call should be made within the cache TTL');
  });

  test('noCache option bypasses the cache', async () => {
    process.env.SCRAPER_INSTANCE_ID = 'default';
    let calls = 0;
    const sb = {
      from() { return sb; },
      select() { return sb; },
      eq() { return sb; },
      then(resolve) {
        calls++;
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    delete process.env.HOTELOPS_PROPERTY_ID;
    delete process.env.CA_USERNAME;
    delete process.env.CA_PASSWORD;

    await loadActiveProperties(sb);
    await loadActiveProperties(sb, { noCache: true });
    assert.equal(calls, 2);
  });
});
