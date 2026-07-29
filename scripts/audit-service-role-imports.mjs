#!/usr/bin/env node
// audit-service-role-imports — two tripwires around the service-role client.
//
// (1) Browser reachability: fails the build if any `"use client"` file or any
//     file under src/components/ imports `supabase-admin`.
// (2) The AI layer's one-hotel boundary (INV-25 / INV-30): fails the build if
//     any file under src/lib/agent/** reaches the service-role client outside
//     the accessor, or if the number of `unscopedBecause(` escape hatches
//     changes without someone editing the pinned number below.
//
// (2) overlaps the ESLint `no-restricted-imports` rule on purpose — ESLint
// only sees static `import` statements, while this walker also catches
// `await import(...)` and `require(...)`, which is exactly how two tool files
// were reaching the client before the boundary landed.
//
// Batch C in the core-web/auth/RLS security plan. The service-role client
// bypasses RLS — it must never reach the browser bundle. Today there are
// zero such imports (verified), and this script is a tripwire that breaks
// the build the day someone accidentally introduces one (e.g., copy-paste
// from a server-only route into a client component).
//
// Uses node:fs walker — no ripgrep dependency, runs everywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SRC = join(REPO, 'src');

const ADMIN_SPECIFIER = String.raw`@\/lib\/supabase-admin|\.\.?\/(?:[^'"]*\/)?supabase-admin`;
const ADMIN_IMPORT_RX = new RegExp(String.raw`from\s+['"](${ADMIN_SPECIFIER})['"]`);
// Also catches `await import('…/supabase-admin')` and `require('…')`, which a
// static-import lint rule cannot see.
const ADMIN_ANY_REF_RX = new RegExp(
  String.raw`(?:from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](${ADMIN_SPECIFIER})['"]`,
);
const USE_CLIENT_RX = /^['"]use client['"];?\s*$/m;

// ─── AI-layer boundary (INV-25 / INV-30) ────────────────────────────────────

const AGENT_DIR = 'src/lib/agent/';

/** The ONE file allowed to hold the service-role client for the AI layer. */
const AGENT_ACCESSOR = 'src/lib/agent/scoped-db.ts';

/**
 * Modules that still reach the client directly. Cron/route-driven, not
 * model-driven, so they are deliberately last in the conversion. This list may
 * only ever SHRINK — a stale entry (a file that no longer needs the exemption)
 * fails this audit, and adding one is a visible edit in review.
 *
 * Keep in sync with the `ignores` list in eslint.config.js.
 */
const AGENT_UNCONVERTED = new Set([
  'src/lib/agent/activity.ts',
  'src/lib/agent/archival.ts',
  'src/lib/agent/context.ts',
  'src/lib/agent/cost-controls.ts',
  'src/lib/agent/evals/runner.ts',
  'src/lib/agent/memory.ts',
  'src/lib/agent/memory-consolidate.ts',
  'src/lib/agent/nudges.ts',
  'src/lib/agent/operational-signals.ts',
  'src/lib/agent/pending-actions.ts',
  'src/lib/agent/prompts-store.ts',
  'src/lib/agent/summarizer.ts',
]);

/**
 * How many deliberate escape hatches exist under src/lib/agent/**. Every one
 * is a call to `unscopedBecause(<enumerated reason>)`. Bumping this number is
 * the price of adding one — that is the whole point (INV-30).
 *
 *   1 × 'shared-lib-client-param'  tools/inventory-monthly-accounting.ts
 *   1 × 'portfolio-exact-set-rpc' portfolio-intelligence/knowledge.ts
 *   1 × 'company-scope-table'      awareness.ts — company_findings is keyed by
 *                                  organization_id and has no property_id, so
 *                                  the one-hotel accessor cannot scope it. The
 *                                  org id comes from the caller's own company
 *                                  hat, never from the request.
 */
const EXPECTED_UNSCOPED_CALLS = 3;
const UNSCOPED_CALL_RX = /\bunscopedBecause\s*\(/g;

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
const agentViolations = [];
const usedExemptions = new Set();
let unscopedCalls = 0;

for (const f of files) {
  const rel = relative(REPO, f).split(sep).join('/');
  // Server-only paths are exempt — that's where supabase-admin belongs.
  // (We still need to flag client-component files even when they live under
  // src/lib, so checking the "use client" directive is what matters.)
  const src = readFileSync(f, 'utf8');

  if (rel.startsWith(AGENT_DIR)) {
    if (rel !== AGENT_ACCESSOR) {
      unscopedCalls += (src.match(UNSCOPED_CALL_RX) ?? []).length;
    }
    if (ADMIN_ANY_REF_RX.test(src)) {
      if (AGENT_UNCONVERTED.has(rel)) usedExemptions.add(rel);
      else if (rel !== AGENT_ACCESSOR) agentViolations.push(rel);
    }
  }

  if (!ADMIN_IMPORT_RX.test(src)) continue;

  const isClient = USE_CLIENT_RX.test(src);
  const isComponent = rel.startsWith('src/components/');

  if (isClient || isComponent) {
    violations.push({ file: rel, reason: isClient ? '"use client" file' : 'src/components/ file' });
  }
}

if (agentViolations.length > 0) {
  console.error(`✗ audit-service-role-imports: ${agentViolations.length} AI-layer file(s) reach the service-role client directly:`);
  for (const v of agentViolations) console.error(`    ${v}`);
  console.error('');
  console.error('Everything under src/lib/agent/** must query through ctx.db / scopedDb(propertyId)');
  console.error('so the hotel filter cannot be forgotten (INVARIANTS.md INV-25).');
  console.error('For a genuine exception, use unscopedBecause(<reason>) from @/lib/agent/scoped-db');
  console.error(`and bump EXPECTED_UNSCOPED_CALLS in ${relative(REPO, fileURLToPath(import.meta.url))}.`);
  process.exit(1);
}

const staleExemptions = [...AGENT_UNCONVERTED].filter((f) => !usedExemptions.has(f));
if (staleExemptions.length > 0) {
  console.error(`✗ audit-service-role-imports: ${staleExemptions.length} stale AI-layer exemption(s) — these files no longer need one:`);
  for (const v of staleExemptions) console.error(`    ${v}`);
  console.error('');
  console.error('Delete them from AGENT_UNCONVERTED here AND from the `ignores` list in eslint.config.js');
  console.error('so the boundary actually closes behind the conversion.');
  process.exit(1);
}

if (unscopedCalls !== EXPECTED_UNSCOPED_CALLS) {
  console.error(`✗ audit-service-role-imports: the AI layer has ${unscopedCalls} unscopedBecause() call site(s), expected ${EXPECTED_UNSCOPED_CALLS}.`);
  console.error('');
  console.error('Every escape hatch out of the one-hotel boundary is counted on purpose (INV-30).');
  console.error('If the new call site is genuinely necessary, update EXPECTED_UNSCOPED_CALLS');
  console.error(`in ${relative(REPO, fileURLToPath(import.meta.url))} and say why in the comment above it.`);
  process.exit(1);
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

console.log(
  `✓ audit-service-role-imports: scanned ${files.length} file(s); no client-side service-role imports, ` +
  `AI layer clean (${AGENT_UNCONVERTED.size} module(s) pending conversion, ${unscopedCalls} escape hatch(es)).`,
);
