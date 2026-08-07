/**
 * Activity log — migration shape tests.
 *
 * Parses 0228_activity_log.sql as text and pins the invariants that
 * downstream code depends on, without booting a Postgres instance.
 *
 * Catches the regressions that bit us in earlier migrations:
 *   - new SECURITY DEFINER without an explicit search_path (CVE family)
 *   - trigger fires on an event source we forgot to wire up
 *   - service-role-only marker drift (lint relies on this comment)
 *   - backfill drift (we'd merge a migration that ships no backfill)
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(filename: string): string {
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', filename), 'utf-8');
}

// Strip line + block comments before scanning so phrases like
// "uses SECURITY DEFINER for…" in the migration header don't trip the
// "every definer must pin search_path" check. The lint scripts under
// scripts/ do the same.
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const RAW_SQL = readMigration('0228_activity_log.sql');
const SQL = stripComments(RAW_SQL);

const RAW_SQL_0415 = readMigration('0415_activity_log_copy_no_dashes.sql');
const SQL_0415 = stripComments(RAW_SQL_0415);
const RAW_SQL_0272 = readMigration('0272_drop_legacy_rooms.sql');

/** U+2014. Named because it is invisible in a diff otherwise. */
const EM_DASH = '—';

/**
 * Every `create or replace function public.NAME() returns trigger … $$;`
 * block in a migration, keyed by function name.
 *
 * Deliberately scoped to trigger functions (the ones that pre-render the
 * sentences a manager reads) rather than all functions, so a future helper
 * with a dash in a code comment can't be mistaken for user-facing copy.
 */
function triggerFunctionBodies(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /create or replace function public\.([a-z0-9_]+)\(\)\s*\nreturns trigger([\s\S]*?)\n\$\$;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.set(m[1], m[0]);
  return out;
}

/**
 * Single-quoted SQL string literals inside a block, with `''` escapes
 * handled. These are the bytes that end up in activity_log.description
 * and .target_label, which is where the copy ruling applies. Everything
 * outside them is identifiers, keywords, and comments, which are exempt.
 */
function sqlStringLiterals(block: string): string[] {
  return block.match(/'(?:[^']|'')*'/g) ?? [];
}

describe('migration 0228 — activity_log', () => {
  test('creates the activity_log table with the service-role-only marker', () => {
    // The marker lives in a SQL comment, so check the raw text — the
    // comment-stripped SQL below would lose it.
    assert.match(RAW_SQL, /@rls:\s*service-role-only/i);
    assert.match(SQL, /create table if not exists public\.activity_log/);
  });

  test('grants service-role only + revokes from anon/authenticated', () => {
    assert.match(SQL, /revoke all on public\.activity_log from public, anon, authenticated/);
    assert.match(SQL, /grant select, insert, update, delete on public\.activity_log to service_role/);
    assert.match(SQL, /create policy activity_log_deny_all/);
  });

  test('declares all six primary indexes', () => {
    assert.match(SQL, /activity_log_property_time_idx/);
    assert.match(SQL, /activity_log_property_cat_time_idx/);
    assert.match(SQL, /activity_log_property_actor_time_idx/);
    assert.match(SQL, /activity_log_property_target_time_idx/);
    assert.match(SQL, /activity_log_property_source_time_idx/);
    assert.match(SQL, /activity_log_source_event_unique_idx/);
  });

  test('every SECURITY DEFINER function pins search_path', () => {
    const definerBlocks = [...SQL.matchAll(/security\s+definer/gi)];
    assert.ok(definerBlocks.length >= 1, 'expected at least one SECURITY DEFINER block');
    // For each definer, the following ~200 chars should contain a set search_path clause.
    for (const m of definerBlocks) {
      const window = SQL.slice(m.index, (m.index ?? 0) + 240);
      assert.match(
        window,
        /set\s+search_path\s*=\s*public,\s*pg_temp/i,
        `SECURITY DEFINER block missing pinned search_path near offset ${m.index}`,
      );
    }
  });

  test('wires triggers on every event source we promised to cover', () => {
    const expected = [
      'trg_activity_log_cleaning_event_ins',
      'trg_activity_log_cleaning_event_upd',
      'trg_activity_log_cleaning_task_ins',
      'trg_activity_log_cleaning_task_upd',
      'trg_activity_log_hk_assignment_ins',
      'trg_activity_log_hk_assignment_upd',
      'trg_activity_log_inspection_ins',
      'trg_activity_log_inspection_upd',
      'trg_activity_log_callout_event_ins',
      'trg_activity_log_callout_event_upd',
      'trg_activity_log_work_order_ins',
      'trg_activity_log_work_order_upd',
      'trg_activity_log_room_status_ins',
      'trg_activity_log_account_ins',
      'trg_activity_log_account_role_upd',
      // Post-rebase: tables added by migrations 0220 + 0222.
      'trg_activity_log_role_change_ins',
      'trg_activity_log_staff_break_ins',
      'trg_activity_log_staff_break_upd',
      'trg_activity_log_room_pause_ins',
      'trg_activity_log_room_pause_upd',
    ];
    for (const name of expected) {
      assert.match(SQL, new RegExp(`create trigger ${name}`), `missing trigger ${name}`);
    }
  });

  test('ships a backfill block for each source covering the last 90 days', () => {
    const block = /interval\s+'90 days'/g;
    const count = (SQL.match(block) ?? []).length;
    // Minimum coverage: cleaning_events, cleaning_tasks, inspections (started + outcome),
    // callout_events (reported + reverted), pms_work_orders_v2, pms_room_status_log,
    // role_changes, staff_breaks (started + ended), room_pause_events (paused + resumed).
    assert.ok(count >= 11, `expected at least 11 backfill blocks, got ${count}`);
  });

  test('backfill uses ON CONFLICT DO NOTHING so re-runs are idempotent', () => {
    assert.match(SQL, /on conflict \(property_id, event_type, source_event_id, occurred_at\)/i);
  });

  test('reloads the PostgREST schema cache at the end', () => {
    assert.match(SQL, /notify pgrst, 'reload schema'/);
  });
});

/**
 * The em-dash copy ruling (founder, 2026-07-28) reached activity_log three
 * months after 0228 pre-rendered its sentences. 0415 is the fix. These are
 * source-string assertions on purpose: a migration file is a no-runtime
 * artifact, so there is no handler to exercise, and the bytes ARE the
 * behavior once Postgres compiles them.
 */
describe('migration 0415 — activity_log copy has no em dashes', () => {
  const replaced = triggerFunctionBodies(SQL_0415);

  const EXPECTED_REPLACED = [
    '_activity_log_on_account_role_update',
    '_activity_log_on_callout_event_insert',
    '_activity_log_on_callout_event_update',
    '_activity_log_on_cleaning_task_insert',
    '_activity_log_on_inspection_update',
    '_activity_log_on_work_order_insert',
  ];

  test('replaces exactly the six live trigger functions that carried a dash', () => {
    assert.deepEqual([...replaced.keys()].sort(), EXPECTED_REPLACED);
  });

  test('no replaced function body contains an em dash in a SQL string literal', () => {
    for (const [name, body] of replaced) {
      const offenders = sqlStringLiterals(body).filter((lit) => lit.includes(EM_DASH));
      assert.deepEqual(
        offenders, [],
        `${name} still renders an em dash into activity_log copy: ${offenders.join(' | ')}`,
      );
    }
  });

  test('no replaced function body contains an em dash anywhere', () => {
    // Belt to the literal check above: catches a dash smuggled in via an
    // identifier, a dollar-quoted fragment, or a stray operator.
    for (const [name, body] of replaced) {
      assert.equal(body.includes(EM_DASH), false, `${name} contains an em dash`);
    }
  });

  test('covers every dashed 0228 trigger function that is still alive', () => {
    // The cross-file invariant that makes this suite more than a spell
    // check: walk 0228's OWN trigger functions, find the ones whose copy
    // carries a dash, and require each to be either replaced by 0415 or
    // dropped outright by a later migration. A new dashed template added
    // to 0228, or a resurrected room_pause function, fails here.
    const original = triggerFunctionBodies(SQL);
    const dashed = [...original.entries()]
      .filter(([, body]) => sqlStringLiterals(body).some((lit) => lit.includes(EM_DASH)))
      .map(([name]) => name)
      .sort();

    // 0272 dropped room_pause_events together with the legacy `rooms`
    // table its trigger read from, so 0415 must NOT recreate it.
    const droppedLater = dashed.filter((name) =>
      new RegExp(`drop function if exists public\\.${name}\\(\\)`).test(RAW_SQL_0272),
    );
    assert.deepEqual(droppedLater, ['_activity_log_on_room_pause_insert']);

    const stillAlive = dashed.filter((name) => !droppedLater.includes(name));
    assert.deepEqual(
      stillAlive, EXPECTED_REPLACED,
      'a 0228 trigger function still renders an em dash and 0415 does not replace it',
    );
  });

  test('does not resurrect the trigger functions 0272 deliberately dropped', () => {
    assert.doesNotMatch(SQL_0415, /_activity_log_on_room_pause_(insert|update)\s*\(/);
  });

  test('does not re-run the one-time 90-day backfill', () => {
    // 0228's backfill already ran in prod. Re-running it here would be a
    // second write pass over three months of drifted source rows.
    assert.doesNotMatch(SQL_0415, /interval\s+'90 days'/);
    assert.doesNotMatch(SQL_0415, /insert\s+into\s+public\.activity_log/i);
  });

  test('cleans stored rows on both copy columns, guarded on the character', () => {
    // Idempotency: each UPDATE only touches rows that still contain the
    // dash, so a re-run of the migration is a no-op.
    for (const column of ['description', 'target_label']) {
      const updates = [...SQL_0415.matchAll(
        new RegExp(`update public\\.activity_log\\s+set ${column} = replace\\([\\s\\S]*?;`, 'g'),
      )].map((m) => m[0]);
      assert.equal(updates.length, 2, `expected padded + bare dash passes for ${column}`);
      for (const stmt of updates) {
        assert.ok(stmt.includes(EM_DASH), `${column} cleanup must target the em dash`);
        assert.match(
          stmt,
          new RegExp(`where ${column} like '%`),
          `${column} cleanup must be guarded on the character so re-runs no-op`,
        );
      }
    }
  });

  test('every SECURITY DEFINER function pins search_path', () => {
    const definerBlocks = [...SQL_0415.matchAll(/security\s+definer/gi)];
    assert.equal(definerBlocks.length, EXPECTED_REPLACED.length);
    for (const m of definerBlocks) {
      const window = SQL_0415.slice(m.index, (m.index ?? 0) + 240);
      assert.match(
        window,
        /set\s+search_path\s*=\s*public,\s*pg_temp/i,
        `SECURITY DEFINER block missing pinned search_path near offset ${m.index}`,
      );
    }
  });

  test('self-registers and reloads the PostgREST schema cache', () => {
    assert.match(SQL_0415, /insert into public\.applied_migrations/i);
    assert.match(SQL_0415, /'0415'/);
    assert.match(SQL_0415, /notify pgrst, 'reload schema'/);
  });
});

/**
 * The one value 0456 adds, and everything it deliberately does not.
 *
 * Source-string assertions for the same reason as 0415's: a migration is a
 * no-runtime artifact, and the bytes ARE the behavior once Postgres compiles
 * them. What is pinned here is the shape of a widening — that it widened, that
 * it kept every value it inherited, and that it opened no door on the way past.
 */
describe('migration 0456 — the companion joins the timeline', () => {
  const RAW_SQL_0456 = readMigration('0456_agent_journal.sql');
  const SQL_0456 = stripComments(RAW_SQL_0456);

  test('adds staxis_agent to the source domain and keeps every old value', () => {
    assert.match(SQL_0456, /alter table public\.activity_log\s+add constraint activity_log_source_check/i);
    assert.match(SQL_0456, /'staxis_agent'/);
    // A restated CHECK that quietly dropped a value would break every trigger
    // writing under it, and only at runtime, on the hotel's next event.
    for (const kept of [
      'housekeeper_app', 'manager_dashboard', 'admin_dashboard', 'cron',
      'cua_worker', 'rules_engine', 'pms_sync', 'system', 'sms', 'voice',
    ]) {
      assert.ok(SQL_0456.includes(`'${kept}'`), `0456 dropped the '${kept}' source`);
    }
  });

  test('creates no table, no policy and no grant', () => {
    // The whole claim of the migration: the timeline already existed, so the
    // companion's record costs one CHECK value and nothing else. A grant here
    // would open a service-role-only table that carries operational counts.
    assert.doesNotMatch(SQL_0456, /create table/i);
    assert.doesNotMatch(SQL_0456, /create policy/i);
    assert.doesNotMatch(SQL_0456, /\bgrant\b/i);
    assert.doesNotMatch(SQL_0456, /create index/i);
  });

  test('refuses to run on a project that never applied 0228', () => {
    // Silently no-opping would leave the journal writing into a CHECK it
    // believes it widened, and every insert would fail at runtime instead.
    assert.match(SQL_0456, /to_regclass\('public\.activity_log'\) is null/i);
    assert.match(SQL_0456, /raise exception/i);
  });

  test('self-registers and reloads the PostgREST schema cache', () => {
    assert.match(SQL_0456, /insert into public\.applied_migrations/i);
    assert.match(SQL_0456, /'0456'/);
    assert.match(SQL_0456, /notify pgrst, 'reload schema'/i);
  });
});
