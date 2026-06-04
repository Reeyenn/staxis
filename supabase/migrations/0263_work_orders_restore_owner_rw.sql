-- 0263 — Reconcile work_orders RLS / grants / realtime drift back to the
--        migration-defined intent.
--
-- What was wrong (found 2026-06-04):
--   The LIVE database had drifted from the tracked migrations for work_orders:
--     • a service-role-only `work_orders_deny_all_browser` policy was present,
--     • the anon/authenticated table grants were revoked, and
--     • work_orders was absent from the supabase_realtime publication.
--   NONE of that is in any migration — it was applied out-of-band. (0200, the
--   tenant-isolation hardening, locks 9 specific tables and does NOT touch
--   work_orders.) The tracked migrations define work_orders as owner-scoped,
--   MFA-gated, browser-accessible — "owner rw work_orders" created in 0001 and
--   given the MFA gate in 0161 — exactly like its sibling preventive_tasks.
--
-- Impact of the drift:
--   The browser supabase client (role = authenticated) could not read OR write
--   work_orders. That silently broke every browser surface that uses it:
--     • Maintenance → Work Orders board (submit did nothing / list was empty),
--     • Dashboard "urgent work orders" count (stuck at 0),
--     • Housekeeping → Rooms tab work-order indicators.
--   Unnoticed because the live app currently has no active users.
--
-- Fix: restore the intended state. Owner + MFA scoping is preserved (this is
--   NOT a widening — identical protection to every other owner-rw tenant
--   table), so a browser user still only sees/edits work orders for properties
--   they own, and only when MFA-verified.

-- 1. Remove the out-of-band deny-all policy.
drop policy if exists work_orders_deny_all_browser on public.work_orders;

-- 2. Restore the table grants the drift revoked. RLS (below) is the real gate;
--    anon is still blocked by user_owns_property() (needs auth.uid()).
grant select, insert, update, delete on public.work_orders to anon, authenticated;

-- 3. Restore the owner-rw, MFA-gated policy (0001 create + 0161 MFA), idempotent.
drop policy if exists "owner rw work_orders" on public.work_orders;
create policy "owner rw work_orders" on public.work_orders
  for all
  using ((user_owns_property(property_id)) and public.mfa_verified_or_grace())
  with check ((user_owns_property(property_id)) and public.mfa_verified_or_grace());

-- 4. Re-add to the realtime publication so the board updates live + refreshes
--    after a submit (matching preventive_tasks). Guarded — re-adding errors.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_orders'
  ) then
    alter publication supabase_realtime add table public.work_orders;
  end if;
end $$;

-- Self-register for the migration-bookkeeping check + doctor.
insert into public.applied_migrations (version, description)
values (
  '0263',
  'Reconcile work_orders drift back to migration intent: restore owner-rw MFA policy + anon/authenticated grants + realtime publication membership (browser access the Maintenance board, Dashboard urgent count, and Rooms tab all rely on; the deny-all lockdown was out-of-band, in no migration).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
