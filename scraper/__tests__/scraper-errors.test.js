/**
 * Tests for scraper/scraper-errors.js
 *
 * Run: node --test scraper/__tests__/scraper-errors.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ScraperError, ERROR_CODES } = require('../scraper-errors');

describe('ScraperError', () => {
  test('constructs with code, message, page, and diagnostics', () => {
    const err = new ScraperError(
      ERROR_CODES.SELECTOR_MISS,
      'HK link not found',
      { page: 'csv', diagnostics: { tried: 7 } },
    );
    assert.equal(err.name, 'ScraperError');
    assert.equal(err.code, 'selector_miss');
    assert.equal(err.message, 'HK link not found');
    assert.equal(err.page, 'csv');
    assert.deepEqual(err.diagnostics, { tried: 7 });
    assert.ok(err instanceof Error);
  });

  test('defaults page and diagnostics to null when not provided', () => {
    const err = new ScraperError(ERROR_CODES.UNKNOWN, 'something');
    assert.equal(err.page, null);
    assert.equal(err.diagnostics, null);
  });
});

describe('ERROR_CODES', () => {
  test('exposes all expected codes', () => {
    const expected = [
      'LOGIN_FAILED', 'SESSION_EXPIRED',
      'SELECTOR_MISS', 'PARSE_ERROR', 'VALIDATION_FAILED',
      'TIMEOUT', 'CA_UNREACHABLE',
      'CSV_DOWNLOAD_FAILED', 'CSV_BAD_CONTENT', 'CSV_VALIDATION_FAILED',
      'UNKNOWN',
    ];
    for (const key of expected) {
      assert.ok(key in ERROR_CODES, `missing ERROR_CODES.${key}`);
      assert.equal(typeof ERROR_CODES[key], 'string');
    }
  });

  test('is frozen — assignment is a no-op (silent in non-strict mode)', () => {
    // Object.freeze means assignment is silently ignored in non-strict
    // mode and throws in strict. Either way, the value must not change.
    try {
      ERROR_CODES.NEW_CODE = 'should_not_take';
    } catch { /* strict mode throws — also fine */ }
    assert.equal(ERROR_CODES.NEW_CODE, undefined);
    // Can't redefine an existing key either.
    try {
      ERROR_CODES.LOGIN_FAILED = 'tampered';
    } catch { /* fine */ }
    assert.equal(ERROR_CODES.LOGIN_FAILED, 'login_failed');
  });

  test('values are snake_case strings used in scraper_status.errorCode', () => {
    assert.equal(ERROR_CODES.LOGIN_FAILED, 'login_failed');
    assert.equal(ERROR_CODES.SESSION_EXPIRED, 'session_expired');
    assert.equal(ERROR_CODES.CSV_DOWNLOAD_FAILED, 'csv_download_failed');
  });
});
