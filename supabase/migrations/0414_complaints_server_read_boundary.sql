-- 0414_complaints_server_read_boundary.sql
--
-- Complaints contain guest names/contact details and free-text service-
-- recovery notes. Broad property read reach cannot express the intended
-- manager/front-desk boundary, so raw rows now leave PostgREST/realtime and
-- are served only through authoritative, least-data API projections.

begin;

drop policy if exists "owner read complaints" on public.complaints;
drop policy if exists complaints_deny_browser_select on public.complaints;
create policy complaints_deny_browser_select
  on public.complaints for select to anon, authenticated
  using (false);

revoke select on public.complaints from public, anon, authenticated;
grant select, insert, update, delete on public.complaints to service_role;

do $remove_complaints_realtime$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'complaints'
  ) then
    execute 'alter publication supabase_realtime drop table public.complaints';
  end if;
end
$remove_complaints_realtime$;

insert into public.applied_migrations(version, description)
values (
  '0414',
  'Route-only complaint reads with authoritative role checks and count-only dashboard projection'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
