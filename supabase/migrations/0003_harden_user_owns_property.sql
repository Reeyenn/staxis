-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Harden user_owns_property()
--
-- Why this exists:
--   user_owns_property() is declared `security definer`, which means it runs
--   with the function owner's privileges (typically postgres superuser) —
--   bypassing the RLS check that would otherwise recurse when the function
--   reads from the `accounts` table. That's correct and necessary.
--
--   But Postgres security-definer functions without an explicit search_path
--   are vulnerable to search-path injection: a caller whose role has CREATE
--   on any schema in their search_path can shadow built-in names (like
--   `exists` or `accounts`) and hijack the function. Supabase's security
--   linter flags this as a high-severity warning.
--
--   Fix: pin search_path to a minimal, explicit list of safe schemas. All
--   table references inside the function body then resolve only against
--   `public` and `pg_temp` (for type coercion), never a user-writable schema.
--
--   This is cosmetic on Supabase today (Supabase already locks down CREATE
--   grants on public), but it makes the function correct under any future
--   policy change and silences the security-definer-without-search-path lint.
--
-- Safe to re-run: the `create or replace` form replaces the existing
-- function in place without dropping any dependent policies.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function user_owns_property(p_id uuid) returns boolean
  language sql
  stable
  security definer
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

-- Revoke the default PUBLIC execute grant. Only roles we explicitly grant
-- can call this. anon/authenticated/service_role all inherit from the
-- defaults Supabase sets up, but we re-grant here to be explicit. This is
-- defense-in-depth — if a new role gets added down the line, it doesn't
-- silently inherit the ability to invoke this security-definer helper.
revoke all on function user_owns_property(uuid) from public;
grant execute on function user_owns_property(uuid) to anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Sanity comment: after applying this, verify with:
--
--   select proname, provolatile, prosecdef, proconfig
--   from pg_proc where proname = 'user_owns_property';
--
-- Expected:
--   proname            = user_owns_property
--   provolatile        = s         (stable)
--   prosecdef          = t         (security definer)
--   proconfig          = {search_path=public, pg_temp}
-- ═══════════════════════════════════════════════════════════════════════════
