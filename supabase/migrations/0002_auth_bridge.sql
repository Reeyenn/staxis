-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Auth bridge migration
--
-- Problem this solves:
--   v1 schema assumed a 1:1 mapping between auth.users and properties via
--   `properties.owner_id = auth.uid()`. Real world: one hotel has multiple
--   real humans logging in (Maria the owner, Jay the manager, housekeeping
--   leads on a shared staff login). Each needs their OWN Supabase Auth
--   identity (distinct email + password) but they all need to see the same
--   property data.
--
--   The `accounts` table is the join: accounts.data_user_id points to the
--   account's own auth.users.id. The accounts row also carries `role`
--   (admin/owner/staff) and `property_access uuid[]` — the list of
--   properties this account may access. Admins see everything; owners/staff
--   see only what's in property_access.
--
-- Schema changes:
--   • Make password_hash NULLABLE — Supabase Auth owns passwords now. We
--     retain the column for potential future use (e.g., migrating from a
--     bcrypt system) but it's no longer the source of truth. New accounts
--     will have NULL here.
--   • Add a CHECK constraint on accounts.role to match the TypeScript union
--     ('admin' | 'owner' | 'staff').
--   • Rewrite user_owns_property() to resolve through accounts.property_access.
--   • Rewrite properties RLS policies to allow multi-account access.
--   • Add an "accounts can read own row" policy so AuthContext can fetch the
--     logged-in user's role/displayName/propertyAccess client-side without
--     round-tripping through an API route.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. password_hash is now optional (Supabase Auth is the authority) ──────────
alter table accounts alter column password_hash drop not null;

-- 2. role check constraint matches TS union ──────────────────────────────────
alter table accounts drop constraint if exists accounts_role_check;
alter table accounts add constraint accounts_role_check
  check (role in ('admin','owner','staff'));

-- Default moves from 'manager' (legacy) to 'staff' to match TS default.
alter table accounts alter column role set default 'staff';

-- 3. Rewrite user_owns_property() to resolve through accounts ────────────────
-- Old: checks properties.owner_id = auth.uid()
-- New: checks that there is an account row with data_user_id = auth.uid()
--      whose role='admin' OR whose property_access contains the property id.
--
-- security definer so the function can read accounts even when the caller's
-- RLS would hide non-own rows.
create or replace function user_owns_property(p_id uuid) returns boolean as $$
  select exists (
    select 1 from accounts a
    where a.data_user_id = auth.uid()
      and (
        a.role = 'admin'
        or p_id = any (a.property_access)
      )
  );
$$ language sql stable security definer;

-- 4. Rewrite properties policies to use the same helper ──────────────────────
drop policy if exists "owner can read properties"   on properties;
drop policy if exists "owner can insert properties" on properties;
drop policy if exists "owner can update properties" on properties;
drop policy if exists "owner can delete properties" on properties;

-- Anyone with access to the property (via accounts.property_access or
-- admin role) can read it.
create policy "account can read properties"
  on properties for select
  using (user_owns_property(id));

-- Only admin accounts can create/update/delete property records. This
-- prevents a "staff" login from accidentally renaming a hotel.
create policy "admin can insert properties"
  on properties for insert
  with check (exists (
    select 1 from accounts a
    where a.data_user_id = auth.uid() and a.role = 'admin'
  ));
create policy "admin can update properties"
  on properties for update
  using (exists (
    select 1 from accounts a
    where a.data_user_id = auth.uid() and a.role = 'admin'
  ))
  with check (exists (
    select 1 from accounts a
    where a.data_user_id = auth.uid() and a.role = 'admin'
  ));
create policy "admin can delete properties"
  on properties for delete
  using (exists (
    select 1 from accounts a
    where a.data_user_id = auth.uid() and a.role = 'admin'
  ));

-- 5. Accounts policies ───────────────────────────────────────────────────────
-- Admin CRUD still flows through the service-role API route (/api/auth/accounts).
-- But the *logged-in user* needs to read their OWN row at app boot to populate
-- role + displayName + propertyAccess in AuthContext. So:
--   • read self: allowed
--   • read others: denied (service role only, via admin API)
--   • write: denied (service role only, via admin API)

drop policy if exists "account can read self" on accounts;
create policy "account can read self"
  on accounts for select
  using (data_user_id = auth.uid());

-- Service role bypasses RLS entirely, so no insert/update/delete policies
-- for `authenticated` — admin API handles all writes.
