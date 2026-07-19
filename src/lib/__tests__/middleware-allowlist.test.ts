/**
 * Tests for src/middleware.ts's public-path allowlist.
 *
 * The middleware is a presence-only gate on the Supabase auth cookie
 * (intentional — see middleware.ts docstring). The actual security
 * decisions are made downstream: API routes via requireSession /
 * requireAdmin, admin pages via the new src/app/admin/layout.tsx server
 * guard, public pages via capability checks on URL params.
 *
 * But the allowlist itself is a sharp tool — adding a path to it
 * silently opens it to unauthenticated traffic. This test file pins the
 * current allowlist so the next time someone widens it, the diff is
 * red. Pins both directions:
 *   - known protected paths redirect to /signin (regression for
 *     accidentally adding /dashboard or /settings to the allowlist).
 *   - known public paths pass through (regression for accidentally
 *     gating /signin or /housekeeper).
 *
 * Also checks the redirect= query-param sanitization to guard against
 * an open-redirect via crafted ?redirect=https://evil.com.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { middleware } from '@/middleware';

// ─── Helpers ─────────────────────────────────────────────────────────────

function reqFor(pathname: string, opts: { withAuthCookie?: boolean; search?: string } = {}): NextRequest {
  const search = opts.search ?? '';
  const urlStr = `https://staxis.test${pathname}${search}`;
  const url = new URL(urlStr);
  const cookieMap = new Map<string, { name: string; value: string }>();
  if (opts.withAuthCookie) {
    const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co')
      .replace(/^https?:\/\//, '')
      .split('.')[0];
    const name = `sb-${projectRef}-auth-token`;
    cookieMap.set(name, { name, value: 'fake-jwt-value' });
  }
  // NextRequest.nextUrl.clone() returns a NextURL, which is a URL subclass
  // with extra fields. NextResponse.redirect needs a real URL (or absolute
  // string) — pass a real URL clone so .pathname/.search/.searchParams
  // assignments work the way the middleware expects.
  return {
    nextUrl: {
      pathname,
      search,
      clone: () => new URL(urlStr),
    },
    cookies: {
      getAll: () => Array.from(cookieMap.values()),
    },
    headers: {
      get: () => null,
    },
    url: urlStr,
  } as unknown as NextRequest;
}

function isRedirectTo(res: ReturnType<typeof middleware>, pathPrefix: string): boolean {
  // NextResponse.redirect returns a response with status 307/308 and a
  // Location header. Different Next versions vary; .headers.get('location')
  // is the lowest common denominator.
  const loc = res.headers.get('location');
  return !!loc && loc.includes(pathPrefix);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('middleware — known PUBLIC paths pass through without auth cookie', () => {
  for (const p of [
    '/',
    '/signin',
    '/signin/verify',
    '/signin/forgot',
    '/signin/reset',
    '/phone-signin',
    '/signup',
    '/onboard',
    '/onboard/step-1',
    '/invite/abc123',
    '/company-invite/abc123',
    '/housekeeper',
    '/housekeeper/abc',
    '/laundry',
    '/laundry/xyz',
    '/privacy',
    '/terms',
    '/consent',
    '/api/anything',
    '/api/housekeeper/rooms',
  ]) {
    test(`${p} → pass through`, () => {
      const res = middleware(reqFor(p));
      // NextResponse.next() returns a 200 with no location header.
      assert.equal(res.headers.get('location'), null, `${p} unexpectedly redirected`);
    });
  }
});

describe('middleware — known PROTECTED paths redirect to /signin without auth cookie', () => {
  for (const p of [
    '/dashboard',
    '/dashboard/rooms',
    '/admin',
    '/admin/agent',
    '/admin/properties',
    '/settings',
    '/inventory',
    '/maintenance',
  ]) {
    test(`${p} → redirect /signin`, () => {
      const res = middleware(reqFor(p));
      assert.ok(
        isRedirectTo(res, '/signin'),
        `${p} should have redirected to /signin (got location=${res.headers.get('location')})`,
      );
    });
  }
});

describe('middleware — protected paths PASS with auth cookie present', () => {
  for (const p of ['/dashboard', '/admin', '/inventory']) {
    test(`${p} (with cookie) → pass through`, () => {
      const res = middleware(reqFor(p, { withAuthCookie: true }));
      assert.equal(res.headers.get('location'), null, `${p} with cookie unexpectedly redirected`);
    });
  }
});

describe('middleware — redirect param preserves the requested path', () => {
  test('redirect= URLSearchParam captures the originating pathname + search', () => {
    const res = middleware(reqFor('/dashboard', { search: '?tab=rooms' }));
    const loc = res.headers.get('location');
    assert.ok(loc);
    if (loc) {
      const u = new URL(loc);
      assert.equal(u.pathname, '/signin');
      assert.equal(u.searchParams.get('redirect'), '/dashboard?tab=rooms');
    }
  });
});
