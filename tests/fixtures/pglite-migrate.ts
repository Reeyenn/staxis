/**
 * pglite migration runner — applies real production migrations from
 * supabase/migrations/ to an in-memory PGlite instance so the RLS
 * tenant-isolation integration test runs against the actual schema
 * (not a hand-rolled mini-fixture).
 *
 * Why this exists:
 *   The previous fixture declared ~3 tables by hand. A future migration
 *   that renamed accounts.property_access or rewrote user_owns_property
 *   would have kept the test passing against the stale hand-rolled copy
 *   while breaking production. Applying the REAL migrations means any
 *   schema drift surfaces as an integration-test failure immediately.
 *
 * Class classification (from the v3 plan):
 *   Class A — apply as-is. Pure public-schema DDL + canonical extensions.
 *   Class B — apply with auth.uid()/auth.users stub already in place.
 *   Class C — needs realtime/storage/vault stubs. SKIP in v3.
 *
 * Best-effort progressive: any per-migration error is caught, the
 * migration is marked skipped with the first error line, and the runner
 * continues. The final report ("applied N of M") goes to console so the
 * test output makes the coverage explicit.
 *
 * Caching: single memoized async instance shared across all integration
 * tests in a run — first test pays the ~3-5s cold start, subsequent
 * tests reuse the live pg connection.
 */

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

export type MigrationReport = {
  applied: string[];
  skippedClassC: string[];           // pre-classified Class C — never attempted
  failedAtRuntime: Array<{ file: string; error: string }>;
};

export type PgliteMigratedFixture = {
  pg: PGlite;
  report: MigrationReport;
};

// Patterns that mark a migration as Class C (skip — needs stubs we don't
// have). These are conservative — false positives mean we skip migrations
// that COULD apply; false negatives mean we attempt + fail (caught by the
// try/catch). False positives are safer.
// Class C: migrations we genuinely can't apply (whole-migration skip).
// `supabase_realtime` is NOT here — preprocess strips those lines while
// keeping the rest of the migration (so a `create table` + realtime
// publication line migration applies its DDL, just not the publication).
const CLASS_C_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  { rx: /\bstorage\.objects\b/i,          reason: 'storage.objects RLS' },
  { rx: /\bstorage\.buckets\b/i,          reason: 'storage.buckets DDL' },
  { rx: /\bstorage\.foldername\b/i,       reason: 'storage.foldername function' },
  { rx: /\brealtime\.\w+\b/i,             reason: 'realtime schema' },
  { rx: /\bvault\.\w+\b/i,                reason: 'vault schema' },
  { rx: /\bpg_net\b/i,                    reason: 'pg_net extension' },
  { rx: /\bextensions\.\w+\b/i,           reason: 'extensions schema' },
  { rx: /\bpgp_sym_(?:encrypt|decrypt)\b/i, reason: 'pgcrypto sym encryption (vault-adjacent)' },
  { rx: /\bcreate\s+extension[^;]*\b(pgvector|vector|pg_net)\b/i, reason: 'unsupported extension' },
  // Trigger functions that manipulate auth.users — pglite has the stub
  // table but auth-specific triggers (signups, etc.) won't fire correctly.
  { rx: /\bcreate\s+trigger\b[^;]*\bauth\.users\b/i, reason: 'trigger on auth.users' },
];

/**
 * Rewrite migration SQL to work around pglite limitations BEFORE apply.
 * Returns the rewritten SQL. Order matters — applied top-to-bottom.
 *
 *   1. Comment out `create extension if not exists "<name>"` for extensions
 *      pglite doesn't ship (uuid-ossp).
 *   2. Comment out `alter publication supabase_realtime ...;` — pglite has
 *      no Supabase realtime publication. Stripping the line lets the
 *      migration's `create table` and policy statements still apply.
 *   3. Strip `CONCURRENTLY` from `create index` — pglite errors with
 *      "CREATE INDEX CONCURRENTLY cannot run inside a transaction block"
 *      because each `pg.exec(sql)` runs implicitly transactional.
 *
 * Functions/tables from real Supabase systems (auth.users, vault, storage)
 * are stubbed in applyStubs() before any migration runs.
 */
function preprocess(sql: string): string {
  let out = sql;

  // 1. Unsupported extensions.
  out = out.replace(
    /create\s+extension\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([a-zA-Z_][\w]*))[^;]*;/gi,
    (match, quoted, unquoted) => {
      const name = (quoted || unquoted || '').toLowerCase();
      if (name === 'pgcrypto' || name === 'pg_trgm') return match;
      return `-- [pglite-migrate] skipped extension: ${match.trim()}`;
    },
  );

  // 2. (Previously stripped supabase_realtime publication alter statements,
  // but that broke when the statement was inside an EXECUTE string literal.
  // Better fix: stub the publication itself in applyStubs() so both direct
  // ALTERs and dynamic EXECUTE forms succeed without error.)

  // 3. CREATE INDEX CONCURRENTLY → CREATE INDEX (no transaction conflict).
  out = out.replace(
    /\bcreate\s+(unique\s+)?index\s+concurrently\b/gi,
    (match, unique) => `create ${unique ? 'unique ' : ''}index`,
  );

  return out;
}

function classify(sql: string): { skip: boolean; reason: string | null } {
  // Strip line comments before classification to avoid false positives on
  // commented-out references like `-- could use storage.foldername later`.
  const noComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  for (const { rx, reason } of CLASS_C_PATTERNS) {
    if (rx.test(noComments)) return { skip: true, reason };
  }
  return { skip: false, reason: null };
}

async function applyStubs(pg: PGlite): Promise<void> {
  // Roles + schemas + auth shims. Mirrors tests/fixtures/pglite-bootstrap.ts
  // but lives here so the migration runner is self-contained.
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role bypassrls nologin;

    create schema if not exists auth;
    create schema if not exists storage;

    create or replace function auth.uid() returns uuid
      language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create or replace function auth.role() returns text
      language sql stable as $$
      select current_setting('request.jwt.claim.role', true);
    $$;
    create or replace function auth.jwt() returns jsonb
      language sql stable as $$ select '{}'::jsonb; $$;

    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_app_meta_data jsonb default '{}'::jsonb,
      created_at timestamptz default now()
    );

    -- Real Supabase grants anon + authenticated USAGE on the auth schema and
    -- EXECUTE on auth.uid()/auth.jwt()/auth.role() by default. Mirror that so
    -- RLS policies that inline a NON-security-definer helper (e.g.
    -- public.mfa_verified_or_grace() → auth.jwt()) evaluate as the
    -- authenticated role instead of erroring "permission denied for schema
    -- auth". user_owns_property() is SECURITY DEFINER so it never hit this,
    -- which is why only MFA-gated tables (0161+, e.g. complaints/
    -- guest_requests) tripped the cross-tenant SELECT loop.
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated;
  `);

  // Stub the supabase_realtime publication so migrations that ALTER it
  // (directly or via EXECUTE) don't error. pglite has no realtime broker,
  // but the publication just becomes a no-op metadata object.
  try {
    await pg.exec(`create publication supabase_realtime;`);
  } catch {
    // Some pglite versions may not allow publications; safe to ignore —
    // we'll just see the cascading alter-publication errors and skip those
    // migrations one-off.
  }
}

let memoized: Promise<PgliteMigratedFixture> | null = null;

export function applyMigrationsToPglite(): Promise<PgliteMigratedFixture> {
  if (memoized) return memoized;
  memoized = (async () => {
    // Register pglite contrib extensions used by migrations:
    //   - pgcrypto: gen_random_uuid() etc. (0001 + downstream)
    //   - pg_trgm: trigram indexes (used by a few search-related migrations)
    const pg = new PGlite({ extensions: { pgcrypto, pg_trgm } });
    await applyStubs(pg);

    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const report: MigrationReport = {
      applied: [],
      skippedClassC: [],
      failedAtRuntime: [],
    };

    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      const { skip, reason } = classify(sql);
      if (skip) {
        report.skippedClassC.push(`${f} (${reason})`);
        continue;
      }
      try {
        await pg.exec(preprocess(sql));
        report.applied.push(f);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.failedAtRuntime.push({ file: f, error: msg.split('\n')[0] });
      }
    }

    // Surface the report once — useful when CI fails so the failure is
    // explainable without re-running with verbose flags.
    const total = files.length;
    console.log(
      `[pglite-migrate] applied ${report.applied.length}/${total} migrations ` +
      `(${report.skippedClassC.length} skipped pre-classified Class C, ` +
      `${report.failedAtRuntime.length} failed at runtime)`,
    );
    if (report.failedAtRuntime.length > 0) {
      console.log(`[pglite-migrate] runtime failures (first 5):`);
      for (const f of report.failedAtRuntime.slice(0, 5)) {
        console.log(`  ${f.file}: ${f.error}`);
      }
    }

    return { pg, report };
  })();
  return memoized;
}

/**
 * Discover per-property tables (column == property_id + RLS enabled +
 * at least one policy mentioning user_owns_property). Used by the
 * integration test to parameterize cross-tenant denial cases.
 */
export async function discoverPerPropertyTables(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ tablename: string }>(`
    with tenant_tables as (
      select c.relname as tablename
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = 'public'
        and c.relrowsecurity = true
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid
            and a.attnum > 0
            and not a.attisdropped
            and a.attname = 'property_id'
        )
    ),
    with_owner_policy as (
      select distinct tablename from pg_policies
      where schemaname = 'public'
        and (
          coalesce(qual, '') ilike '%user_owns_property%'
          or coalesce(with_check, '') ilike '%user_owns_property%'
        )
    )
    select t.tablename from tenant_tables t
    join with_owner_policy p on p.tablename = t.tablename
    order by t.tablename
  `);
  return r.rows.map((row) => row.tablename);
}
