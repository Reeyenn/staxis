/**
 * trustCookieOptions host → cookie-domain scoping (2026-07-13).
 *
 * Host-only trust cookies split "this computer is remembered" between
 * getstaxis.com and www.getstaxis.com — the same person got re-prompted
 * for an OTP code just for arriving via the other hostname, minting a
 * duplicate trusted_devices row each time. Production hosts now scope the
 * cookie to `.getstaxis.com`; previews (*.vercel.app is on the Public
 * Suffix List) and localhost must stay host-only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { trustCookieOptions } from '@/lib/trusted-device';

describe('trustCookieOptions — domain scoping', () => {
  test('apex production host → .getstaxis.com', () => {
    assert.equal(trustCookieOptions('getstaxis.com').domain, '.getstaxis.com');
  });

  test('www production host → .getstaxis.com (shares trust with apex)', () => {
    assert.equal(trustCookieOptions('www.getstaxis.com').domain, '.getstaxis.com');
  });

  test('host header with port and mixed case still matches', () => {
    assert.equal(trustCookieOptions('WWW.GetStaxis.com:443').domain, '.getstaxis.com');
  });

  test('vercel preview host stays host-only (no domain attribute)', () => {
    assert.equal(
      trustCookieOptions('staxis-git-fix-x-reeyenns-projects.vercel.app').domain,
      undefined,
    );
  });

  test('localhost stays host-only', () => {
    assert.equal(trustCookieOptions('localhost:3000').domain, undefined);
  });

  test('missing host stays host-only', () => {
    assert.equal(trustCookieOptions(null).domain, undefined);
    assert.equal(trustCookieOptions(undefined).domain, undefined);
  });

  test('lookalike domain does NOT get scoped (evilgetstaxis.com)', () => {
    assert.equal(trustCookieOptions('evilgetstaxis.com').domain, undefined);
  });

  test('other option fields unchanged', () => {
    const opts = trustCookieOptions('getstaxis.com');
    assert.equal(opts.name, 'staxis_device');
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.path, '/');
    assert.equal(opts.maxAge, 400 * 24 * 60 * 60);
  });
});
