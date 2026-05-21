#!/usr/bin/env node
// audit-force-dynamic — fails the build if any src/app/api/**/route.ts
// lacks `export const dynamic = 'force-dynamic'`.
//
// F-NEW-01 in the core-web/auth/RLS security plan. Without the directive
// Next.js MAY statically render a route handler, which (a) caches user-
// specific responses for sensitive GETs, and (b) silently no-ops SMS-
// firing POSTs on retry.
//
// Allowlist below is for routes where the directive intentionally doesn't
// apply (deprecated 410 handlers etc.). Add entries with a comment
// explaining why.
//
// Uses node:fs walker — no ripgrep dependency, runs everywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const ROOT = join(REPO, 'src/app/api');

// Routes that don't need the directive. Each entry needs a justification.
const ALLOWLIST = new Set([
  // No exemptions today — every API route should have force-dynamic.
]);

const DIRECTIVE = "export const dynamic = 'force-dynamic'";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const missing = [];
for (const f of files) {
  const rel = relative(REPO, f);
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(f, 'utf8');
  if (!src.includes(DIRECTIVE)) missing.push(rel);
}

if (missing.length > 0) {
  console.error(`✗ audit-force-dynamic: ${missing.length} route(s) missing \`export const dynamic = 'force-dynamic'\`:`);
  for (const m of missing) console.error(`    ${m}`);
  console.error('');
  console.error('Add the directive (between runtime export and the handler) or add the file');
  console.error('to ALLOWLIST in scripts/audit-force-dynamic.mjs with a justification.');
  process.exit(1);
}

console.log(`✓ audit-force-dynamic: ${files.length} API route(s) have the directive.`);
