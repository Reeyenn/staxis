#!/usr/bin/env node
// audit-service-role-imports — fails the build if any `"use client"` file
// or any file under src/components/ imports `supabase-admin`.
//
// Batch C in the core-web/auth/RLS security plan. The service-role client
// bypasses RLS — it must never reach the browser bundle. Today there are
// zero such imports (verified), and this script is a tripwire that breaks
// the build the day someone accidentally introduces one (e.g., copy-paste
// from a server-only route into a client component).
//
// Uses node:fs walker — no ripgrep dependency, runs everywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SRC = join(REPO, 'src');

const ADMIN_IMPORT_RX = /from\s+['"](@\/lib\/supabase-admin|\.\.?\/(?:[^'"]*\/)?supabase-admin)['"]/;
const USE_CLIENT_RX = /^['"]use client['"];?\s*$/m;

const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const violations = [];

for (const f of files) {
  const rel = relative(REPO, f);
  // Server-only paths are exempt — that's where supabase-admin belongs.
  // (We still need to flag client-component files even when they live under
  // src/lib, so checking the "use client" directive is what matters.)
  const src = readFileSync(f, 'utf8');

  if (!ADMIN_IMPORT_RX.test(src)) continue;

  const isClient = USE_CLIENT_RX.test(src);
  const isComponent = rel.startsWith('src/components/');

  if (isClient || isComponent) {
    violations.push({ file: rel, reason: isClient ? '"use client" file' : 'src/components/ file' });
  }
}

if (violations.length > 0) {
  console.error(`✗ audit-service-role-imports: ${violations.length} file(s) import \`supabase-admin\` from the browser-reachable surface:`);
  for (const v of violations) console.error(`    ${v.file}  (${v.reason})`);
  console.error('');
  console.error('supabase-admin uses the service-role key — it bypasses RLS and MUST stay server-side.');
  console.error('If the file is actually a route handler or server-only lib, remove the "use client"');
  console.error('directive or move it out of src/components/.');
  process.exit(1);
}

console.log(`✓ audit-service-role-imports: scanned ${files.length} file(s), no client-side service-role imports.`);
