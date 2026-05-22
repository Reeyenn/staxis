/**
 * scraper/__tests__/disk-rotation.test.js
 *
 * Run via: node --test scraper/__tests__/disk-rotation.test.js
 *
 * Disk hygiene unit test for F1 — purgeStaleDiagnostics deletes only the
 * known diagnostic filenames and only when older than the cutoff. We don't
 * import scraper.js directly because it triggers env-loading and Supabase
 * client creation at module load; instead we replicate the function under
 * test (kept in lockstep with scraper.js).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIAGNOSTIC_PATTERNS = [
  /^csv-report-form\.png$/,
  /^csv-download-fail\.png$/,
  /^csv-bad-content\.png$/,
  /^csv-error-.*\.png$/,
  /^csv-form-dump\.html$/,
  /^csv-bad-content\.txt$/,
  /^login-debug\.png$/,
  /^DEBUG-.*$/,
];

function purgeStaleDiagnostics(dir, maxAgeMs) {
  let deleted = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!DIAGNOSTIC_PATTERNS.some(re => re.test(entry.name))) continue;
      const full = path.join(dir, entry.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          deleted++;
        }
      } catch { /* ignore */ }
    }
  } catch { return 0; }
  return deleted;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-purge-test-'));
}

function touch(dir, name, ageMs = 0) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'x');
  if (ageMs > 0) {
    const past = (Date.now() - ageMs) / 1000;
    fs.utimesSync(full, past, past);
  }
}

describe('purgeStaleDiagnostics', () => {
  test('deletes stale diagnostic files older than cutoff', () => {
    const dir = makeTempDir();
    const dayMs = 24 * 60 * 60 * 1000;
    touch(dir, 'csv-form-dump.html', dayMs * 2);
    touch(dir, 'csv-bad-content.txt', dayMs * 2);
    touch(dir, 'csv-error-morning.png', dayMs * 2);
    touch(dir, 'login-debug.png', dayMs * 2);

    const deleted = purgeStaleDiagnostics(dir, dayMs);
    assert.equal(deleted, 4);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('keeps fresh diagnostic files under cutoff', () => {
    const dir = makeTempDir();
    const dayMs = 24 * 60 * 60 * 1000;
    touch(dir, 'csv-form-dump.html', 0); // just now
    touch(dir, 'csv-error-evening.png', dayMs / 2); // 12h old

    const deleted = purgeStaleDiagnostics(dir, dayMs);
    assert.equal(deleted, 0);
    assert.equal(fs.readdirSync(dir).length, 2);
  });

  test('ignores non-diagnostic files even when stale', () => {
    const dir = makeTempDir();
    const dayMs = 24 * 60 * 60 * 1000;
    touch(dir, 'package.json', dayMs * 30);
    touch(dir, 'scraper.js', dayMs * 30);
    touch(dir, '.session-abc.json', dayMs * 30);
    touch(dir, 'random-other.png', dayMs * 30);

    const deleted = purgeStaleDiagnostics(dir, dayMs);
    assert.equal(deleted, 0);
    assert.equal(fs.readdirSync(dir).length, 4);
  });

  test('mixed old + fresh: only stale diagnostics removed', () => {
    const dir = makeTempDir();
    const dayMs = 24 * 60 * 60 * 1000;
    touch(dir, 'csv-form-dump.html', dayMs * 3); // stale, kill
    touch(dir, 'csv-error-fresh.png', 0); // keep
    touch(dir, 'scraper.js', dayMs * 30); // keep (not a diagnostic)

    const deleted = purgeStaleDiagnostics(dir, dayMs);
    assert.equal(deleted, 1);
    const remaining = fs.readdirSync(dir).sort();
    assert.deepEqual(remaining, ['csv-error-fresh.png', 'scraper.js']);
  });

  test('handles DEBUG- prefixed files (F10 gated dump pattern)', () => {
    const dir = makeTempDir();
    const dayMs = 24 * 60 * 60 * 1000;
    touch(dir, 'DEBUG-csv-snapshot.html', dayMs * 2);
    touch(dir, 'DEBUG-anything.txt', dayMs * 2);

    const deleted = purgeStaleDiagnostics(dir, dayMs);
    assert.equal(deleted, 2);
  });

  test('returns 0 on missing directory without throwing', () => {
    const result = purgeStaleDiagnostics('/path/that/does/not/exist', 1000);
    assert.equal(result, 0);
  });
});
