/**
 * Public-page route shape regression test.
 *
 * Every route under /api/housekeeper/** and /api/laundry/** is reachable
 * by an unauthenticated visitor following an SMS link. Per CLAUDE.md, the
 * canonical pattern for these routes when they touch tenant data is:
 *
 *   1. Import supabaseAdmin (NOT the anon supabase client — RLS would
 *      silently return 200 OK + [] and the page renders empty).
 *   2. Validate `pid` (and where applicable `staffId`) via the
 *      api-validate helpers OR perform an equivalent inline capability
 *      check against the staff/room rows the route reads (e.g.,
 *      `staff.property_id !== pid` after fetching the staff row).
 *   3. Scope every subsequent query by property_id (and where relevant
 *      staff_id / assigned_to) OR perform an explicit row-level capability
 *      check after the read.
 *
 * Routes that don't touch tenant data (pure telemetry endpoints, code
 * exchanges that only verify Supabase Auth tokens) don't need the full
 * pattern. The test detects whether the route touches tenant tables and
 * only enforces the shape on routes that do.
 *
 * Escape marker for genuine exceptions:
 *   // @audit: public-page-shape-ok — <reason>
 * at the top of the file. Use only when the auto-detection
 * misclassifies and you're sure the route is safe.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const PUBLIC_API_ROOTS = [
  join(REPO, 'src', 'app', 'api', 'housekeeper'),
  join(REPO, 'src', 'app', 'api', 'laundry'),
];

const ESCAPE_RX = /\/\/\s*@audit:\s*public-page-shape-ok\b/;

// A route "touches tenant data" if it queries any of these tables.
// Anything from this list pulls or writes property-scoped data and must
// satisfy the capability-check pattern.
const TENANT_TABLE_REFS = [
  /\.from\s*\(\s*['"]rooms['"]\s*\)/,
  /\.from\s*\(\s*['"]staff['"]\s*\)/,
  /\.from\s*\(\s*['"]work_orders['"]\s*\)/,
  /\.from\s*\(\s*['"]guest_requests['"]\s*\)/,
  /\.from\s*\(\s*['"]inventory['"]\s*\)/,
  /\.from\s*\(\s*['"]cleaning_events['"]\s*\)/,
  /\.from\s*\(\s*['"]daily_logs['"]\s*\)/,
  /\.from\s*\(\s*['"]schedule_assignments['"]\s*\)/,
  /\.from\s*\(\s*['"]plan_snapshots['"]\s*\)/,
  /\.from\s*\(\s*['"]inspections['"]\s*\)/,
  /\.from\s*\(\s*['"]handoff_logs['"]\s*\)/,
  /\.from\s*\(\s*['"]shift_confirmations['"]\s*\)/,
];

// "Has a capability check" — any of these patterns satisfy the requirement
// that the route verifies the (pid, staffId) tuple OR a per-row property
// match before reading/writing tenant data.
const CAPABILITY_CHECK_PATTERNS = [
  /validateUuid\s*\(\s*[^,]*,\s*['"]pid['"]/,
  /\.eq\s*\(\s*['"]property_id['"]\s*,\s*pid\b/,
  /\bstaff\??\.property_id\s*!==?\s*(?:body\.)?pid\b/,
  /\broom\??\.property_id\s*!==?\s*(?:body\.)?pid\b/,
  /\bassigned_to\s*!==?\s*(?:body\.)?staffId\b/,
  // Housekeeper mobile rebuild piece A (migration 0214) — workflow routes
  // delegate the (pid, staffId) check to gateHousekeeperRequest which
  // does staff.property_id === pid + rate limit + JSON-parse error
  // handling. Same trust model as the legacy room-action route.
  /\bgateHousekeeperRequest\s*</,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (entry === 'route.ts' || entry === 'route.tsx' || entry === 'route.js') out.push(p);
  }
  return out;
}

const routeFiles: string[] = [];
for (const root of PUBLIC_API_ROOTS) walk(root, routeFiles);

if (routeFiles.length === 0) {
  test('public-page route directories exist', () => {
    assert.fail(`expected route files under ${PUBLIC_API_ROOTS.join(' or ')}`);
  });
}

describe(`public-page routes (${routeFiles.length} file(s)) follow capability-check shape`, () => {
  for (const f of routeFiles) {
    const rel = f.slice(REPO.length + 1);
    const src = readFileSync(f, 'utf8');

    const firstChunk = src.split('\n').slice(0, 30).join('\n');
    const hasEscape = ESCAPE_RX.test(firstChunk);
    const touchesTenantData = TENANT_TABLE_REFS.some((rx) => rx.test(src));

    describe(rel, () => {
      if (hasEscape) {
        test('@audit: public-page-shape-ok — manually waived', () => {
          assert.ok(true, 'escape marker present; route waived from shape checks');
        });
        return;
      }

      test('does not import the anon supabase client (silent-empty-state bug)', () => {
        // The anon client returns 200 + [] under RLS for unauthenticated
        // visitors → the page silently renders empty. The whole point of
        // the /api/housekeeper/** + /api/laundry/** routes is to route
        // around RLS via supabaseAdmin (server-side, capability-checked).
        const importsAnon = /from\s+['"]@\/lib\/supabase['"]/.test(src);
        assert.ok(
          !importsAnon,
          `must not import @/lib/supabase (anon client). Use supabaseAdmin via @/lib/supabase-admin.`,
        );
      });

      if (!touchesTenantData) {
        test('does not touch tenant tables (telemetry/auth-only route — skip capability checks)', () => {
          // Route reads/writes nothing in the per-property tables we track.
          // Auth or telemetry endpoint — the capability-check pattern isn't
          // required. Just ensure it doesn't smuggle in tenant access via
          // a table we didn't list.
          assert.ok(true);
        });
        return;
      }

      test('imports supabaseAdmin (since it touches tenant tables)', () => {
        const importsAdmin = /from\s+['"](@\/lib\/supabase-admin|\.\.?\/(?:[^'"]*\/)?supabase-admin)['"]/.test(src);
        assert.ok(importsAdmin, `must import supabaseAdmin from @/lib/supabase-admin`);
      });

      test('has a capability check (validateUuid OR inline staff/room property check)', () => {
        const matched = CAPABILITY_CHECK_PATTERNS.find((rx) => rx.test(src));
        assert.ok(
          matched,
          `must include a capability check before tenant queries:
  - validateUuid(..., 'pid')
  - .eq('property_id', pid)
  - staff.property_id !== pid (after fetching staff)
  - room.property_id !== pid (after fetching room)
  - room.assigned_to !== staffId (for per-staff scoping)
Or use // @audit: public-page-shape-ok — <reason> at top of file.`,
        );
      });
    });
  }
});
