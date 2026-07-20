import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const MIGRATION_PATH = join(
  REPO,
  'supabase',
  'migrations',
  '0328_invite_storage_service_role_only.sql',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...sourceFilesUnder(path));
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function assertTableLockdown(sql: string, table: string): void {
  assert.match(
    sql,
    new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'),
  );
  assert.match(
    sql,
    new RegExp(
      `revoke\\s+all\\s+privileges\\s+on\\s+table\\s+public\\.${table}`
      + `[\\s\\S]*?from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`,
      'i',
    ),
  );
  assert.match(
    sql,
    new RegExp(
      `grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete`
      + `\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role`,
      'i',
    ),
  );
  assert.match(
    sql,
    new RegExp(
      `create\\s+policy\\s+${table}_deny_browser\\s+on\\s+public\\.${table}`
      + `[\\s\\S]*?for\\s+all\\s+to\\s+anon\\s*,\\s*authenticated`
      + `[\\s\\S]*?using\\s*\\(\\s*false\\s*\\)`
      + `[\\s\\S]*?with\\s+check\\s*\\(\\s*false\\s*\\)`,
      'i',
    ),
  );
}

describe('migration 0328 — invite capability storage lockdown', () => {
  const rawSql = readFileSync(MIGRATION_PATH, 'utf8');
  const sql = stripSqlComments(rawSql);

  test('locks both capability tables to service-role DML', () => {
    assertTableLockdown(sql, 'account_invites');
    assertTableLockdown(sql, 'hotel_join_codes');
  });

  test('removes the historical owner policies and any out-of-band browser policy', () => {
    assert.match(
      sql,
      /drop\s+policy\s+if\s+exists\s+account_invites_manage_for_own_hotels\s+on\s+public\.account_invites/i,
    );
    assert.match(
      sql,
      /drop\s+policy\s+if\s+exists\s+hotel_join_codes_manage_for_own_hotels\s+on\s+public\.hotel_join_codes/i,
    );
    assert.match(sql, /from\s+pg_catalog\.pg_policies/i);
    assert.match(sql, /tablename\s+in\s*\(\s*'account_invites'\s*,\s*'hotel_join_codes'\s*\)/i);
    assert.match(
      sql,
      /roles\s*&&\s*array\s*\[\s*'public'\s*,\s*'anon'\s*,\s*'authenticated'\s*\]::name\[\]/i,
    );
    assert.match(sql, /execute\s+format\s*\(\s*'drop policy if exists %I on %I\.%I'/i);
  });

  test('self-registers and refreshes PostgREST after the privilege change', () => {
    assert.match(sql, /insert\s+into\s+public\.applied_migrations[\s\S]*?'0328'/i);
    assert.match(sql, /on\s+conflict\s*\(\s*version\s*\)\s+do\s+nothing/i);
    assert.match(sql, /notify\s+pgrst\s*,\s*'reload schema'/i);
  });
});

describe('invite acceptance stays behind server routes', () => {
  const routeCases = [
    {
      path: join(REPO, 'src', 'app', 'api', 'auth', 'accept-invite', 'route.ts'),
      table: 'account_invites',
    },
    {
      path: join(REPO, 'src', 'app', 'api', 'auth', 'use-join-code', 'route.ts'),
      table: 'hotel_join_codes',
    },
  ] as const;

  for (const routeCase of routeCases) {
    test(`${routeCase.table} public acceptance uses the server-only client`, () => {
      const source = readFileSync(routeCase.path, 'utf8');
      assert.match(source, /import\s*\{\s*supabaseAdmin\s*\}\s*from\s*['"]@\/lib\/supabase-admin['"]/);
      assert.doesNotMatch(source, /from\s*['"]@\/lib\/supabase['"]/);

      const access = new RegExp(`\\.from\\(\\s*['"]${routeCase.table}['"]\\s*\\)`, 'g');
      const matches = [...source.matchAll(access)];
      assert.ok(matches.length > 0, `${routeCase.path} must access ${routeCase.table}`);
      for (const match of matches) {
        const before = source.slice(Math.max(0, (match.index ?? 0) - 100), match.index);
        assert.match(
          before,
          /supabaseAdmin\s*$/,
          `every ${routeCase.table} access in ${routeCase.path} must use supabaseAdmin`,
        );
      }
    });
  }

  test('no browser-side source directly queries either capability table', () => {
    const srcRoot = join(REPO, 'src');
    const offenders: string[] = [];
    for (const path of sourceFilesUnder(srcRoot)) {
      const normalized = path.replaceAll('\\', '/');
      if (normalized.includes('/src/app/api/')) continue;
      if (normalized.includes('/src/lib/__tests__/')) continue;
      if (normalized.endsWith('/src/types/database.types.ts')) continue;

      const source = readFileSync(path, 'utf8');
      if (/\.from\(\s*['"](?:account_invites|hotel_join_codes)['"]\s*\)/.test(source)) {
        offenders.push(normalized.slice(REPO.length + 1));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `capability tables must be accessed through server routes only: ${offenders.join(', ')}`,
    );
  });
});

describe('security audits understand the new service-role-only posture', () => {
  test('lint-time and runtime RLS allowlists include both tables', () => {
    const lintAudit = readFileSync(join(REPO, 'scripts', 'audit-rls-policy-coverage.mjs'), 'utf8');
    const doctor = readFileSync(join(REPO, 'src', 'app', 'api', 'admin', 'doctor', 'route.ts'), 'utf8');
    for (const table of ['account_invites', 'hotel_join_codes']) {
      assert.match(lintAudit, new RegExp(`SERVICE_ROLE_ONLY[\\s\\S]*?['"]${table}['"]`));
      assert.match(doctor, new RegExp(`RLS_SERVICE_ROLE_ONLY_ALLOWLIST[\\s\\S]*?['"]${table}['"]`));
    }
  });
});
