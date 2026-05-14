/**
 * Drift-prevention test for migration bookkeeping.
 *
 * Why this exists:
 *   The doctor's `checkAppliedMigrations` reads from `applied_migrations`
 *   and compares against an EXPECTED_MIGRATIONS list. For that comparison
 *   to work, every migration must EITHER:
 *     1. End with `insert into public.applied_migrations (...) values
 *        ('00XX', '...') on conflict (version) do nothing;`
 *        so live applies populate the table automatically, OR
 *     2. Be listed in `BACKFILLED_BASELINE` here — versions whose schema
 *        is already deployed but whose bookkeeping was backfilled by
 *        migration 0076.
 *   AND the version must appear in EXPECTED_MIGRATIONS in the doctor.
 *
 *   May 2026 audit pass-6 discovered 38 migrations (out of 75) drifted
 *   away from this convention — schema was applied to live but the
 *   bookkeeping table only tracked 37 of them. This test prevents the
 *   gap from re-opening. Adding a new migration without the INSERT line
 *   will fail this test on PR before merge.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXPECTED_CRONS } from '@/app/api/admin/doctor/route';
// Doctor exports EXPECTED_MIGRATIONS too, via the same const exports
// pattern. Importing the array directly keeps this test honest — it
// can't accidentally test against a stale copy.
import { EXPECTED_MIGRATIONS } from '@/app/api/admin/doctor/route';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/**
 * Versions that don't self-register via INSERT but whose schema IS
 * applied to live. They're backfilled into applied_migrations by
 * 0076_backfill_applied_migrations.sql. Adding new entries here is
 * intentional debt; the goal going forward is that every NEW migration
 * (0077+) self-registers.
 */
const BACKFILLED_BASELINE: ReadonlySet<string> = new Set([
  // 0001-0014: pre-tracker baseline
  '0001', '0002', '0003', '0004', '0005', '0006', '0007',
  '0008', '0009', '0010', '0011', '0012', '0013', '0014',
  // 0021-0023: ML infra, convention not yet standard
  '0021', '0022', '0023',
  // 0050-0060: admin + analytics tables that missed the convention
  '0050', '0051', '0052', '0053', '0054', '0055',
  '0056', '0057', '0058', '0059', '0060',
  // 0062-0065: inventory ML + 2FA + invites
  '0062', '0063', '0064', '0065',
]);

/**
 * Filenames of migration "stubs" — files that intentionally do nothing,
 * usually because a draft was renamed/split. They're allowed to be
 * present in the directory but don't need INSERT statements and don't
 * appear in EXPECTED_MIGRATIONS.
 */
const STUB_FILENAMES: ReadonlySet<string> = new Set([
  '0015_accounts_rls_and_migration_tracker.sql',
]);

function listMigrationFiles(): { version: string; filename: string; content: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => {
      const versionMatch = filename.match(/^(\d{4})_/);
      if (!versionMatch) {
        throw new Error(`Migration filename "${filename}" doesn't start with 4-digit version_ prefix`);
      }
      return {
        version: versionMatch[1],
        filename,
        content: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'),
      };
    });
}

describe('migration bookkeeping', () => {
  it('every migration either self-registers OR is in BACKFILLED_BASELINE OR is a stub', () => {
    const files = listMigrationFiles();
    const offenders: string[] = [];
    for (const f of files) {
      if (STUB_FILENAMES.has(f.filename)) continue;
      // Accept either `insert into public.applied_migrations` or
      // `insert into applied_migrations` — the codebase uses both
      // forms; both resolve to the same table via search_path.
      const hasInsert = /insert\s+into\s+(public\.)?applied_migrations/i.test(f.content);
      const isBackfilled = BACKFILLED_BASELINE.has(f.version);
      if (!hasInsert && !isBackfilled) {
        offenders.push(
          `${f.filename}: no \`insert into applied_migrations\` and not in BACKFILLED_BASELINE`,
        );
      }
    }
    assert.equal(
      offenders.length, 0,
      `${offenders.length} migration(s) drift from convention:\n  ${offenders.join('\n  ')}\n` +
      `Fix: add \`insert into public.applied_migrations (version, description) values ('00XX', '...') on conflict (version) do nothing;\` at the bottom of each file.`,
    );
  });

  it('self-registering migrations include an INSERT for their own version', () => {
    // The check below verifies that the file mentions its own version
    // in some INSERT into applied_migrations. Multi-version backfill
    // migrations (like 0015 and 0076) are allowed to have many INSERTs;
    // we just need ONE of them to match the filename version.
    const files = listMigrationFiles();
    const mismatches: string[] = [];
    for (const f of files) {
      if (STUB_FILENAMES.has(f.filename)) continue;
      if (BACKFILLED_BASELINE.has(f.version)) continue; // schema-only, no self-INSERT expected
      // Find any quoted version string near an INSERT … applied_migrations
      // that matches the filename version.
      const versionRe = new RegExp(`['"]${f.version}['"]`, 'g');
      const hasOwnVersion = versionRe.test(f.content);
      if (!hasOwnVersion) {
        mismatches.push(
          `${f.filename}: file claims version ${f.version} but no INSERT row matches that version`,
        );
      }
    }
    assert.equal(
      mismatches.length, 0,
      `Version mismatch in migration INSERT statements:\n  ${mismatches.join('\n  ')}`,
    );
  });

  it('every migration file version appears in EXPECTED_MIGRATIONS', () => {
    const files = listMigrationFiles();
    const fileVersions = new Set(
      files.filter((f) => !STUB_FILENAMES.has(f.filename)).map((f) => f.version),
    );
    const missing: string[] = [];
    for (const v of fileVersions) {
      if (!EXPECTED_MIGRATIONS.includes(v)) {
        missing.push(v);
      }
    }
    assert.equal(
      missing.length, 0,
      `Migration files exist but doctor's EXPECTED_MIGRATIONS doesn't list them: ${missing.join(', ')}.\n` +
      `Add them to the EXPECTED_MIGRATIONS array in src/app/api/admin/doctor/route.ts.`,
    );
  });

  it('every EXPECTED_MIGRATIONS version has a matching file (or is intentionally skipped)', () => {
    // Reverse-direction drift: a version listed in the doctor with no
    // file. Probably means someone removed a migration file but forgot
    // to update the list, leaving the doctor reporting "missing" for a
    // schema that was never expected to be there.
    const files = listMigrationFiles();
    const fileVersions = new Set(
      files.filter((f) => !STUB_FILENAMES.has(f.filename)).map((f) => f.version),
    );
    // 0044-0049 are intentionally-skipped reserved slots; everything
    // else in EXPECTED_MIGRATIONS should have a corresponding file.
    const INTENTIONALLY_SKIPPED = new Set(['0044', '0045', '0046', '0047', '0048', '0049']);
    const orphans: string[] = [];
    for (const v of EXPECTED_MIGRATIONS) {
      if (INTENTIONALLY_SKIPPED.has(v)) continue;
      if (!fileVersions.has(v)) {
        orphans.push(v);
      }
    }
    assert.equal(
      orphans.length, 0,
      `EXPECTED_MIGRATIONS lists ${orphans.length} version(s) with no corresponding file: ${orphans.join(', ')}.\n` +
      `Either restore the file or remove from EXPECTED_MIGRATIONS.`,
    );
  });

  it('no two migration files share a version (Phase L: prevent 0116 collision class)', () => {
    // Why: Phase K's 0116_properties_total_rooms_check.sql and a parallel
    // session's 0116_voice_surface.sql both shipped to main. The other
    // tests in this file used `new Set(files.map(f => f.version))` which
    // silently deduped — no test caught the collision. Both DDL blocks
    // are idempotent so prod schema survived, but applied_migrations was
    // collapsed to a single row with the WRONG description until manual
    // repair. Postgres has no concept of "two files for one version,"
    // so we enforce uniqueness at the file system. CI rejects the next
    // collision before merge.
    // Exclude documented stubs (e.g., 0015_accounts_rls_and_migration_tracker.sql,
    // a no-op file kept alongside the real 0015_applied_migrations_tracker.sql).
    const files = listMigrationFiles().filter((f) => !STUB_FILENAMES.has(f.filename));
    const byVersion = new Map<string, string[]>();
    for (const f of files) {
      const list = byVersion.get(f.version) ?? [];
      list.push(f.filename);
      byVersion.set(f.version, list);
    }
    const collisions: Array<[string, string[]]> = [];
    for (const [version, filenames] of byVersion.entries()) {
      if (filenames.length > 1) {
        collisions.push([version, filenames]);
      }
    }
    assert.deepEqual(
      collisions,
      [],
      `Migration version collisions detected (each version must map to exactly one file):\n  ${
        collisions
          .map(([v, fs]) => `${v}: ${fs.join(', ')}`)
          .join('\n  ')
      }\nRename the newer file to the next free version and update its INSERT statement.`,
    );
  });

  it('EXPECTED_CRONS export is reachable (sanity for test infrastructure)', () => {
    // Pure smoke check: the import path resolves at test time. If this
    // ever breaks, the cron-cadences.test.ts file is broken too.
    assert.ok(Array.isArray(EXPECTED_CRONS), 'EXPECTED_CRONS should be an array');
    assert.ok(EXPECTED_CRONS.length > 0, 'EXPECTED_CRONS should be non-empty');
  });
});
