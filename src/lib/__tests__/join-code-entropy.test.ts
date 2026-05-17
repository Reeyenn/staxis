/**
 * Regression tests for join-code entropy + CSPRNG source.
 *
 * Closes security review finding 2026-05-16 (Pattern G):
 * `generateJoinCode` used Math.random() with a 4-char suffix (~20 bits
 * effective entropy). Brute-forceable from a single IP without a rate
 * limit. Fix: switch to node:crypto's randomInt + bump suffix to 10
 * chars (~50 bits). Combined with the new IP-keyed rate limit on
 * /api/onboard/wizard, brute-force is no longer realistic.
 *
 * These tests pin both halves of the fix:
 *   1. Source code must not contain Math.random in join-codes.ts
 *   2. Generated codes must satisfy the post-fix shape (prefix-suffix
 *      where suffix length matches SUFFIX_LENGTH).
 *
 * If a future contributor swaps the RNG back, the source-grep test
 * fails the build with a pointer to this file.
 *
 * Run via: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateJoinCode } from '../join-codes';

const JOIN_CODES_SRC = join(process.cwd(), 'src', 'lib', 'join-codes.ts');

describe('join-codes: Math.random regression guard (Pattern G)', () => {
  test('src/lib/join-codes.ts must NOT use Math.random for token sampling', async () => {
    const src = await readFile(JOIN_CODES_SRC, 'utf8');
    // Allow Math.random in COMMENTS (the file-header explains why we removed it).
    // The check is "any non-comment line containing Math.random".
    const offending = src.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
      return /\bMath\.random\b/.test(line);
    });
    if (offending.length > 0) {
      assert.fail(
        `Math.random reappeared in src/lib/join-codes.ts. Use node:crypto's randomInt instead. ` +
        `Pattern G — capability tokens must be CSPRNG-sourced. Offending lines:\n` +
        offending.map((l) => `  ${l.trim()}`).join('\n'),
      );
    }
  });

  test('src/lib/join-codes.ts imports randomInt from node:crypto', async () => {
    const src = await readFile(JOIN_CODES_SRC, 'utf8');
    assert.match(
      src,
      /import\s*\{[^}]*\brandomInt\b[^}]*\}\s*from\s*['"]node:crypto['"]/,
      'expected `import { randomInt } from "node:crypto"` — CSPRNG source for char selection',
    );
  });
});

describe('generateJoinCode: shape + entropy', () => {
  test('produces PREFIX-SUFFIX where suffix is ≥ 10 chars from the documented alphabet', () => {
    const code = generateJoinCode('Beauford Inn');
    // Format: 4-letter prefix from hotel name + dash + 10-char alphanum.
    assert.match(code, /^BEAU-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
  });

  test('falls back to random 4-letter prefix when no hotel name supplied', () => {
    const code = generateJoinCode(null);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
  });

  test('1000 generated codes show no obvious duplicate-burst pattern', () => {
    // Cheap sanity check: 1000 codes shouldn't collide. With ~50 bits of
    // suffix entropy the expected collision count over 1000 draws is
    // vanishingly small. A duplicate here would indicate the RNG is
    // broken (e.g. unseeded, fixed seed). Not a strict cryptographic
    // proof; just a smoke test.
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const code = generateJoinCode(null);
      if (seen.has(code)) collisions++;
      seen.add(code);
    }
    assert.equal(collisions, 0, `expected zero collisions in 1000 draws; got ${collisions}`);
  });
});
