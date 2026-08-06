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
import { vector } from '@electric-sql/pglite/vector';
import { createHash } from 'node:crypto';
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

const ACCESS_STAGE_C_RELEASE_GATE_MARKER = '-- @access-stage-c-release-gate';
const ACCESS_B_LIVE_SHA = 'ec83bca6dab74a52dfb251d04be11d5c7427703f';
const CURRENT_LIVE_DESCENDANT_SHA = '442fb98d632521ea33346d5c8a97014248a31fa0';
export const ACCESS_STAGE_C_ACTIVE_RELEVANT_QUERIES_CONTRACT =
  "pid <> pg_backend_pid() AND state <> 'idle' AND (query ILIKE '%property_access%' OR query ILIKE '%account_access%' OR query ILIKE '%account_lifecycle%' OR query ILIKE '%account_invites%' OR query ILIKE '%join_requests%' OR query ILIKE '%organization_access%' OR query ILIKE '%organization_invitations%')";

// Patterns that mark a migration as Class C (skip — needs stubs we don't
// have). These are conservative — false positives mean we skip migrations
// that COULD apply; false negatives mean we attempt + fail (caught by the
// try/catch). False positives are safer.
// Class C: migrations we genuinely can't apply (whole-migration skip).
// `supabase_realtime` is NOT here — preprocess strips those lines while
// keeping the rest of the migration (so a `create table` + realtime
// publication line migration applies its DDL, just not the publication).
//
// `storage.objects` / `storage.buckets` / `storage.foldername` are NO LONGER
// here: applyStubs() now creates them. Skipping them cost five migrations
// (0212 inspections, 0230 lost_and_found_items, 0252 knowledge_hub, 0340
// report intake) plus everything downstream — 0289, 0341, 0343, 0354 and 0355
// all failed on tables those four never got to create. Whole feature areas
// were therefore missing from any test that runs against this schema.
const CLASS_C_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  { rx: /\brealtime\.\w+\b/i,             reason: 'realtime schema' },
  { rx: /\bvault\.\w+\b/i,                reason: 'vault schema' },
  { rx: /\bpg_net\b/i,                    reason: 'pg_net extension' },
  { rx: /\bpgp_sym_(?:encrypt|decrypt)\b/i, reason: 'pgcrypto sym encryption (vault-adjacent)' },
  { rx: /\bcreate\s+extension[^;]*\bpg_net\b/i, reason: 'unsupported extension' },
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
      if (name === 'pgcrypto' || name === 'pg_trgm' || name === 'vector') return match;
      return `-- [pglite-migrate] skipped extension: ${match.trim()}`;
    },
  );

  // 2. (Previously stripped supabase_realtime publication alter statements,
  // but that broke when the statement was inside an EXECUTE string literal.
  // Better fix: stub the publication itself in applyStubs() so both direct
  // ALTERs and dynamic EXECUTE forms succeed without error.)

  // 2b. Supabase installs extensions into the `extensions` schema; pglite
  // installs them into `public`. Rewriting the qualifier lets the real
  // migration text apply unchanged in every other respect — previously the
  // whole file was skipped, which cost knowledge_chunks (0266), folder
  // access (0282) and the append-dedup unique indexes (0342) that 0343,
  // 0354 and 0355 all depend on.
  out = out.replace(/\bextensions\./gi, 'public.');
  out = out.replace(/\bwith\s+schema\s+extensions\b/gi, 'with schema public');

  // 3. CREATE INDEX CONCURRENTLY → CREATE INDEX (no transaction conflict).
  out = out.replace(
    /\bcreate\s+(unique\s+)?index\s+concurrently\b/gi,
    (match, unique) => `create ${unique ? 'unique ' : ''}index`,
  );

  return out;
}

/**
 * EVERYTHING POSTGRES SAID, not just the headline.
 *
 * This function exists because of a specific, expensive failure. Three main
 * pushes between 2026-08-03 and 2026-08-06 went red with nothing in the log
 * but `ON CONFLICT DO UPDATE command cannot affect row a second time` — no
 * statement, no function, no line. The runner was recording `msg.split('\n')[0]`
 * and dropping the rest, and the rest is where Postgres puts the answer: the
 * error carries `where` (the CONTEXT block), which quotes the offending SQL
 * verbatim and names the PL/pgSQL function and line that ran it, plus `code`
 * (the SQLSTATE) and `hint`.
 *
 * A migration failure inside a 9,000-line file is only diagnosable once, from
 * the CI log of the run that hit it — these are rare and did not reproduce in
 * 120 local applications of the same schema. Throwing the context away meant
 * every occurrence cost another week of waiting for the next one.
 *
 * Kept to one report entry, capped, so a long CONTEXT cannot bury the rest of
 * the report. The Postgres message stays FIRST so the existing
 * `assert.match(failure.error, /…/)` expectations keep reading naturally.
 */
function describePgError(e: unknown): string {
  const err = e as Partial<Record<string, unknown>> | null;
  const message = e instanceof Error ? e.message : String(e);
  if (!err || typeof err !== 'object') return message.split('\n')[0];
  const parts = [message.split('\n')[0]];
  const push = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') {
      parts.push(`${label}: ${value.replace(/\s+/g, ' ').trim()}`);
    }
  };
  push('SQLSTATE', err.code);
  push('DETAIL', err.detail);
  push('HINT', err.hint);
  // The CONTEXT block. This is the one that names the statement.
  push('CONTEXT', err.where);
  return parts.join(' | ').slice(0, 4000);
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
    create schema if not exists extensions;

    create or replace function auth.uid() returns uuid
      language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create or replace function auth.role() returns text
      language sql stable as $$
      select current_setting('request.jwt.claim.role', true);
    $$;
    create or replace function auth.jwt() returns jsonb
      language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb,
        '{}'::jsonb
      );
    $$;

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

  // Supabase Storage. Only the shape the migrations touch: buckets + objects
  // + foldername(), with RLS on so bucket policies apply cleanly. Without
  // these, every migration that creates a bucket was skipped whole — taking
  // inspections, lost-and-found, the knowledge hub and the report raw zone
  // with it.
  await pg.exec(`
    create table if not exists storage.buckets (
      id text primary key,
      name text not null,
      owner uuid,
      public boolean default false,
      avif_autodetection boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets(id),
      name text,
      owner uuid,
      owner_id text,
      version text,
      path_tokens text[],
      metadata jsonb,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      last_accessed_at timestamptz default now()
    );
    alter table storage.objects enable row level security;

    -- Real signature: everything before the last '/' segment.
    create or replace function storage.foldername(name text) returns text[]
      language plpgsql immutable as $fn$
      declare parts text[];
      begin
        parts := string_to_array(name, '/');
        return parts[1 : array_length(parts, 1) - 1];
      end;
      $fn$;

    grant usage on schema storage to anon, authenticated, service_role;
    grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
    grant execute on function storage.foldername(text) to anon, authenticated, service_role;
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
    const pg = new PGlite({ extensions: { pgcrypto, pg_trgm, vector } });
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
      // A migration wrapped in an explicit `begin; … commit;` that fails
      // partway leaves the session in an aborted transaction, and Postgres
      // then refuses EVERY subsequent statement with "current transaction is
      // aborted". One migration this runner cannot apply (a missing storage
      // stub, say) would silently take out every migration after it and every
      // test that depends on them. Clearing the slate first keeps a runtime
      // failure local to the migration that caused it. Harmless no-op when no
      // transaction is open.
      await pg.exec('rollback;').catch(() => undefined);
      try {
        const preparedSql = preprocess(sql);
        const markerIndex = preparedSql.indexOf(ACCESS_STAGE_C_RELEASE_GATE_MARKER);
        if (markerIndex >= 0) {
          await pg.exec(preparedSql.slice(0, markerIndex));
          await authorizeAccessStageCRelease(pg);
          await pg.exec(
            preparedSql.slice(markerIndex + ACCESS_STAGE_C_RELEASE_GATE_MARKER.length),
          );
        } else {
          await pg.exec(preparedSql);
        }
        report.applied.push(f);
      } catch (e) {
        report.failedAtRuntime.push({ file: f, error: describePgError(e) });
      }
    }

    // The current migration is the last file in the fixture. If it fails
    // intentionally at a preflight gate, clear the aborted transaction before
    // handing the shared database to tests that exercise the prior schema.
    await pg.exec('rollback;').catch(() => undefined);

    // Surface the report once — useful when CI fails so the failure is
    // explainable without re-running with verbose flags.
    const total = files.length;
    console.log(
      `[pglite-migrate] applied ${report.applied.length}/${total} migrations ` +
      `(${report.skippedClassC.length} skipped pre-classified Class C, ` +
      `${report.failedAtRuntime.length} failed at runtime)`,
    );
    if (report.failedAtRuntime.length > 0) {
      // Every one of them, not the first five. A schema this size has a
      // standing tail of known-unappliable migrations (auth roles, realtime),
      // and truncating at five is what hid the one that actually mattered.
      console.log(`[pglite-migrate] runtime failures:`);
      for (const f of report.failedAtRuntime) {
        console.log(`  ${f.file}: ${f.error}`);
      }
    }

    return { pg, report };
  })();
  return memoized;
}

/** Isolated, non-memoized runner for rollout regressions that must seed the
 * exact pre-migration schema before one production migration is applied. */
export async function applyMigrationsToPgliteWithHook(
  beforeMigration: (args: {
    pg: PGlite;
    file: string;
    report: MigrationReport;
  }) => Promise<void>,
  options: {
    dataDir?: string;
    afterAccessStageCPreparation?: (args: {
      pg: PGlite;
      file: string;
      report: MigrationReport;
    }) => Promise<void>;
    authorizeAccessStageCRelease?: boolean;
    /** Stop after this exact migration FILE applied successfully. */
    stopAfter?: string;
    /** Stop after this 4-digit migration VERSION, applied or not. */
    stopAfterVersion?: string;
  } = {},
): Promise<PgliteMigratedFixture> {
  const pg = options.dataDir
    ? new PGlite(options.dataDir, { extensions: { pgcrypto, pg_trgm, vector } })
    : new PGlite({ extensions: { pgcrypto, pg_trgm, vector } });
  await applyStubs(pg);
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const report: MigrationReport = {
    applied: [],
    skippedClassC: [],
    failedAtRuntime: [],
  };

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const { skip, reason } = classify(sql);
    if (skip) {
      report.skippedClassC.push(`${file} (${reason})`);
      continue;
    }
    // Same aborted-transaction guard as applyMigrationsToPglite above.
    await pg.exec('rollback;').catch(() => undefined);
    try {
      await beforeMigration({ pg, file, report });
      const preparedSql = preprocess(sql);
      const markerIndex = preparedSql.indexOf(ACCESS_STAGE_C_RELEASE_GATE_MARKER);
      if (markerIndex >= 0 && options.afterAccessStageCPreparation) {
        await pg.exec(preparedSql.slice(0, markerIndex));
        await options.afterAccessStageCPreparation({ pg, file, report });
        await pg.exec(
          preparedSql.slice(markerIndex + ACCESS_STAGE_C_RELEASE_GATE_MARKER.length),
        );
      } else if (markerIndex >= 0 && options.authorizeAccessStageCRelease !== false) {
        await pg.exec(preparedSql.slice(0, markerIndex));
        await authorizeAccessStageCRelease(pg);
        await pg.exec(
          preparedSql.slice(markerIndex + ACCESS_STAGE_C_RELEASE_GATE_MARKER.length),
        );
      } else {
        await pg.exec(preparedSql);
      }
      report.applied.push(file);
      if (options.stopAfter === file) break;
    } catch (error) {
      report.failedAtRuntime.push({ file, error: describePgError(error) });
    }
    if (options.stopAfterVersion && file.startsWith(`${options.stopAfterVersion}_`)) {
      break;
    }
  }
  // A hook may deliberately make the final applied migration fail in order
  // to inspect its rollback boundary. Return a usable session to the caller
  // instead of leaking that aborted transaction into the next assertion.
  await pg.exec('rollback;').catch(() => undefined);
  return { pg, report };
}

/**
 * Apply the real schema through an explicit historical boundary.  This is
 * intentionally opt-in: the normal fixture remains all-migrations, while
 * Stage A/B compatibility tests can model the exact pre-0426 deployment that
 * legitimately still had the legacy receipt column.
 */
export function applyMigrationsToPgliteThrough(
  version: string,
): Promise<PgliteMigratedFixture> {
  if (!/^\d{4}$/.test(version)) {
    throw new Error(`invalid migration boundary: ${version}`);
  }
  return applyMigrationsToPgliteWithHook(
    async () => undefined,
    { stopAfterVersion: version },
  );
}

/**
 * Provision the external release attestation on the same PGlite session that
 * will execute the destructive suffix of 0426.  Production callers perform
 * the equivalent service-only RPC and session settings in their deployment
 * transaction; this helper keeps the integration fixture honest about that
 * boundary instead of weakening the migration gate.
 */
export async function authorizeAccessStageCRelease(
  pg: PGlite,
  options: {
    token?: string;
    nonce?: string;
    conversionManifestHash?: string;
    activeRelevantQueriesExcludingCurrent?: number;
    activeRelevantQueriesContract?: string;
  } = {},
): Promise<string> {
  const token = options.token ?? 'pglite-access-stage-c-release-token';
  const nonce = options.nonce ?? 'pglite-access-stage-c-fence-nonce';
  const activeRelevantQueriesExcludingCurrent =
    options.activeRelevantQueriesExcludingCurrent ?? 0;
  const activeRelevantQueriesContract =
    options.activeRelevantQueriesContract ?? ACCESS_STAGE_C_ACTIVE_RELEVANT_QUERIES_CONTRACT;
  const fenceEvidence = JSON.stringify({
    deploymentJob: 'pglite-access-stage-c-test',
    oldDeploymentStopped: true,
    legacyWriterFenceConfirmed: true,
    ...(options.conversionManifestHash
      ? {
          normalLegacyManifestHash: options.conversionManifestHash,
          normalLegacyManifestEncoding: 'canonical-utf8-concat-ws-newline',
          normalLegacyManifestBinding: `normalLegacyManifestHash=${options.conversionManifestHash}`,
          activeRelevantQueriesExcludingCurrent,
          activeRelevantQueriesContract,
          activeRelevantQueriesBinding:
            `activeRelevantQueriesExcludingCurrent=${activeRelevantQueriesExcludingCurrent}|activeRelevantQueriesContract=${activeRelevantQueriesContract}`,
        }
      : {}),
    nonce,
  });
  const fenceHash = createHash('sha256').update(fenceEvidence).digest('hex');
  const runResult = await pg.query<{ final_preflight_run_id: string }>(`
    select final_preflight_run_id
      from public.account_access_cutover_status
     where id is true
  `);
  const preflightRunId = runResult.rows[0]?.final_preflight_run_id;
  if (!preflightRunId) throw new Error('0426 release gate needs a preflight run');

  await pg.exec('begin; set local role service_role;');
  try {
    const receiptResult = await pg.query<{ value: { receiptId: string } }>(
      `select public.staxis_access_stage_c_record_release_receipt(
         $1, $2, $3, clock_timestamp(), $4, $5, $6, $7, $8, $9
       ) as value`,
      [
        'pglite-stage-c-operator',
        ACCESS_B_LIVE_SHA,
        CURRENT_LIVE_DESCENDANT_SHA,
        preflightRunId,
        'pglite-access-stage-c-test',
        fenceEvidence,
        fenceHash,
        nonce,
        token,
      ],
    );
    await pg.exec('commit;');
    const receiptId = receiptResult.rows[0]?.value?.receiptId;
    if (!receiptId) throw new Error('0426 release gate did not return a receipt id');
    await pg.query(
      `select
         set_config('staxis.access_stage_c_release_id', $1, false),
         set_config('staxis.access_stage_c_release_token', $2, false),
         set_config('staxis.access_stage_c_release_nonce', $3, false)`,
      [receiptId, token, nonce],
    );
    return receiptId;
  } catch (error) {
    await pg.exec('rollback;').catch(() => undefined);
    throw error;
  }
}

const CANONICAL_TEST_ACTOR_ACCOUNT = 'f4260000-0000-4000-8000-000000000001';
const CANONICAL_TEST_ACTOR_AUTH = 'f4261000-0000-4000-8000-000000000001';

/**
 * Give an account inserted by a post-0426 domain fixture an explicit
 * canonical bridge.  This keeps unrelated inventory/agent route tests from
 * using the retired receipt array merely as setup data while leaving their
 * production migration boundary at 0426.
 */
export async function seedCanonicalTestAuthority(
  pg: PGlite,
  options: { username: string; propertyIds: string[] },
): Promise<void> {
  await pg.query(
    `insert into auth.users(id, email) values ($1, 'canonical-test-actor@example.test')
     on conflict (id) do nothing`,
    [CANONICAL_TEST_ACTOR_AUTH],
  );
  await pg.query(
    `insert into public.accounts(id, username, password_hash, display_name, role, data_user_id)
     values ($1, 'canonical-test-actor', 'x', 'Canonical Test Actor', 'admin', $2)
     on conflict (id) do nothing`,
    [CANONICAL_TEST_ACTOR_ACCOUNT, CANONICAL_TEST_ACTOR_AUTH],
  );
  const account = await pg.query<{
    id: string;
    role: string;
    authority_version: number;
  }>(
    `select account.id, account.role, state.authority_version
       from public.accounts account
       join public.account_authorization_state state on state.account_id = account.id
      where account.username = $1`,
    [options.username],
  );
  const target = account.rows[0];
  if (!target) throw new Error(`missing canonical test account ${options.username}`);

  await pg.exec('begin; set local role service_role;');
  try {
    const result = await pg.query<{ value: Record<string, unknown> }>(
      `select public.staxis_set_account_authorization_scope(
         $1, $2, $3::uuid[], $4, $5, $6, $7
       ) as value`,
      [
        CANONICAL_TEST_ACTOR_ACCOUNT,
        target.id,
        options.propertyIds,
        target.authority_version,
        target.role,
        target.role,
        'canonical post-0426 integration fixture authority',
      ],
    );
    await pg.exec('commit;');
    const value = result.rows[0]?.value;
    if (!value || value.ok !== true) {
      throw new Error(`canonical test authority was rejected for ${options.username}: ${JSON.stringify(value)}`);
    }
  } catch (error) {
    await pg.exec('rollback;').catch(() => undefined);
    throw error;
  }
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
