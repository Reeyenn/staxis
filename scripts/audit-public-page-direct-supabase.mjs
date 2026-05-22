#!/usr/bin/env node
// audit-public-page-direct-supabase — fails the build if any publicly-linkable
// page (housekeeper, laundry, signin, etc.) calls supabase.from(), supabase.rpc(),
// or supabase.storage.from() directly with the browser/anon client.
//
// Why: per CLAUDE.md, public pages calling supabase.from() directly is the #1
// recurring bug class — anon RLS returns 200 OK + [] for unauthenticated
// visitors, so the page silently renders empty. The fix is to route all data
// reads/writes through /api/... endpoints that use supabaseAdmin + a
// capability check. supabase.auth.* is fine (magic-link consume,
// signInWithPassword); the rule only catches data-plane access.
//
// Lives next to audit-service-role-imports.mjs, audit-force-dynamic.mjs.
// Uses node:fs walker — no extra deps.
//
// Escape marker: a line containing
//   // @audit: public-page-data-ok — <reason>
// immediately above a call site disables the rule for that occurrence.
// Use sparingly and justify in the reason.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const APP = join(REPO, 'src', 'app');

// Publicly-linkable route segments. A page is "public" if its file path under
// src/app/ starts with one of these segment names. Add to the list when a
// new public route ships (e.g. /reset, /forgot if those move under top-level).
const PUBLIC_ROUTE_SEGMENTS = new Set([
  'housekeeper',
  'laundry',
  'signin',
  'signup',
  'onboard',
  'invite',
  'join',
  'consent',
  'help-request',
  'forgot',
  'reset',
]);

// File extensions to scan inside public routes.
const EXT_RX = /\.(ts|tsx|js|jsx|mjs)$/;

// Calls we forbid (data plane). We accept either dotted or bracket access.
//   supabase.from(...)              ← dotted
//   supabase['from'](...)           ← bracket
//   supabase.rpc(...)
//   supabase['rpc'](...)
//   supabase.storage.from(...)
//   supabase['storage']...          (rare; matched by the substring rule)
//
// Note: this is a regex over source, not an AST walk. The known limitation
// is destructured access like `const { from } = supabase; from('rooms')` —
// that escapes the rule. The escape marker mechanism is the documented
// safety valve; we trade some completeness for very fast lint feedback.
const FORBIDDEN_PATTERNS = [
  { rx: /\bsupabase\s*\.\s*from\s*\(/, label: 'supabase.from(...)' },
  { rx: /\bsupabase\s*\[\s*['"`]from['"`]\s*\]\s*\(/, label: "supabase['from'](...)" },
  { rx: /\bsupabase\s*\.\s*rpc\s*\(/, label: 'supabase.rpc(...)' },
  { rx: /\bsupabase\s*\[\s*['"`]rpc['"`]\s*\]\s*\(/, label: "supabase['rpc'](...)" },
  { rx: /\bsupabase\s*\.\s*storage\b/, label: 'supabase.storage.*' },
];

const ESCAPE_RX = /\/\/\s*@audit:\s*public-page-data-ok\b/;

// Comment-and-string scrubber. Replaces line comments, block comments, and
// the contents of single/double/backtick string literals with spaces (preserves
// offsets so line numbers stay accurate). Anything inside a string or comment
// is therefore ignored when matching the FORBIDDEN_PATTERNS.
//
// This is intentionally a small hand-rolled tokenizer — pulling in a TS AST
// parser for one lint script would balloon the install + cold-start time and
// the existing audit-* scripts in this repo are all regex-based for the same
// reason.
function scrubCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // Line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    // Block comment
    if (c === '/' && c2 === '*') {
      out.push('  ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) { out.push('  '); i += 2; }
      continue;
    }
    // String literal (single, double, backtick) — keep going to the closing
    // quote, handling escapes. Template-literal ${...} interpolations are
    // treated as opaque text inside the string; nesting would be over-
    // engineering for our use case.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out.push(' ');
      i++;
      while (i < n) {
        if (src[i] === '\\') { out.push('  '); i += 2; continue; }
        if (src[i] === '\n') { out.push('\n'); i++; continue; }
        if (src[i] === quote) { out.push(' '); i++; break; }
        out.push(' ');
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

function isInsidePublicRoute(relPath) {
  const parts = relPath.split(sep);
  // relPath like src/app/housekeeper/[id]/page.tsx → parts[2] is the segment
  if (parts.length < 3) return false;
  if (parts[0] !== 'src' || parts[1] !== 'app') return false;
  return PUBLIC_ROUTE_SEGMENTS.has(parts[2]);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (EXT_RX.test(entry)) out.push(p);
  }
  return out;
}

const allFiles = walk(APP);
const publicFiles = allFiles.filter((p) => isInsidePublicRoute(relative(REPO, p)));

const violations = [];
let scanned = 0;
let escapeCount = 0;

for (const f of publicFiles) {
  const rel = relative(REPO, f);
  const raw = readFileSync(f, 'utf8');

  // Bail-out: if the file doesn't even mention `supabase.` it cannot violate.
  if (!/\bsupabase\b/.test(raw)) continue;
  scanned++;

  const scrubbed = scrubCommentsAndStrings(raw);
  const rawLines = raw.split('\n');
  const scrubLines = scrubbed.split('\n');

  for (let lineNo = 0; lineNo < scrubLines.length; lineNo++) {
    const line = scrubLines[lineNo];
    for (const { rx, label } of FORBIDDEN_PATTERNS) {
      if (!rx.test(line)) continue;
      // Check the previous non-blank line for the escape marker.
      let prev = lineNo - 1;
      while (prev >= 0 && rawLines[prev].trim() === '') prev--;
      if (prev >= 0 && ESCAPE_RX.test(rawLines[prev])) {
        escapeCount++;
        break;
      }
      violations.push({
        file: rel,
        line: lineNo + 1,
        snippet: rawLines[lineNo].trim().slice(0, 140),
        label,
      });
      break;
    }
  }
}

if (violations.length > 0) {
  console.error(
    `✗ audit-public-page-direct-supabase: ${violations.length} forbidden call(s) in public-route files:`,
  );
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}  ${v.label}`);
    console.error(`        ${v.snippet}`);
  }
  console.error('');
  console.error('Public pages must route data reads/writes through /api/... endpoints that');
  console.error('use supabaseAdmin + a capability check. The anon browser client returns');
  console.error('200 OK + [] under RLS for unauthenticated visitors — the page renders empty');
  console.error('with no error, and the bug is invisible to the page owner.');
  console.error('');
  console.error('If this call is genuinely safe, add the escape marker on the line above:');
  console.error('  // @audit: public-page-data-ok — <reason>');
  process.exit(1);
}

const escNote = escapeCount > 0 ? ` (${escapeCount} call(s) marked @audit: public-page-data-ok)` : '';
console.log(
  `✓ audit-public-page-direct-supabase: scanned ${scanned} public-route file(s) with supabase imports, no violations${escNote}.`,
);
