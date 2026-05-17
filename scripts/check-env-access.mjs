#!/usr/bin/env node
// CI guard — fails when any file outside the canonical env modules reads
// `process.env.X` directly. Forces new code to import { env } from '@/lib/env'
// (main app), './env.js' (cua-service), or './env' (scraper).
//
// Exempt files (allowed to read process.env directly):
//   - The env modules themselves: src/lib/env.ts, src/lib/env-client.ts,
//     cua-service/src/env.ts, scraper/env.js
//   - Next.js bootstrap files that load BEFORE the env module imports cleanly:
//     next.config.ts, sentry.*.config.ts, src/instrumentation.ts
//   - Test files (path contains __tests__): tests mutate process.env to set
//     up fixtures, which is legitimate
//   - The ML service is Python, not scanned here

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const SCAN_DIRS = ['src', 'cua-service/src', 'scraper'];

const EXEMPT_FILES = new Set([
  'src/lib/env.ts',
  'src/lib/env-client.ts',
  'cua-service/src/env.ts',
  'scraper/env.js',
  'next.config.ts',
  'sentry.server.config.ts',
  'sentry.client.config.ts',
  'sentry.edge.config.ts',
  'src/instrumentation.ts',
]);

const SCAN_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// process.env.X access pattern. \b avoids matching things like
// "myprocess.env" or "process_env".
const PROCESS_ENV_RE = /\bprocess\.env\.[A-Z_][A-Z0-9_]*/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist'
      || entry === 'build' || entry === '.git' || entry === 'coverage'
      || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (SCAN_EXTS.some(e => full.endsWith(e))) yield full;
  }
}

const violations = [];
for (const dir of SCAN_DIRS) {
  const abs = join(ROOT, dir);
  try { statSync(abs); } catch { continue; }
  for (const file of walk(abs)) {
    const rel = relative(ROOT, file);
    if (EXEMPT_FILES.has(rel)) continue;
    if (rel.includes('__tests__')) continue;  // tests can mutate process.env

    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(PROCESS_ENV_RE);
      if (!matches) continue;
      // Skip lines that look like comments referencing the pattern (not actual reads)
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      for (const m of matches) {
        violations.push({ file: rel, line: i + 1, snippet: lines[i].trim(), match: m });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`✓ check-env-access: scanned ${SCAN_DIRS.join(', ')}, no direct process.env reads outside canonical env modules.`);
  process.exit(0);
}

console.error(`✗ check-env-access: ${violations.length} direct process.env read(s) outside canonical env modules:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.match}`);
  console.error(`    ${v.snippet}`);
}
console.error('\nFix: import { env } from "@/lib/env" (main app), "./env.js" (cua-service), or "./env" (scraper).');
console.error('Required exemptions (env modules + Next.js bootstrap files) are listed in scripts/check-env-access.mjs.\n');
process.exit(1);
