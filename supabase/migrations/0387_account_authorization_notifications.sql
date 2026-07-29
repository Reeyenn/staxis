-- 0387_account_authorization_notifications.sql
--
-- Safe Realtime invalidation for long-lived browser sessions. Never publish
-- `accounts`: it contains password_hash and legacy scope data. This projection
-- exposes only the caller's opaque authorization version; the browser must
-- still fetch /api/auth/session-authorization for an actual verdict.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null then
    raise exception '0387 requires authoritative access migration 0378';
  end if;
end
$$;

-- @rls: authenticated self-read only; service writes through the state trigger.
create table if not exists public.account_authorization_notifications (
  account_id         uuid primary key references public.accounts(id) on delete cascade,
  data_user_id       uuid not null references auth.users(id) on delete cascade,
  authority_version  bigint not null,
  updated_at         timestamptz not null default now(),
  constraint account_authorization_notifications_version_check
    check (authority_version > 0)
);

comment on table public.account_authorization_notifications is
  'Non-sensitive self-visible Realtime invalidation only. It conveys no role, capability, organization or hotel scope; clients must re-read the server authorization endpoint. Added 0387.';

create or replace function public._staxis_publish_account_authorization_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.account_authorization_notifications (
    account_id, data_user_id, authority_version, updated_at
  )
  select new.account_id, account.data_user_id, new.authority_version, clock_timestamp()
    from public.accounts account
   where account.id = new.account_id
  on conflict (account_id) do update
    set data_user_id = excluded.data_user_id,
        authority_version = excluded.authority_version,
        updated_at = excluded.updated_at;
  return new;
end;
$$;

revoke all on function public._staxis_publish_account_authorization_notification()
  from public, anon, authenticated;

drop trigger if exists trg_account_authorization_state_notification
  on public.account_authorization_state;
create trigger trg_account_authorization_state_notification
  after insert or update of authority_version
  on public.account_authorization_state
  for each row execute function public._staxis_publish_account_authorization_notification();

insert into public.account_authorization_notifications (
  account_id, data_user_id, authority_version, updated_at
)
select state.account_id, account.data_user_id, state.authority_version, state.updated_at
  from public.account_authorization_state state
  join public.accounts account on account.id = state.account_id
on conflict (account_id) do update
  set data_user_id = excluded.data_user_id,
      authority_version = excluded.authority_version,
      updated_at = excluded.updated_at;

alter table public.account_authorization_notifications enable row level security;
revoke all on public.account_authorization_notifications from public, anon, authenticated;
grant select on public.account_authorization_notifications to authenticated;

drop policy if exists account_authorization_notifications_self_select
  on public.account_authorization_notifications;
create policy account_authorization_notifications_self_select
  on public.account_authorization_notifications
  for select to authenticated
  using (
    data_user_id = auth.uid()
    and public.mfa_verified_or_grace()
  );

drop policy if exists account_authorization_notifications_deny_browser_writes
  on public.account_authorization_notifications;
create policy account_authorization_notifications_deny_browser_writes
  on public.account_authorization_notifications
  for all to anon, authenticated
  using (false)
  with check (false);

-- The projected row contains no password, role, company or property data.
-- FULL identity lets UPDATE invalidations remain filterable under RLS.
alter table public.account_authorization_notifications replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'account_authorization_notifications'
     ) then
    alter publication supabase_realtime
      add table public.account_authorization_notifications;
  end if;
end
$$;

insert into public.applied_migrations(version, description)
values (
  '0387',
  'Safe self-only Realtime authorization-version invalidation for immediate open-session role and scope revocation.'
)
on conflict (version) do nothing;

commit;
