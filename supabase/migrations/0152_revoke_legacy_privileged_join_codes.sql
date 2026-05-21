-- 0152 — Revoke legacy owner/GM hotel_join_codes and forbid future ones.
--
-- F-06 in the core-web/auth/RLS security plan. The /api/auth/use-join-code
-- redemption path unconditionally rewrites properties.owner_id when the
-- baked role on the code is 'owner' (use-join-code/route.ts line 251-267).
-- That makes possession of an unrevoked legacy owner code an ownership-
-- transfer primitive against an existing hotel. GM codes are nearly as bad
-- (GMs can issue further invites/codes).
--
-- The /api/auth/join-codes create route now inserts role=null (new-flow),
-- so only legacy/manual rows are affected. We close the redemption hole
-- with the route-level gate already shipped in the same commit; this
-- migration cleans up existing data and enforces the invariant at the DB
-- so a service-role write that bypasses the route can't reopen it.
--
-- Idempotent. Safe to re-run.

-- 1. Revoke any unrevoked legacy owner/GM codes. We don't delete — keeping
--    the rows preserves audit history (who created what, when). The redeem
--    path already short-circuits on revoked_at being non-null.
update public.hotel_join_codes
   set revoked_at = now()
 where role in ('owner', 'general_manager')
   and revoked_at is null;

-- 2. CHECK: future rows must have role IS NULL (new flow) or in the
--    self-assignable staff set. Idempotent — drop the constraint first if
--    it exists from a prior partial run.
alter table public.hotel_join_codes
  drop constraint if exists hotel_join_codes_role_check_no_privileged;

alter table public.hotel_join_codes
  add constraint hotel_join_codes_role_check_no_privileged
  check (
    role is null
    or role in ('front_desk', 'housekeeping', 'maintenance')
  );

-- Bookkeeping
insert into public.applied_migrations (version, description)
values (
  '0152',
  'F-06: revoke legacy owner/GM hotel_join_codes + CHECK forbidding new privileged rows'
)
on conflict (version) do nothing;
