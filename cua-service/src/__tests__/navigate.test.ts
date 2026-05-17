/**
 * Regression tests for safeGoto / validateNavigationUrl in
 * cua-service/src/browser-utils/navigate.ts.
 *
 * Closes Codex 2026-05-16 P1 (Pattern B): `page.goto` was called from 5
 * sites with inconsistent URL guards. These tests pin the new
 * single-entry-point helper so:
 *   - off-domain navigation in an authenticated PMS session is refused
 *   - SSRF via private IPs is refused
 *   - non-http(s) schemes (javascript:, file:, etc.) are refused
 *   - malformed URLs are refused
 *
 * Run via: cd cua-service && npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNavigationUrl,
  isPrivateOrLocalHost,
  hostsAreSameSite,
  normalizeUrl,
  UnsafeNavigationError,
} from '../browser-utils/navigate.js';

const PMS = 'app.choiceadvantage.com';

describe('validateNavigationUrl — off-site refusal (Pattern B)', () => {
  test('refuses off-domain URL when allowedHost is set', () => {
    assert.throws(
      () => validateNavigationUrl('https://attacker.example/collect', PMS),
      (err: Error) => err instanceof UnsafeNavigationError && err.reason === 'off_site',
    );
  });

  test('allows same-site URL', () => {
    assert.doesNotThrow(() => validateNavigationUrl('https://app.choiceadvantage.com/dashboard', PMS));
  });

  test('allows same-registrable-domain URL (subdomain swap)', () => {
    // app.foo.com vs reports.foo.com → both register to foo.com → same-site.
    assert.doesNotThrow(() => validateNavigationUrl('https://reports.choiceadvantage.com/x', PMS));
  });

  test('multi-part-suffix safety: blocks sibling ccTLD hosts (foo.co.uk vs bar.co.uk)', () => {
    assert.throws(
      () => validateNavigationUrl('https://attacker.co.uk/x', 'legit.co.uk'),
      (err: Error) => err instanceof UnsafeNavigationError && err.reason === 'off_site',
      'must NOT treat foo.co.uk and bar.co.uk as same-site (registrable-domain trims back 3 labels for ccTLD)',
    );
  });

  test('skips off-site check when allowedHost is null (login startUrl establishes the trust anchor)', () => {
    assert.doesNotThrow(() => validateNavigationUrl('https://any-pms-vendor.example/login', null));
  });
});

describe('validateNavigationUrl — scheme refusal', () => {
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'chrome://settings',
    'ftp://files.example/x',
  ]) {
    test(`refuses ${url.slice(0, 30)}…`, () => {
      assert.throws(
        () => validateNavigationUrl(url, null),
        (err: Error) => err instanceof UnsafeNavigationError && err.reason === 'scheme',
        'only http(s) schemes are allowed',
      );
    });
  }

  test('allows https://', () => {
    assert.doesNotThrow(() => validateNavigationUrl('https://api.example.com/x', null));
  });

  test('allows http:// (PMS portals occasionally lack TLS on internal subdomains)', () => {
    assert.doesNotThrow(() => validateNavigationUrl('http://api.example.com/x', null));
  });
});

describe('validateNavigationUrl — private-IP / loopback refusal (SSRF blocker)', () => {
  for (const url of [
    'http://127.0.0.1/admin',
    'http://localhost/admin',
    'http://10.1.2.3/internal',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data', // AWS cloud metadata!
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fe80::1]/x',
  ]) {
    test(`refuses ${url}`, () => {
      assert.throws(
        () => validateNavigationUrl(url, null),
        (err: Error) => err instanceof UnsafeNavigationError && err.reason === 'private_or_local_ip',
      );
    });
  }

  test('allows public IP', () => {
    assert.doesNotThrow(() => validateNavigationUrl('http://8.8.8.8/x', null));
  });
});

describe('validateNavigationUrl — malformed refusal', () => {
  for (const url of ['', 'not a url', 'https://', '://nohost', 'http:///path']) {
    test(`refuses ${JSON.stringify(url)}`, () => {
      assert.throws(
        () => validateNavigationUrl(url, null),
        (err: Error) => err instanceof UnsafeNavigationError,
      );
    });
  }
});

describe('helpers — hostsAreSameSite / isPrivateOrLocalHost / normalizeUrl', () => {
  test('hostsAreSameSite trims 3 labels for known multi-part suffixes', () => {
    assert.equal(hostsAreSameSite('foo.com.au', 'bar.com.au'), false);
    assert.equal(hostsAreSameSite('foo.example.com.au', 'bar.example.com.au'), true);
  });

  test('hostsAreSameSite trims 2 labels for simple TLDs', () => {
    assert.equal(hostsAreSameSite('a.foo.com', 'b.foo.com'), true);
    assert.equal(hostsAreSameSite('foo.com', 'bar.com'), false);
  });

  test('isPrivateOrLocalHost covers the AWS metadata IP (most common cloud-side SSRF target)', () => {
    assert.equal(isPrivateOrLocalHost('169.254.169.254'), true);
  });

  test('isPrivateOrLocalHost rejects IPv4 strings out of 0-255 range as not-private (caller must reject as malformed)', () => {
    // 999.999.999.999 isn't a valid IP; validateNavigationUrl falls through
    // to URL parsing for those.
    assert.equal(isPrivateOrLocalHost('999.999.999.999'), false);
  });

  test('normalizeUrl prepends https when scheme missing', () => {
    assert.equal(normalizeUrl('example.com/x'), 'https://example.com/x');
  });

  test('normalizeUrl does NOT prepend https to javascript: (validation catches it downstream)', () => {
    // The crucial property: we never accidentally turn `javascript:alert(1)`
    // into `https://javascript:alert(1)` (which would parse as a host).
    const out = normalizeUrl('javascript:alert(1)');
    assert.equal(out.startsWith('https://'), false);
  });
});
