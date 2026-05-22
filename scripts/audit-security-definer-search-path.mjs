#!/usr/bin/env node
// audit-security-definer-search-path — fails the build if any SECURITY DEFINER
// function defined in supabase/migrations/ ends up without an explicit
// `set search_path = ...` clause.
//
// Why: a SECURITY DEFINER function without search_path is exploitable via
// schema shadowing (CVE-2018-1058 family). Migrations 0003, 0036, 0037, 0040,
// 0072, 0153 systematically pinned search_path on every existing function;
// this script prevents the next migration from regressing.
//
// Cumulative-state algorithm:
//   1. Walk every migration in lexicographic order (matches the deploy order).
//   2. Strip SQL comments so commented-out code never trips the check.
//   3. Each `create [or replace] function NAME(args)` block:
//        - records definer flag + search_path flag for that function name.
//        - LATER `create or replace function NAME` overwrites both flags
//          (the function is being redefined; what matters is the final state).
//   4. Each `alter function NAME ... set search_path = ...` sets has_search_path
//      = true on the function (Postgres lets you set search_path via ALTER).
//   5. After all migrations, fail on any function where
//      `has_definer && !has_search_path`.
//
// This correctly handles the historical pattern where 0001 creates
// `user_owns_property` without search_path and 0003 recreates it with one —
// final state has search_path, lint passes.
//
// Allowlist:
//   ALLOWED_FUNCTIONS is for functions that are SECURITY DEFINER but
//   genuinely cannot use search_path (e.g., trigger functions running in
//   restricted contexts). Empty today.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

const ALLOWED_FUNCTIONS = new Set([
  // Add `'public.foo'` here with a justification comment if a future
  // SECURITY DEFINER function legitimately cannot pin search_path.
]);

function listMigrations() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexicographic = deploy order with the 0NNN_ prefix
}

// Strip SQL comments. Single-line --... and block /* ... */. Preserves
// newlines so line numbers remain consistent.
function stripSqlComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let inBlock = false;
  let inLine = false;
  let inDollar = null; // tag like '$$' or '$function$'
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // Dollar-quoted strings: keep verbatim so we don't accidentally treat
    // commented-looking text inside SQL bodies as comments. Function bodies
    // look like `as $$ ... $$` and may contain `--` literally.
    if (!inBlock && !inLine && !inDollar) {
      const dq = src.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (dq) {
        inDollar = `$${dq[1]}$`;
        out.push(dq[0]);
        i += dq[0].length;
        continue;
      }
    }
    if (inDollar) {
      if (src.slice(i, i + inDollar.length) === inDollar) {
        out.push(inDollar);
        i += inDollar.length;
        inDollar = null;
        continue;
      }
      out.push(src[i] === '\n' ? '\n' : src[i]);
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && c2 === '/') { out.push('  '); i += 2; inBlock = false; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }
    if (inLine) {
      if (c === '\n') { out.push('\n'); inLine = false; i++; continue; }
      out.push(' ');
      i++;
      continue;
    }
    if (c === '-' && c2 === '-') { out.push('  '); i += 2; inLine = true; continue; }
    if (c === '/' && c2 === '*') { out.push('  '); i += 2; inBlock = true; continue; }
    // String literals (single-quoted) — Postgres uses '' to escape; ignore
    // contents so quoted strings don't trip us up.
    if (c === "'") {
      out.push("'");
      i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") { out.push("''"); i += 2; continue; }
        if (src[i] === "'") { out.push("'"); i++; break; }
        out.push(src[i] === '\n' ? '\n' : src[i]);
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// Lowercase function-name extractor. Captures schema-qualified or bare names.
//   create or replace function public.user_owns_property(p_id uuid)
//   create function staxis_release_join_code_slot(uuid)
function extractFunctionName(declHeader) {
  // declHeader is the substring from "create ... function" through the first ")"
  const m = declHeader.match(
    /\bfunction\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w\.]*)\s*\(/i,
  );
  if (!m) return null;
  let name = m[1].toLowerCase();
  if (!name.includes('.')) name = `public.${name}`;
  return name;
}

// Find every CREATE [OR REPLACE] FUNCTION block and every ALTER FUNCTION ...
// SET search_path block. Returns events in source order.
function* iterFunctionEvents(sql, filename) {
  // CREATE FUNCTION blocks. We delimit each block from the start of
  // "create [or replace] function" through the next `as $tag$ ... $tag$`
  // closing tag, OR through the next `;` if it's a declaration-only form
  // (rare; almost everything uses dollar-quoted bodies).
  const createRx = /\bcreate\s+(?:or\s+replace\s+)?function\b/gi;
  let m;
  while ((m = createRx.exec(sql)) !== null) {
    const start = m.index;
    // Find the function header up to the first `as $tag$` or `;`.
    const tail = sql.slice(start);
    const asMatch = tail.match(/\bas\s+(\$[A-Za-z0-9_]*\$)/i);
    let blockEnd;
    let attrChunk;
    if (asMatch) {
      const tag = asMatch[1];
      const afterAs = start + asMatch.index + asMatch[0].length;
      // Find the matching closing tag.
      const closeIdx = sql.indexOf(tag, afterAs);
      blockEnd = closeIdx >= 0 ? closeIdx + tag.length : sql.length;
      attrChunk = sql.slice(start, start + asMatch.index);
    } else {
      const semi = tail.indexOf(';');
      blockEnd = semi >= 0 ? start + semi + 1 : sql.length;
      attrChunk = sql.slice(start, blockEnd);
    }
    const lineNo = sql.slice(0, start).split('\n').length;
    const name = extractFunctionName(attrChunk);
    const hasDefiner = /\bsecurity\s+definer\b/i.test(attrChunk);
    const hasInvoker = /\bsecurity\s+invoker\b/i.test(attrChunk);
    const hasSearchPath = /\bset\s+search_path\s*=/i.test(attrChunk);
    yield {
      kind: 'create',
      file: filename,
      line: lineNo,
      name,
      hasDefiner: hasDefiner && !hasInvoker,
      hasSearchPath,
    };
    createRx.lastIndex = blockEnd;
  }

  // ALTER FUNCTION ... SET search_path = ...
  const alterRx = /\balter\s+function\s+([a-zA-Z_][\w\.]*)\s*\([^)]*\)[^;]*?\bset\s+search_path\s*=/gis;
  let am;
  while ((am = alterRx.exec(sql)) !== null) {
    let name = am[1].toLowerCase();
    if (!name.includes('.')) name = `public.${name}`;
    const lineNo = sql.slice(0, am.index).split('\n').length;
    yield {
      kind: 'alter-set-search-path',
      file: filename,
      line: lineNo,
      name,
    };
  }
}

const files = listMigrations();
// final[name] = { hasDefiner: bool, hasSearchPath: bool, file: lastSourceFile, line: lastSourceLine }
const final = new Map();

for (const f of files) {
  const sql = stripSqlComments(readFileSync(join(MIGRATIONS, f), 'utf8'));
  for (const ev of iterFunctionEvents(sql, f)) {
    if (ev.kind === 'create') {
      if (!ev.name) continue;
      // CREATE [OR REPLACE] resets all attributes — Postgres lets ALTER
      // accumulate, but CREATE OR REPLACE starts fresh.
      final.set(ev.name, {
        hasDefiner: ev.hasDefiner,
        hasSearchPath: ev.hasSearchPath,
        file: ev.file,
        line: ev.line,
      });
    } else if (ev.kind === 'alter-set-search-path') {
      const cur = final.get(ev.name);
      if (cur) {
        cur.hasSearchPath = true;
      }
      // If we see ALTER for a function we never saw CREATE'd, it's likely
      // an auth.* or extension function — skip silently.
    }
  }
}

const violations = [];
for (const [name, state] of final.entries()) {
  if (!state.hasDefiner) continue;
  if (state.hasSearchPath) continue;
  if (ALLOWED_FUNCTIONS.has(name)) continue;
  violations.push({ name, file: state.file, line: state.line });
}

if (violations.length > 0) {
  console.error(
    `✗ audit-security-definer-search-path: ${violations.length} SECURITY DEFINER function(s) without explicit search_path:`,
  );
  for (const v of violations) {
    console.error(`    ${v.name}  (last defined in ${v.file}:${v.line})`);
  }
  console.error('');
  console.error('Every SECURITY DEFINER function must pin search_path to prevent CVE-2018-1058-style');
  console.error('schema-shadowing attacks. Add to the function attributes:');
  console.error('  set search_path = pg_catalog, public');
  console.error('Or pin via a follow-up `alter function NAME(args) set search_path = ...` in the same');
  console.error('or a later migration.');
  process.exit(1);
}

console.log(
  `✓ audit-security-definer-search-path: scanned ${files.length} migration(s), ${final.size} function(s); all SECURITY DEFINER functions have search_path pinned.`,
);
