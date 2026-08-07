/**
 * The RLS coverage gate must not pass on an empty scan.
 *
 * THE HOLE THIS PINS (auth sweep 2026-08-07).
 *
 * `scripts/audit-rls-policy-coverage.mjs` decides pass/fail purely on
 * `violations.length > 0`. Nothing ever asserted that it looked at anything.
 * A moved or renamed migrations directory, a glob that stops matching, or a
 * parser change that stops recognising `create table` all produce an empty
 * table map, zero violations, `✓ … scanned 0 migration(s), 0 table(s)`, and
 * exit 0. `rls-policies-shape.test.ts` asserts the script exits 0 and never
 * reads the printed counts, so a silently-empty scan is green in CI for as
 * long as it takes a human to notice the number in the log.
 *
 * That is the worst failure mode a security gate can have: it reports success
 * loudest exactly when it has stopped working.
 *
 * This test runs the real script against an empty migrations tree and requires
 * a refusal.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const SCRIPT = 'audit-rls-policy-coverage.mjs';

/** Stand the script up over a migrations directory we control. */
function runAgainstMigrations(files: Array<{ name: string; sql: string }>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const sandbox = mkdtempSync(join(tmpdir(), 'rls-coverage-gate-'));
  try {
    mkdirSync(join(sandbox, 'scripts'), { recursive: true });
    mkdirSync(join(sandbox, 'supabase', 'migrations'), { recursive: true });
    copyFileSync(join(REPO, 'scripts', SCRIPT), join(sandbox, 'scripts', SCRIPT));
    for (const file of files) {
      writeFileSync(join(sandbox, 'supabase', 'migrations', file.name), file.sql, 'utf8');
    }
    const result = spawnSync('node', [join(sandbox, 'scripts', SCRIPT)], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('audit-rls-policy-coverage refuses a scan that saw nothing', () => {
  test('an empty migrations directory is a failure, not a clean pass', () => {
    const result = runAgainstMigrations([]);
    assert.notEqual(
      result.status,
      0,
      'a gate that found no migrations must refuse. Exiting 0 here is how a broken gate '
      + `reports success forever.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /migration/i,
      'the refusal must say what was missing so the next person can fix the input',
    );
  });

  test('a handful of real-looking migrations is still too few to trust', () => {
    // The parser works fine here — the point is that a tree this small means
    // the script is pointed at the wrong place, not that the app got smaller.
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `000${i + 1}_probe.sql`,
      sql: `create table public.probe_${i} (id uuid primary key, property_id uuid not null);\n`
        + `alter table public.probe_${i} enable row level security;\n`
        + `create policy probe_${i}_own on public.probe_${i} for select to authenticated `
        + 'using (user_owns_property(property_id));\n',
    }));
    const result = runAgainstMigrations(files);
    assert.notEqual(
      result.status,
      0,
      `a five-migration tree must not certify this app's RLS coverage.\n`
      + `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });

  test('the floors do not bind on the real tree — the gate still runs for real', () => {
    // Guards against the fix itself becoming the thing that breaks CI.
    const result = spawnSync('node', [join(REPO, 'scripts', SCRIPT)], {
      cwd: REPO,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `the real repository must still pass.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(result.stdout, /tenant-scoped table\(s\) all have RLS \+ policy/);
  });
});
