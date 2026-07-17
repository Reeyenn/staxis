/**
 * Middleware behavior tests.
 *
 * The middleware is the F-04 edge gate that closes the flash-of-protected-HTML
 * gap. It does cheap, cookie-presence-only redirects — no Supabase
 * round-trip, no JWT decoding. These tests pin the matcher logic so the
 * next time someone tweaks the allowlist they get a red diff instead of
 * a silent bug (a wrongly-public path → cross-tenant data leak; a wrongly-
 * protected SMS path → broken housekeeper link in the wild).
 *
 * NEXT_PUBLIC_SUPABASE_URL is set by the test command's env block in
 * package.json — at parse time of the middleware module, that resolves
 * the project-ref to "placeholder" and the cookie prefix to
 * "sb-placeholder-auth-token".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';

function reqFor(pathname: string, opts?: { cookie?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts?.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`https://staxis.test${pathname}`, { headers });
}

describe('middleware — public allowlist', () => {
  for (const path of [
    '/',
    '/signin',
    '/signin/verify',
    '/signin/forgot',
    '/signin/reset',
    '/phone-signin',
    '/signup',
    '/onboard',
    '/onboard/property',
    '/join',
    '/invite/abc123',
    '/privacy',
    '/terms',
    '/consent',
    '/housekeeper',
    '/housekeeper/staff-uuid',
    '/laundry',
    '/laundry/staff-uuid',
    '/api/anything',
    '/api/housekeeper/rooms',
  ]) {
    test(`${path} passes through with no cookie`, () => {
      const res = middleware(reqFor(path));
      // NextResponse.next() returns a non-redirect response; redirects are 307/308.
      assert.notEqual(res.status, 307);
      assert.notEqual(res.status, 308);
      assert.equal(res.headers.get('location'), null);
    });
  }
});

describe('middleware — protected paths', () => {
  for (const path of [
    '/dashboard',
    '/admin',
    '/admin/agent',
    '/inventory',
    '/inventory/analytics',
    '/maintenance',
    '/front-desk',
    '/staff',
    '/settings',
    '/settings/staff',
    '/property-selector',
    '/chat',
  ]) {
    test(`${path} with no auth cookie → redirect to /signin`, () => {
      const res = middleware(reqFor(path));
      assert.ok(
        res.status === 307 || res.status === 308,
        `expected redirect status, got ${res.status}`,
      );
      const loc = res.headers.get('location');
      assert.ok(loc, 'expected location header');
      const url = new URL(loc!);
      assert.equal(url.pathname, '/signin');
      assert.equal(url.searchParams.get('redirect'), path);
    });

    test(`${path} with auth cookie → passes through`, () => {
      const res = middleware(
        reqFor(path, { cookie: 'sb-placeholder-auth-token=eyJfakeJWT' }),
      );
      assert.notEqual(res.status, 307);
      assert.notEqual(res.status, 308);
      assert.equal(res.headers.get('location'), null);
    });
  }
});

describe('middleware — chunked cookies', () => {
  test('chunked auth token (sb-…-auth-token.0) is recognized', () => {
    const res = middleware(
      reqFor('/dashboard', { cookie: 'sb-placeholder-auth-token.0=chunkA' }),
    );
    assert.notEqual(res.status, 307);
    assert.notEqual(res.status, 308);
  });

  test('only chunk .1 present (chunk .0 expired/missing) still recognized', () => {
    // Defensive: any chunk being present should count. The browser client
    // handles missing-chunk recovery; the middleware shouldn't add its own
    // chunk-completeness check.
    const res = middleware(
      reqFor('/dashboard', { cookie: 'sb-placeholder-auth-token.1=chunkB' }),
    );
    assert.notEqual(res.status, 307);
    assert.notEqual(res.status, 308);
  });

  test('unrelated cookie does NOT count as auth', () => {
    const res = middleware(
      reqFor('/dashboard', { cookie: 'staxis_device=deviceTrustToken' }),
    );
    assert.ok(res.status === 307 || res.status === 308);
  });
});

describe('middleware — redirect preserves query string', () => {
  test('?foo=bar carries through to redirect param', () => {
    const res = middleware(reqFor('/dashboard?foo=bar&baz=1'));
    const loc = res.headers.get('location');
    assert.ok(loc);
    const url = new URL(loc!);
    assert.equal(url.pathname, '/signin');
    assert.equal(url.searchParams.get('redirect'), '/dashboard?foo=bar&baz=1');
  });
});
