/**
 * pglite bootstrap helper for RLS integration tests.
 *
 * Spins up a fresh in-memory Postgres via @electric-sql/pglite, creates the
 * Supabase-style role + auth schema stub, and applies a MINIMAL subset of
 * the production migrations that's sufficient to test tenant isolation
 * end-to-end.
 *
 * We do NOT try to apply all 148 production migrations — many depend on
 * Supabase extensions/auth tables that pglite doesn't ship. The minimal
 * fixture is sufficient because what we're testing is the *RLS contract*:
 *   - user_owns_property(uuid) returns true ⇔ caller's auth.uid() is on the
 *     accounts row with that property in property_access[].
 *   - Per-property tables with `for all using (user_owns_property(property_id))`
 *     correctly deny cross-tenant SELECT/INSERT/UPDATE/DELETE.
 * If those mechanics work on a clean schema, they work in production. The
 * production schema differs only in adding MORE policies, never relaxing
 * the canonical pattern.
 *
 * Future work (out of this worktree): apply more of the real migrations
 * incrementally to broaden the integration surface, with appropriate
 * Supabase auth/realtime stubs.
 */

import { PGlite } from '@electric-sql/pglite';

export type PgliteFixture = {
  pg: PGlite;
  /** Run a statement as the service role (bypasses RLS via superuser). */
  runAsService: (sql: string, params?: unknown[]) => Promise<unknown>;
  /** Run a statement as `authenticated` with the given JWT sub claim. */
  runAsUser: (
    userId: string,
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

export async function setupRlsFixture(): Promise<PgliteFixture> {
  const pg = new PGlite();

  // 1. Roles + auth schema stub.
  //
  // Supabase ships with three roles:
  //   - anon          (unauthenticated)
  //   - authenticated (signed-in user)
  //   - service_role  (admin; BYPASSRLS)
  // pglite starts with only postgres + role-less, so we declare them.
  //
  // auth.uid() reads from a session GUC (`request.jwt.claim.sub`) which
  // Supabase normally sets from the validated JWT. We simulate the same
  // contract via `set local request.jwt.claim.sub = '<uid>'`.
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role bypassrls nologin;

    create schema if not exists auth;
    create or replace function auth.uid() returns uuid
      language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create or replace function auth.role() returns text
      language sql stable as $$
      select current_setting('request.jwt.claim.role', true);
    $$;
  `);

  // 2. Apply the canonical schema: accounts + user_owns_property + a
  //    representative per-property table (rooms). Mirrors the production
  //    pattern from 0001_initial_schema.sql + 0003_harden_user_owns_property.
  await pg.exec(`
    create table accounts (
      id uuid primary key default gen_random_uuid(),
      data_user_id uuid not null,
      role text,
      property_access uuid[] not null default '{}'
    );

    create table rooms (
      id uuid primary key default gen_random_uuid(),
      property_id uuid not null,
      number text not null
    );

    create table work_orders (
      id uuid primary key default gen_random_uuid(),
      property_id uuid not null,
      title text not null,
      status text not null default 'open'
    );

    -- Canonical user_owns_property — identical body to the production
    -- function (src: 0003_harden_user_owns_property.sql).
    create or replace function user_owns_property(p_id uuid) returns boolean
      language sql stable security definer
      set search_path = public, pg_temp
    as $$
      select exists (
        select 1 from public.accounts a
        where a.data_user_id = auth.uid()
          and (
            a.role = 'admin'
            or p_id = any (a.property_access)
          )
      );
    $$;
    revoke all on function user_owns_property(uuid) from public;
    grant execute on function user_owns_property(uuid) to anon, authenticated, service_role;

    -- accounts RLS (mirrors 0017). We GRANT all DML to authenticated so
    -- the GATE is RLS (matching Supabase's default permissive grants).
    -- Without the grant, writes would fail with "permission denied" which
    -- is a different code path from RLS rejection.
    alter table accounts enable row level security;
    create policy accounts_self_select on accounts
      for select to authenticated
      using (data_user_id = auth.uid());
    create policy accounts_deny_writes on accounts
      for all to anon, authenticated
      using (false) with check (false);
    grant select, insert, update, delete on accounts to authenticated;

    -- rooms RLS (canonical per-property pattern from 0001).
    alter table rooms enable row level security;
    create policy "owner rw rooms" on rooms for all
      using (user_owns_property(property_id))
      with check (user_owns_property(property_id));
    grant select, insert, update, delete on rooms to authenticated;

    -- work_orders RLS (same canonical pattern, second table for cross-table
    -- coverage).
    alter table work_orders enable row level security;
    create policy "owner rw work_orders" on work_orders for all
      using (user_owns_property(property_id))
      with check (user_owns_property(property_id));
    grant select, insert, update, delete on work_orders to authenticated;
  `);

  const runAsService = async (sql: string, params?: unknown[]) => {
    if (params && params.length > 0) {
      return pg.query(sql, params);
    }
    return pg.exec(sql);
  };

  const runAsUser = async (
    userId: string,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    // Wrap in a transaction so SET LOCAL is scoped to this call only.
    await pg.exec('begin');
    try {
      await pg.exec(`set local role authenticated`);
      // request.jwt.claim.sub is plain text in a custom GUC; quote-safe via
      // the parameter form. Use pg.query for parameterization.
      await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      let result: { rows: Record<string, unknown>[] };
      if (params && params.length > 0) {
        result = (await pg.query(sql, params)) as { rows: Record<string, unknown>[] };
      } else {
        const r = await pg.exec(sql);
        // pg.exec returns an array of statement results; take the last one
        // with rows.
        const rows: Record<string, unknown>[] = [];
        for (const s of r) {
          if (s && Array.isArray((s as { rows: unknown[] }).rows)) {
            for (const row of (s as { rows: Record<string, unknown>[] }).rows) {
              rows.push(row);
            }
          }
        }
        result = { rows };
      }
      await pg.exec('commit');
      return result;
    } catch (e) {
      await pg.exec('rollback').catch(() => undefined);
      throw e;
    }
  };

  return { pg, runAsService, runAsUser };
}
