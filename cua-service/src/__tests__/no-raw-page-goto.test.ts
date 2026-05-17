/**
 * CI guard for Pattern B: every navigation in cua-service must flow through
 * `safeGoto`. If `page.goto(` reappears anywhere in cua-service/src/ outside
 * `browser-utils/navigate.ts`, this test fails the build.
 *
 * Why a grep test instead of an ESLint rule: navigation is a small enough
 * surface that a grep is unambiguous; no AST parsing needed; works for
 * .ts and .js alike; runs in CI with zero extra tooling.
 *
 * If you legitimately need a new navigation site:
 *   - Don't disable this test.
 *   - Add the call to navigate.ts as a new helper (or use safeGoto directly
 *     from your file). Update the EXCEPTIONS list below ONLY if the new
 *     file is itself a low-level navigation primitive belonging to
 *     browser-utils/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// cua-service is CommonJS (no "type": "module" in package.json), so use
// __dirname. Stays robust across `tsx --test`, `node --test` once compiled,
// and any future ESM migration (tsx provides __dirname under both).
const CUA_SRC = join(__dirname, '..');

// Files allowed to call page.goto directly. Only the helper itself.
const EXCEPTIONS = new Set<string>([
  'browser-utils/navigate.ts',
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      // Skip the test directory itself (test files often grep against
      // page.goto in regex literals) and dist/.
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue;
      await walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

// `page.goto(` pattern. Includes variants like `args.page.goto(` so a
// rename can't sneak past. Matches identifier.goto( only — won't false-
// positive on string contents because strings use `'` or `"`.
const GOTO_REGEX = /\b\w+\.page\.goto\s*\(|\bpage\.goto\s*\(/;

test('no raw page.goto() outside navigate.ts (Pattern B regression guard)', async () => {
  const files = await walk(CUA_SRC);
  const offenders: { file: string; line: number; text: string }[] = [];

  for (const file of files) {
    const rel = relative(CUA_SRC, file);
    if (EXCEPTIONS.has(rel)) continue;
    const src = await readFile(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment-only lines so historical comments referencing
      // `page.goto` (e.g. "We used to call page.goto here") don't trip
      // the guard.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (GOTO_REGEX.test(line)) {
        offenders.push({ file: rel, line: i + 1, text: line.trim() });
      }
    }
  }

  if (offenders.length > 0) {
    const detail = offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
    assert.fail(
      `Found raw page.goto() call(s) outside browser-utils/navigate.ts. ` +
      `Every navigation must go through safeGoto() so the scheme / private-IP / ` +
      `allowed-host guards apply. Offenders:\n${detail}`,
    );
  }
});
