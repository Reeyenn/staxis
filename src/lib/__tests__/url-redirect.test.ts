/**
 * Tests for the safeRedirect URL-param validator.
 *
 * safeRedirect is the gate between the middleware's `?redirect=<original>`
 * param and the signin/verify pages' `router.replace(...)` call. Its job is
 * to reject open-redirect attacks (protocol-relative + absolute URLs) and
 * loops back to auth pages. These tests pin the boundary conditions so a
 * future "let's also allow //…" edit can't sneak past review.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { safeRedirect } from '@/lib/url-redirect';

const FALLBACK = '/property-selector';

describe('safeRedirect — empty / null / undefined → fallback', () => {
  test('null returns fallback', () => {
    assert.equal(safeRedirect(null, FALLBACK), FALLBACK);
  });
  test('undefined returns fallback', () => {
    assert.equal(safeRedirect(undefined, FALLBACK), FALLBACK);
  });
  test('empty string returns fallback', () => {
    assert.equal(safeRedirect('', FALLBACK), FALLBACK);
  });
});

describe('safeRedirect — valid same-origin paths pass through', () => {
  for (const path of [
    '/dashboard',
    '/admin/agent',
    '/inventory/analytics',
    '/maintenance',
    '/settings/staff',
    '/admin/agent?x=1',
    '/admin/agent?x=1&y=2',
    '/dashboard#section',
    '/',
  ]) {
    test(`${path} returns as-is`, () => {
      assert.equal(safeRedirect(path, FALLBACK), path);
    });
  }
});

describe('safeRedirect — open-redirect attacks blocked', () => {
  test('protocol-relative //evil.com blocked', () => {
    assert.equal(safeRedirect('//evil.com/path', FALLBACK), FALLBACK);
  });
  test('protocol-relative //evil.com/looks/like/our/path blocked', () => {
    assert.equal(safeRedirect('//evil.com/admin/agent', FALLBACK), FALLBACK);
  });
  test('absolute https URL blocked', () => {
    assert.equal(safeRedirect('https://evil.com/path', FALLBACK), FALLBACK);
  });
  test('absolute http URL blocked', () => {
    assert.equal(safeRedirect('http://evil.com/path', FALLBACK), FALLBACK);
  });
  test('value with embedded :// blocked even if it starts with /', () => {
    // /https://evil.com would technically be a valid relative path but
    // smells like an exploit attempt — defensive reject.
    assert.equal(safeRedirect('/redirect?to=https://evil.com', FALLBACK), FALLBACK);
  });
  test('path not starting with / blocked', () => {
    assert.equal(safeRedirect('admin/agent', FALLBACK), FALLBACK);
  });
  test('javascript: scheme blocked (defensive)', () => {
    assert.equal(safeRedirect('javascript:alert(1)', FALLBACK), FALLBACK);
  });
});

describe('safeRedirect — auth-page loop guard', () => {
  for (const blocked of [
    '/signin',
    '/signin/verify',
    '/signin/forgot',
    '/signin/reset',
    '/signup',
    '/signup?code=abc',
    '/onboard',
    '/onboard/property',
    '/join',
    '/invite/abc-token',
  ]) {
    test(`${blocked} returns fallback (would loop)`, () => {
      assert.equal(safeRedirect(blocked, FALLBACK), FALLBACK);
    });
  }
  test('prefix-only match — /signinfoo is NOT a signin loop', () => {
    // /signin is blocked; /signinfoo (no slash separator) is a different
    // path entirely and shouldn't be falsely matched.
    assert.equal(safeRedirect('/signinfoo', FALLBACK), '/signinfoo');
  });
});

describe('safeRedirect — fallback can be customized', () => {
  test('different fallback string respected', () => {
    assert.equal(safeRedirect(null, '/dashboard'), '/dashboard');
    assert.equal(safeRedirect('//evil.com', '/x'), '/x');
  });
});
