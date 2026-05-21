#!/usr/bin/env node
// audit-force-dynamic — fails the build if any Next.js route or page has
// not declared its caching/rendering posture explicitly.
//
// Two checks, originally one but extended after Codex's review of Batch D
// caught new "use client" pages slipping in without the directive (no
// page-level audit existed):
//
//   1. Every src/app/api/**/route.{ts,tsx} must export
//      `export const dynamic = 'force-dynamic'`.
//      Rationale (F-NEW-01): without the directive, Next.js MAY statically
//      render the handler, caching user-specific responses on GET and
//      silently no-op'ing SMS-firing POSTs on retry.
//
//   2. Every src/app/**/page.tsx must export EITHER
//      `export const dynamic = 'force-dynamic'` OR
//      `export const dynamic = 'force-static'`.
//      Rationale (F-08 + Codex follow-up): forces every page author to
//      consciously declare protected (force-dynamic) vs public-static
//      (force-static). New pages slipping in without a directive — the
//      regression Codex caught — fails this audit at lint time, before
//      it can re-introduce the static-render-of-protected-content class.
//
// Allowlists exist for both checks. Add entries with a comment explaining
// why the exemption applies.
//
// Uses node:fs walker — no ripgrep dependency, runs everywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const API_ROOT = join(REPO, 'src/app/api');
const APP_ROOT = join(REPO, 'src/app');

// API routes that don't need the directive. Each entry needs a justification.
const API_ALLOWLIST = new Set([
  // No exemptions today — every API route should have force-dynamic.
]);

// Pages that don't need either directive. Each entry needs a justification.
const PAGE_ALLOWLIST = new Set([
  // No exemptions today — every page should declare its rendering posture.
]);

const DYNAMIC = "export const dynamic = 'force-dynamic'";
const STATIC = "export const dynamic = 'force-static'";

function walk(dir, filename, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, filename, out);
    else if (entry === filename) out.push(p);
  }
  return out;
}

// ── Check 1: API routes must have force-dynamic ───────────────────────
const apiFiles = [
  ...walk(API_ROOT, 'route.ts'),
  ...walk(API_ROOT, 'route.tsx'),
];
const apiMissing = [];
for (const f of apiFiles) {
  const rel = relative(REPO, f);
  if (API_ALLOWLIST.has(rel)) continue;
  const src = readFileSync(f, 'utf8');
  if (!src.includes(DYNAMIC)) apiMissing.push(rel);
}

if (apiMissing.length > 0) {
  console.error(`✗ audit-force-dynamic: ${apiMissing.length} API route(s) missing \`export const dynamic = 'force-dynamic'\`:`);
  for (const m of apiMissing) console.error(`    ${m}`);
  console.error('');
  console.error('Add the directive (between runtime export and the handler) or add the file');
  console.error('to API_ALLOWLIST in scripts/audit-force-dynamic.mjs with a justification.');
  process.exit(1);
}

console.log(`✓ audit-force-dynamic: ${apiFiles.length} API route(s) have the directive.`);

// ── Check 2: pages must declare force-dynamic OR force-static ─────────
const pageFiles = walk(APP_ROOT, 'page.tsx');
const pageMissing = [];
for (const f of pageFiles) {
  const rel = relative(REPO, f);
  if (PAGE_ALLOWLIST.has(rel)) continue;
  const src = readFileSync(f, 'utf8');
  if (!src.includes(DYNAMIC) && !src.includes(STATIC)) pageMissing.push(rel);
}

if (pageMissing.length > 0) {
  console.error(`✗ audit-force-dynamic: ${pageMissing.length} page(s) missing dynamic-or-static directive:`);
  for (const m of pageMissing) console.error(`    ${m}`);
  console.error('');
  console.error('Add ONE of:');
  console.error("  • `export const dynamic = 'force-dynamic';` — for protected pages or any page");
  console.error('    that fetches user/property/dynamic data (default for new pages — safe choice).');
  console.error("  • `export const dynamic = 'force-static';` — only for truly static marketing/");
  console.error('    legal pages with no per-request data.');
  console.error('Or add the file to PAGE_ALLOWLIST in scripts/audit-force-dynamic.mjs with a');
  console.error('justification (e.g., the route is intentionally hybrid).');
  process.exit(1);
}

console.log(`✓ audit-force-dynamic: ${pageFiles.length} page(s) have a dynamic-or-static directive.`);
