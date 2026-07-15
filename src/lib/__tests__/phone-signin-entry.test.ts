import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const entryHtml = readFileSync(
  join(process.cwd(), 'public/phone-signin-entry.html'),
  'utf8',
);
const createRoute = readFileSync(
  join(process.cwd(), 'src/app/api/auth/phone-pairing/route.ts'),
  'utf8',
);
const phonePage = readFileSync(
  join(process.cwd(), 'src/app/phone-signin/page.tsx'),
  'utf8',
);

describe('phone sign-in static bootstrap', () => {
  test('desktop QR targets the uninstrumented bootstrap instead of the Next page', () => {
    assert.match(createRoute, /phone-signin-entry\.html#pair=/);
  });

  test('clears the fragment before loading the instrumented phone page', () => {
    const clearAt = entryHtml.indexOf("history.replaceState(null, '', location.pathname + location.search)");
    const navigateAt = entryHtml.indexOf("location.replace('/phone-signin')");
    assert.ok(clearAt > 0);
    assert.ok(navigateAt > clearAt);
  });

  test('contains no analytics, external scripts, network calls, or token storage', () => {
    assert.doesNotMatch(entryHtml, /sentry|analytics|<script\s+src=|\bfetch\s*\(/i);
    assert.doesNotMatch(entryHtml, /localStorage|sessionStorage|document\.cookie/i);
    assert.match(entryHtml, /connect-src 'none'/);
  });

  test('routes iPhone non-Safari users to a Safari copy handoff before claim', () => {
    assert.match(entryHtml, /CriOS\|FxiOS\|EdgiOS/);
    assert.match(entryHtml, /Open this link in Safari/);
    assert.match(entryHtml, /Copy secure link for Safari/);
    assert.match(entryHtml, /ios && !safari/);
  });

  test('accepts only exact 256-bit hexadecimal pairing tokens', () => {
    assert.match(entryHtml, /\^\[0-9a-f\]\{64\}\$/);
  });

  test('rehydrates providers after the verified MFA token is issued', () => {
    assert.match(
      phonePage,
      /pendingHandoffRef\.current = null;[\s\S]*window\.location\.replace\('\/phone-signin'\)/,
    );
    assert.match(
      phonePage,
      /accessTokenHasMfaVerified\(existingAuth\.session\.access_token\)/,
    );
  });
});
