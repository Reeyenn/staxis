import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SUPERSEDED_MIGRATIONS,
  applicableMigrationFiles,
  migrationVersion,
} from '@/lib/migration-policy';

describe('migration policy', () => {
  it('permanently classifies unsafe migration 0162 as superseded', () => {
    assert.deepEqual([...SUPERSEDED_MIGRATIONS], ['0162']);
  });

  it('never offers superseded migrations to drift checks or bulk apply', () => {
    assert.deepEqual(
      applicableMigrationFiles([
        '0161_rls_require_mfa_verified.sql',
        '0162_mfa_verified_tighten.sql',
        '0163_custom_access_token_hook_hotfix.sql',
        'README.md',
      ]),
      [
        '0161_rls_require_mfa_verified.sql',
        '0163_custom_access_token_hook_hotfix.sql',
      ],
    );
    assert.equal(migrationVersion('0162_mfa_verified_tighten.sql'), '0162');
    assert.equal(migrationVersion('not-a-migration.sql'), null);
  });

  it('forces both production migration scripts through the shared policy', () => {
    for (const filename of ['scripts/check-migrations-applied.ts', 'scripts/apply-pending.ts']) {
      const source = readFileSync(join(process.cwd(), filename), 'utf8');
      assert.match(source, /applicableMigrationFiles/);
      assert.doesNotMatch(source, /PENDING_INTENTIONALLY/);
    }
  });
});
