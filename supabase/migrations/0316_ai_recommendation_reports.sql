-- 0316 — Saved AI Control Center recommendation reports.
--
-- Every "Get recommendations" run is persisted so the admin can reopen past
-- advice with its timestamp. Fleet-wide admin data (no property scoping):
-- browser roles are denied outright and the service role reads/writes on
-- behalf of admin-gated routes only, same pattern as 0313's control tables.

begin;

-- @rls: service-role-only — fleet-wide admin advisory reports.
create table if not exists public.ai_recommendation_reports (
  id               uuid primary key default gen_random_uuid(),
  generated_at     timestamptz not null default now(),
  model_used       text not null check (char_length(model_used) between 1 and 200),
  spend_30d_usd    numeric(12, 2) not null default 0,
  recommendations  jsonb not null default '[]'::jsonb
                   check (jsonb_typeof(recommendations) = 'array'),
  created_by       uuid references public.accounts(id) on delete set null,
  created_by_email text check (created_by_email is null or char_length(created_by_email) <= 320)
);

create index if not exists ai_recommendation_reports_recent_idx
  on public.ai_recommendation_reports(generated_at desc);

alter table public.ai_recommendation_reports enable row level security;
drop policy if exists ai_recommendation_reports_deny_browser on public.ai_recommendation_reports;
create policy ai_recommendation_reports_deny_browser on public.ai_recommendation_reports
  for all to anon, authenticated using (false) with check (false);
revoke all on public.ai_recommendation_reports from public, anon, authenticated;
grant select, insert, delete on public.ai_recommendation_reports to service_role;

comment on table public.ai_recommendation_reports is
  'Saved AI Control Center recommendation runs (advice history). Service-role only; surfaced via admin-gated routes.';

insert into public.applied_migrations (version, description)
values ('0316', 'AI Control Center: persisted recommendation reports (advice history)')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
