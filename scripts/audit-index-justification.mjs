#!/usr/bin/env node
// audit-index-justification — fails the build if a NEW index ships without
// naming the query it serves.
//
// Why this rule and not an index sweep: the public schema currently holds 734
// indexes, 276 of which have never been scanned since the stats reset. Only 98
// of those are even droppable (not primary, not unique) and together they come
// to 3.6 MB. Dropping them blind buys almost nothing and risks the plan for a
// query nobody happened to run during a quiet quarter on a one-hotel database.
// idx_scan = 0 only means something once there is real traffic on real data.
//
// So: leave the existing 734 alone, and stop the pile growing without reasons.
// Every `create index` added from migration 0349 onward must be preceded by a
// comment naming the query it exists for:
//
//   -- @query: src/lib/pms-rooms-server.ts mergePmsRoomsForStaff — the public
//   --         housekeeper link filters a date window to one staff member
//   create index room_work_assigned_staff_idx on public.room_work (...);
//
// The comment may span several lines; only the first needs the @query tag, and
// it must be within a few lines above the create statement.
//
// GRANDFATHERED: every migration numbered below FIRST_GATED_MIGRATION. Those
// indexes exist and re-justifying 734 of them retroactively is busywork.
//
// Escape marker (use sparingly, and say why):
//   -- @audit: index-justification-ok — <reason>
//
// Lives next to audit-public-page-direct-supabase.mjs and follows the same
// shape: node:fs only, no deps, non-zero exit on violation.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

// The first migration this rule applies to. Everything before it is
// grandfathered. Raising this number would silently un-gate work — don't.
const FIRST_GATED_MIGRATION = 349;

// How many lines above a `create index` we look for the justification. Three
// is enough for a tag line plus a wrapped continuation.
const LOOKBACK_LINES = 6;

const CREATE_INDEX_RX = /^\s*create\s+(unique\s+)?index\b/i;
const QUERY_TAG_RX = /--\s*@query:/i;
const ESCAPE_RX = /--\s*@audit:\s*index-justification-ok/i;

function migrationNumber(file) {
  const m = /^(\d+)/.exec(file);
  return m ? Number(m[1]) : null;
}

const violations = [];
let gatedFiles = 0;
let checkedIndexes = 0;
let escapeCount = 0;

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  const num = migrationNumber(file);
  if (num === null || num < FIRST_GATED_MIGRATION) continue;
  gatedFiles++;

  const lines = readFileSync(join(MIGRATIONS, file), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!CREATE_INDEX_RX.test(lines[i])) continue;

    // A `create index` inside a quoted string (dynamic SQL in a DO block) is
    // still a real index, so it is deliberately NOT exempt — but its
    // justification may sit above the enclosing statement, hence the lookback.
    const from = Math.max(0, i - LOOKBACK_LINES);
    const window = lines.slice(from, i);

    if (window.some((l) => ESCAPE_RX.test(l))) {
      escapeCount++;
      continue;
    }
    checkedIndexes++;
    if (!window.some((l) => QUERY_TAG_RX.test(l))) {
      violations.push({ file, line: i + 1, snippet: lines[i].trim().slice(0, 100) });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `✗ audit-index-justification: ${violations.length} new index/indexes with no named query:`,
  );
  for (const v of violations) {
    console.error(`    supabase/migrations/${v.file}:${v.line}`);
    console.error(`        ${v.snippet}`);
  }
  console.error('');
  console.error('Every index added from migration ' + FIRST_GATED_MIGRATION + ' onward must say what it is for.');
  console.error('Put a comment directly above the create statement:');
  console.error('');
  console.error('  -- @query: src/lib/foo.ts barFunction — what the query filters/orders by');
  console.error('  create index ... on public.thing (...);');
  console.error('');
  console.error('An index nobody can name a query for is a guess, and guesses are');
  console.error('exactly what leaves 276 never-scanned indexes behind. If this one is');
  console.error('genuinely justified some other way, add:');
  console.error('  -- @audit: index-justification-ok — <reason>');
  process.exit(1);
}

const escNote = escapeCount > 0 ? ` (${escapeCount} marked @audit: index-justification-ok)` : '';
console.log(
  `✓ audit-index-justification: ${checkedIndexes} index/indexes across ${gatedFiles} gated migration(s) all name a query${escNote}.`,
);
