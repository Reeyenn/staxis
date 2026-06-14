/**
 * Tests for the multi-tenant login fix (feature/cua-per-hotel-login).
 *
 * Bug: one active knowledge file per pms_family fixes login.startUrl for EVERY
 * hotel on the family, so cloud PMSes that give each hotel its own subdomain
 * (OPERA Cloud, Cloudbeds, Mews, RoomKey) were all funnelled at one tenant.
 * The per-hotel URL (scraper_credentials.ca_login_url) was loaded but ignored.
 *
 * `resolveLoginUrl` / `resolveAllowedHost` are the pure core of the fix:
 *   - resolveLoginUrl: per-hotel URL wins (normalized, so a schemeless input
 *     still resolves to the same host the guard uses); absent/empty → family.
 *   - resolveAllowedHost: the same-site host guard is anchored to whichever
 *     URL we actually log in at, so a per-hotel subdomain isn't false-rejected
 *     — and a malformed per-hotel URL falls back to the family host instead of
 *     throwing (fails closed: the login navigation itself is what rejects it).
 *
 * SCOPE: this is the LOGIN-navigation fix. Feed reads still navigate to the
 * recipe's recorded (family-tenant) URLs — anchoring those to the per-hotel
 * host is a separate change in the extractors/recipe-adapter, out of scope here.
 *
 * The assertions exercise only the two pure helpers, but importing
 * session-driver pulls in Playwright + the Supabase client at module load —
 * hence the ws-polyfill import below (same constraint as
 * login-confirmation.test.ts). No browser/Anthropic/DB call is made.
 */

// MUST be first: install the WebSocket shim before any supabase-importing
// module is evaluated. Importing session-driver.js pulls in modules that build
// the Supabase client at module load, which throws under Node 20 without
// native WebSocket support. (Same constraint as login-confirmation.test.ts.)
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoginUrl, resolveAllowedHost } from '../session-driver.js';

const FAMILY = 'https://login.opera-cloud.com/';

describe('resolveLoginUrl — per-hotel > family precedence', () => {
  test('uses the per-hotel URL when present', () => {
    assert.equal(
      resolveLoginUrl('https://hotel-a.opera-cloud.com/signin', FAMILY),
      'https://hotel-a.opera-cloud.com/signin',
    );
  });

  test('falls back to family when per-hotel is null (e.g. Choice Advantage)', () => {
    assert.equal(resolveLoginUrl(null, FAMILY), FAMILY);
  });

  test('falls back to family when per-hotel is undefined', () => {
    assert.equal(resolveLoginUrl(undefined, FAMILY), FAMILY);
  });

  test('falls back to family when per-hotel is empty or whitespace-only', () => {
    assert.equal(resolveLoginUrl('', FAMILY), FAMILY);
    assert.equal(resolveLoginUrl('   ', FAMILY), FAMILY);
    assert.equal(resolveLoginUrl('\t\n', FAMILY), FAMILY);
  });

  test('trims surrounding whitespace on the per-hotel URL', () => {
    assert.equal(resolveLoginUrl('  https://h.example.com/  ', FAMILY), 'https://h.example.com/');
  });

  test('normalizes a schemeless per-hotel URL to https:// (common data-entry input)', () => {
    // Without normalization the nav target ("hotel-a.opera-cloud.com") and the
    // allowedHost (derived via new URL()) would skew. normalizeUrl prepends the
    // scheme so both come from the same value.
    assert.equal(
      resolveLoginUrl('hotel-a.opera-cloud.com/signin', FAMILY),
      'https://hotel-a.opera-cloud.com/signin',
    );
    assert.equal(resolveLoginUrl('  hotel-b.mews.com  ', FAMILY), 'https://hotel-b.mews.com');
  });

  test('does NOT alter the family fallback (no-per-hotel path stays byte-identical)', () => {
    assert.equal(resolveLoginUrl(null, FAMILY), FAMILY);
    assert.equal(resolveLoginUrl('', 'https://choiceadvantage.com/login'), 'https://choiceadvantage.com/login');
  });
});

describe('resolveAllowedHost — anchored to the URL we actually log in at', () => {
  test('derives the host from the per-hotel login URL (subdomain not false-rejected)', () => {
    assert.equal(
      resolveAllowedHost('https://hotel-a.opera-cloud.com/signin', FAMILY),
      'hotel-a.opera-cloud.com',
    );
  });

  test('derives the family host when no per-hotel URL is in play', () => {
    assert.equal(resolveAllowedHost(FAMILY, FAMILY), 'login.opera-cloud.com');
  });

  test('keeps a non-default port in the host (host, not hostname)', () => {
    assert.equal(resolveAllowedHost('https://h.example.com:8443/x', FAMILY), 'h.example.com:8443');
  });

  test('falls back to the family host when the chosen login URL is unparseable (no throw)', () => {
    assert.equal(resolveAllowedHost('not a url', FAMILY), 'login.opera-cloud.com');
    assert.equal(resolveAllowedHost('', FAMILY), 'login.opera-cloud.com');
  });

  test('returns empty string (never throws) when BOTH URLs are unparseable — caller fails closed', () => {
    // The driver treats '' as a fail-closed signal (failed_restart) rather than
    // letting a downstream new URL() throw uncaught. Must NOT throw here.
    assert.doesNotThrow(() => resolveAllowedHost('not a url', 'also not a url'));
    assert.equal(resolveAllowedHost('not a url', 'also not a url'), '');
    assert.equal(resolveAllowedHost('', ''), '');
  });
});

describe('end-to-end precedence (login nav target + allowedHost agree)', () => {
  test('per-hotel hotel: per-hotel URL drives BOTH the login nav target and allowedHost', () => {
    const perHotel = 'https://tenant-123.cloudbeds.com/login';
    const url = resolveLoginUrl(perHotel, FAMILY);
    assert.equal(url, perHotel);
    assert.equal(resolveAllowedHost(url, FAMILY), 'tenant-123.cloudbeds.com');
  });

  test('schemeless per-hotel URL: nav target and allowedHost stay consistent (no skew)', () => {
    const url = resolveLoginUrl('tenant-123.cloudbeds.com/login', FAMILY);
    assert.equal(url, 'https://tenant-123.cloudbeds.com/login');
    // allowedHost is derived from the SAME (normalized) value — same host.
    assert.equal(resolveAllowedHost(url, FAMILY), 'tenant-123.cloudbeds.com');
  });

  test('Choice Advantage (no per-hotel URL): family navigation + family allowedHost, unchanged', () => {
    const url = resolveLoginUrl(null, FAMILY);
    assert.equal(url, FAMILY);
    assert.equal(resolveAllowedHost(url, FAMILY), 'login.opera-cloud.com');
  });

  test('two hotels on the SAME family resolve to DIFFERENT hosts', () => {
    const a = resolveLoginUrl('https://hotel-a.mews.com/', FAMILY);
    const b = resolveLoginUrl('https://hotel-b.mews.com/', FAMILY);
    assert.notEqual(a, b);
    assert.notEqual(resolveAllowedHost(a, FAMILY), resolveAllowedHost(b, FAMILY));
    assert.equal(resolveAllowedHost(a, FAMILY), 'hotel-a.mews.com');
    assert.equal(resolveAllowedHost(b, FAMILY), 'hotel-b.mews.com');
  });
});
