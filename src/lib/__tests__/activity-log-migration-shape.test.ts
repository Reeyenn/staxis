/**
 * Activity log — migration shape tests.
 *
 * Parses 0225_activity_log.sql as text and pins the invariants that
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

const RAW_SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0225_activity_log.sql'),
  'utf-8',
);

// Strip line + block comments before scanning so phrases like
// "uses SECURITY DEFINER for…" in the migration header don't trip the
// "every definer must pin search_path" check. The lint scripts under
// scripts/ do the same.
const SQL = RAW_SQL
  .replace(/--[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 0225 — activity_log', () => {
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
    ];
    for (const name of expected) {
      assert.match(SQL, new RegExp(`create trigger ${name}`), `missing trigger ${name}`);
    }
  });

  test('ships a backfill block for each source covering the last 90 days', () => {
    const block = /interval\s+'90 days'/g;
    const count = (SQL.match(block) ?? []).length;
    // Minimum coverage: cleaning_events, cleaning_tasks, inspections (started + outcome),
    // callout_events (reported + reverted), pms_work_orders_v2, pms_room_status_log.
    assert.ok(count >= 7, `expected at least 7 backfill blocks, got ${count}`);
  });

  test('backfill uses ON CONFLICT DO NOTHING so re-runs are idempotent', () => {
    assert.match(SQL, /on conflict \(property_id, event_type, source_event_id, occurred_at\)/i);
  });

  test('reloads the PostgREST schema cache at the end', () => {
    assert.match(SQL, /notify pgrst, 'reload schema'/);
  });
});
