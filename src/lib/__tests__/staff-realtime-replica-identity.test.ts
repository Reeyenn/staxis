/**
 * `staff` and `shift_confirmations` must end at REPLICA IDENTITY DEFAULT.
 *
 * WHY THIS TEST EXISTS
 * This has broken production twice, the same way both times, and until now
 * nothing stopped a third.
 *
 * Both tables are published to realtime with a COLUMN ALLOW-LIST (migration
 * 0009) that filters `phone` / `hourly_wage` / `staff_phone` out of the
 * broadcast, because a line staffer can see colleagues' rows and the realtime
 * firehose is visible in DevTools. Postgres requires a publication's column
 * list to be a SUPERSET of the replica identity's columns, so REPLICA IDENTITY
 * FULL ("every column") is illegal alongside a column filter, and EVERY UPDATE
 * to the table then fails with:
 *
 *     ERROR 42P10: cannot update table "staff"
 *
 * Migration 0009 set FULL, 0013 reverted it. Migration 0133 — a cost audit that
 * blanket-set FULL on five hot realtime tables — put it straight back, and the
 * Staff Priority modal, the person editor, activate/deactivate and vacation
 * edits all failed in production again until 0267 reverted it a second time.
 *
 * The trap is a comment: 0009 states, wrongly, that "column-filtered tables can
 * still have replica identity full". Anyone reading 0009 in isolation gets
 * explicit permission to do the forbidden thing. That comment is now marked as
 * wrong, and this test is the mechanical stop.
 *
 * This is a genuine no-runtime invariant about migration files, which is the
 * one case CLAUDE.md reserves source-text assertions for. There is no handler
 * to exercise: the failure happens inside Postgres, on every UPDATE, only once
 * the migration is applied.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/** The two column-filtered realtime tables. FULL is a hard error on these. */
const COLUMN_FILTERED_TABLES = ['staff', 'shift_confirmations'] as const;
type ColumnFilteredTable = typeof COLUMN_FILTERED_TABLES[number];

type ReplicaIdentityMode = 'full' | 'default' | 'nothing' | 'index';

interface ReplicaIdentityStatement {
  migration: string;
  table: string;
  mode: ReplicaIdentityMode;
}

function normalizeMode(raw: string): ReplicaIdentityMode {
  const word = raw.trim().toLowerCase();
  if (word.startsWith('full')) return 'full';
  if (word.startsWith('nothing')) return 'nothing';
  if (word.startsWith('using')) return 'index';
  return 'default';
}

/**
 * Every replica-identity change a migration makes, in the order the files
 * apply. Covers both shapes actually used in this repo:
 *
 *   1. `alter table public.staff replica identity full;`
 *   2. the dynamic loop in 0006 — `execute format('alter table public.%I
 *      replica identity full', t)` over a `text[]` of table names. That loop is
 *      how `staff` got FULL the FIRST time, so a reader that only understood
 *      shape 1 would miss the original incident entirely.
 */
function readReplicaIdentityHistory(): ReplicaIdentityStatement[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const history: ReplicaIdentityStatement[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    const direct = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+replica\s+identity\s+([a-z]+(?:\s+index\s+\S+)?)/gi;
    for (let m = direct.exec(sql); m !== null; m = direct.exec(sql)) {
      history.push({ migration: file, table: m[1].toLowerCase(), mode: normalizeMode(m[2]) });
    }

    // Dynamic form: a format() string that ends in a replica-identity change,
    // fed by an array of table names declared in the same file.
    const dynamic = /format\(\s*'alter\s+table[^']*replica\s+identity\s+([a-z]+)'/gi;
    for (let m = dynamic.exec(sql); m !== null; m = dynamic.exec(sql)) {
      const mode = normalizeMode(m[1]);
      const arrays = sql.match(/array\s*\[([\s\S]*?)\]/gi) ?? [];
      for (const arrayLiteral of arrays) {
        const names = arrayLiteral.match(/'([a-z0-9_]+)'/gi) ?? [];
        for (const quoted of names) {
          history.push({ migration: file, table: quoted.slice(1, -1).toLowerCase(), mode });
        }
      }
    }
  }
  return history;
}

function finalStatementFor(
  history: ReplicaIdentityStatement[],
  table: ColumnFilteredTable,
): ReplicaIdentityStatement | undefined {
  const touching = history.filter((s) => s.table === table);
  return touching[touching.length - 1];
}

describe('realtime replica identity on the column-filtered staff tables', () => {
  const history = readReplicaIdentityHistory();

  test('the scan actually finds the known history (guards against a silent no-op)', () => {
    // If the regexes ever stop matching, every assertion below would pass
    // vacuously. Pin the two incidents we know are in the files.
    const staffStatements = history.filter((s) => s.table === 'staff');
    assert.ok(
      staffStatements.some((s) => s.mode === 'full'),
      'the scan should still see the historical FULL statements on staff',
    );
    assert.ok(
      staffStatements.some((s) => s.mode === 'default'),
      'the scan should still see the corrective DEFAULT statements on staff',
    );
    assert.ok(
      history.some((s) => s.table === 'shift_confirmations'),
      'the scan should still see shift_confirmations',
    );
  });

  for (const table of COLUMN_FILTERED_TABLES) {
    test(`${table} ends at DEFAULT, never FULL`, () => {
      const last = finalStatementFor(history, table);
      assert.ok(last, `no replica identity statement found for ${table}`);
      assert.notEqual(
        last.mode,
        'full',
        `${table} is left at REPLICA IDENTITY ${last.mode.toUpperCase()} by ${last.migration}. `
          + 'It is published to realtime with a column allow-list (0009), and FULL alongside a '
          + 'column list makes every UPDATE fail with Postgres 42P10 — which is exactly what '
          + '0133 did to the roster editor until 0267 undid it. Revert it in a new migration.',
      );
      assert.equal(last.mode, 'default', `${table} must end at DEFAULT (from ${last.migration})`);
    });
  }

  test('migration 0009 no longer tells the next reader that FULL is safe here', () => {
    // The false claim in 0009 is the root cause of the 0133 repeat. It stays in
    // the file (applied migrations are history) but must be marked as wrong.
    const sql = readFileSync(
      join(MIGRATIONS_DIR, '0009_realtime_column_filter.sql'),
      'utf8',
    );
    const claim = /column-filtered tables can still have\s*(?:--\s*)?`?replica identity full/is;
    const correction = /THE (?:LINE|CLAIM|NOTE) ABOVE IS WRONG|CORRECTION \(/i;
    if (claim.test(sql)) {
      assert.match(
        sql,
        correction,
        'migration 0009 still asserts that a column-filtered table may be REPLICA IDENTITY FULL. '
          + 'That is false (Postgres 42P10) and it is how migration 0133 reintroduced the bug. '
          + 'Leave the history, but mark the claim as wrong.',
      );
    }
  });
});
