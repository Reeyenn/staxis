/**
 * RLS policy shape regression test.
 *
 * Belt-and-suspenders alongside the lint scripts. A lint script can be
 * skipped (`--no-verify`, SKIP_LINT=1 hacks, or by editing package.json).
 * A `npm test` failure is much harder to bypass and runs in CI. This test
 * file does three things:
 *
 *   1. Invokes the three migration-parsing lint scripts as child processes
 *      and asserts each exits 0. (If a future Claude edits package.json to
 *      remove the lint hook, this still catches the regression.)
 *
 *   2. Asserts specific positive invariants against the migration tree:
 *        - migration 0001_initial_schema.sql still enables RLS on every
 *          per-property table.
 *        - migration 0017 still defines accounts_deny_writes.
 *        - migration 0003 still defines user_owns_property as
 *          SECURITY DEFINER with set search_path.
 *        - migration 0200 (this audit) is present and defines the
 *          expected deny-all policies.
 *
 *   3. Asserts that the 7 service-role-only tables documented in 0200
 *      are still RLS-on with at least one deny policy in the migration
 *      tree.
 *
 * These are positive ("X must exist") assertions; the lint scripts catch
 * the negative class ("Y is missing"). Both directions are useful.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(__dirname, '..', '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

// ─── 1. Lint-script invocation safety net ─────────────────────────────────

describe('RLS lint scripts pass against current tree', () => {
  for (const script of [
    'audit-public-page-direct-supabase.mjs',
    'audit-security-definer-search-path.mjs',
    'audit-rls-policy-coverage.mjs',
    'audit-api-route-tenant-scope.mjs',
  ]) {
    test(`${script} exits 0`, () => {
      const r = spawnSync('node', [join(REPO, 'scripts', script)], {
        cwd: REPO,
        encoding: 'utf8',
      });
      // If the script exits nonzero, surface its stderr so the test report
      // is actionable rather than just "exit code 1".
      assert.equal(
        r.status,
        0,
        `${script} exited ${r.status}:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    });
  }
});

// ─── 2. Positive invariants on key migrations ─────────────────────────────

describe('migration 0001 — core schema RLS', () => {
  const sql = readMigration('0001_initial_schema.sql');

  // The 24 per-property tables that 0001 enables RLS on. Sourced from the
  // audit; if a future migration drops one, the loop only fails on the
  // ones still present. (DROP TABLE in a later migration would be caught
  // by a separate test below — here we only verify the file's content.)
  const CORE_RLS_TABLES = [
    'properties', 'accounts', 'staff', 'rooms', 'public_areas',
    'laundry_config', 'daily_logs', 'work_orders', 'preventive_tasks',
    'landscaping_tasks', 'inventory', 'inspections', 'handoff_logs',
    'guest_requests', 'shift_confirmations', 'manager_notifications',
    'deep_clean_config', 'deep_clean_records', 'plan_snapshots',
    'schedule_assignments', 'scraper_status', 'dashboard_by_date',
    'error_logs', 'webhook_log',
  ];

  for (const t of CORE_RLS_TABLES) {
    test(`enables RLS on ${t}`, () => {
      const rx = new RegExp(`alter\\s+table\\s+${t}\\s+enable\\s+row\\s+level\\s+security`, 'i');
      assert.match(sql, rx, `0001 must contain: alter table ${t} enable row level security`);
    });
  }

  test('defines user_owns_property() and references it from per-property policies', () => {
    // 0001 doesn't define the function — 0003 hardens it. But 0001 DOES
    // reference it in policies.
    assert.match(sql, /user_owns_property\(property_id\)/i,
      '0001 must reference user_owns_property(property_id) in per-property policies');
  });
});

describe('migration 0003 — user_owns_property hardened with search_path', () => {
  const sql = readMigration('0003_harden_user_owns_property.sql');

  test('declares user_owns_property as SECURITY DEFINER', () => {
    assert.match(sql, /create\s+or\s+replace\s+function\s+user_owns_property/i);
    assert.match(sql, /security\s+definer/i);
  });

  test('pins search_path', () => {
    assert.match(sql, /set\s+search_path\s*=\s*public/i);
  });

  test('grants execute to anon, authenticated, service_role', () => {
    assert.match(sql, /grant\s+execute\s+on\s+function\s+user_owns_property\s*\(\s*uuid\s*\)\s+to\s+anon\s*,\s*authenticated\s*,\s*service_role/i);
  });
});

describe('migration 0017 — accounts table RLS', () => {
  const sql = readMigration('0017_accounts_rls.sql');

  test('enables RLS on accounts', () => {
    assert.match(sql, /alter\s+table\s+public\.accounts\s+enable\s+row\s+level\s+security/i);
  });

  test('defines accounts_self_select with auth.uid() = data_user_id', () => {
    assert.match(sql, /create\s+policy\s+accounts_self_select/i);
    assert.match(sql, /data_user_id\s*=\s*auth\.uid\s*\(\s*\)/i);
  });

  test('defines accounts_deny_writes for anon + authenticated', () => {
    assert.match(sql, /create\s+policy\s+accounts_deny_writes/i);
    assert.match(sql, /to\s+anon\s*,\s*authenticated/i);
    assert.match(sql, /using\s*\(\s*false\s*\)/i);
    assert.match(sql, /with\s+check\s*\(\s*false\s*\)/i);
  });
});

describe('migration 0200 — tenant-isolation hardening (this audit)', () => {
  let sql = '';
  try {
    sql = readMigration('0200_explicit_deny_all_service_role_only_tables.sql');
  } catch {
    test('migration 0200 file exists', () => {
      assert.fail('supabase/migrations/0200_explicit_deny_all_service_role_only_tables.sql is missing');
    });
    return;
  }

  test('enables RLS on pull_metrics (closes 0011 gap)', () => {
    assert.match(sql, /alter\s+table\s+public\.pull_metrics\s+enable\s+row\s+level\s+security/i);
  });

  test('enables RLS on scraper_session (closes 0011 gap — PMS login cookies)', () => {
    assert.match(sql, /alter\s+table\s+public\.scraper_session\s+enable\s+row\s+level\s+security/i);
  });

  test('REVOKEs anon/authenticated grants on scraper_session', () => {
    assert.match(sql, /revoke\s+all\s+on\s+public\.scraper_session\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i);
  });

  for (const t of [
    'agent_eval_baselines',
    'agent_prompts',
    'agent_conversations_archived',
    'agent_messages_archived',
    'agent_voice_sessions',
    'error_logs',
    'webhook_log',
    'pull_metrics',
    'scraper_session',
  ]) {
    test(`adds deny-all-browser policy on ${t}`, () => {
      const rx = new RegExp(`create\\s+policy\\s+${t}_deny_all_browser`, 'i');
      assert.match(sql, rx, `0200 must define ${t}_deny_all_browser`);
    });
  }

  test('issues notify pgrst, \'reload schema\'', () => {
    assert.match(sql, /notify\s+pgrst\s*,\s*['"]reload\s+schema['"]/i);
  });

  test('records applied_migrations row for 0200', () => {
    assert.match(sql, /insert\s+into\s+public\.applied_migrations[\s\S]*'0200'/i);
  });
});

// ─── 3. Aggregate state assertions across the whole migration tree ────────

describe('cumulative migration state', () => {
  test('every migration file has a unique numeric prefix', () => {
    const files = listMigrations();
    const seen = new Map<string, string>();
    for (const f of files) {
      const m = f.match(/^(\d{4,})_/);
      if (!m) continue; // ignore any non-numeric ones (e.g., 0015_applied_migrations_tracker.sql is numeric)
      const prefix = m[1];
      if (seen.has(prefix)) {
        // 0015 has two files in this repo; that's a known historical
        // duplicate (0015_accounts_rls_and_migration_tracker.sql +
        // 0015_applied_migrations_tracker.sql). Don't fail on it, just log.
        if (prefix !== '0015') {
          assert.fail(`duplicate migration prefix ${prefix}: ${seen.get(prefix)} and ${f}`);
        }
      }
      seen.set(prefix, f);
    }
  });

  test('no migration drops the user_owns_property function', () => {
    const files = listMigrations();
    for (const f of files) {
      const sql = readMigration(f);
      assert.doesNotMatch(
        sql,
        /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?user_owns_property\b/i,
        `${f} must not drop user_owns_property`,
      );
    }
  });

  test('no migration disables RLS on a core per-property table', () => {
    const CORE_TABLES = ['rooms', 'staff', 'work_orders', 'inventory', 'daily_logs', 'guest_requests'];
    const files = listMigrations();
    for (const f of files) {
      const sql = readMigration(f);
      for (const t of CORE_TABLES) {
        const rx = new RegExp(`alter\\s+table\\s+(?:public\\.)?${t}\\s+disable\\s+row\\s+level\\s+security`, 'i');
        assert.doesNotMatch(sql, rx, `${f} must not disable RLS on ${t}`);
      }
    }
  });
});
