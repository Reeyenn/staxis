-- 0067_invites_and_join_codes_rls.sql
-- account_invites and hotel_join_codes both have RLS enabled today but
-- ZERO policies — meaning the deny-all default applies to anon and
-- authenticated. The /api/auth/* routes that read/write them go through
-- supabaseAdmin (service-role), which bypasses RLS, so today's flows
-- work. But "RLS on, no policies" is a footgun: any future contributor
-- who reads the schema might assume the tables are exposed and call
-- them from a session-authenticated client. The query would silently
-- return [] — exactly the bug class that bit us 3x on the housekeeper
-- public pages (silent empty state from RLS-restricted anon reads).
--
-- This migration adds EXPLICIT policies so the intent is on the page:
-- "authenticated users who own the hotel can manage invites and join
-- codes for it." Service-role still bypasses (existing routes unchanged).
-- Anon still has no access (must go through API — same as today).
--
-- Helper used: public.user_owns_property(p_id uuid) returns boolean —
-- the same function used across rooms/staff/inventory/etc RLS policies
-- (defined in migration 0003). It returns true if the calling user's
-- accounts.property_access array contains p_id OR they're an admin.

-- account_invites
drop policy if exists account_invites_manage_for_own_hotels on public.account_invites;
create policy account_invites_manage_for_own_hotels
  on public.account_invites
  for all
  to authenticated
  using (public.user_owns_property(hotel_id))
  with check (public.user_owns_property(hotel_id));

comment on policy account_invites_manage_for_own_hotels on public.account_invites is
  'Authenticated managers can read + create + cancel invites for hotels they own. Service-role bypasses RLS so /api/auth/invites/* keeps working. Anon has no policy → no access → must go through API.';

-- hotel_join_codes
drop policy if exists hotel_join_codes_manage_for_own_hotels on public.hotel_join_codes;
create policy hotel_join_codes_manage_for_own_hotels
  on public.hotel_join_codes
  for all
  to authenticated
  using (public.user_owns_property(hotel_id))
  with check (public.user_owns_property(hotel_id));

comment on policy hotel_join_codes_manage_for_own_hotels on public.hotel_join_codes is
  'Authenticated managers can read + create + rotate + revoke join codes for hotels they own. Service-role bypasses RLS so /api/auth/join-codes/* and /api/auth/use-join-code keep working. Anon must hit the API (which uses supabaseAdmin to look codes up by token).';

-- Bookkeeping
insert into public.applied_migrations (version, description)
values ('0067', 'explicit RLS policies for account_invites and hotel_join_codes (defense-in-depth)')
on conflict (version) do nothing;
