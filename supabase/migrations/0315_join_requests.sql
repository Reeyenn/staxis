-- 0315: join_requests — staff signups via the shared join code/link now land
-- as PENDING and get zero property access until a manager approves them
-- from the Staff Directory. Approval creates the staff row, links
-- accounts.staff_id, and appends property_access in one server-side action.
--
-- Access model: service-role only. No anon/authenticated policies on
-- purpose — every read/write goes through /api routes (supabaseAdmin), so
-- the pending queue and its PII (phone numbers) never travel over the anon
-- client. RLS is enabled with no policies = deny-all for non-service roles.

-- @rls: service-role-only — pending-signup queue with PII (phone numbers);
-- read/written exclusively by /api routes via supabaseAdmin, never the
-- browser client. RLS enabled with zero policies = deny-all for anon/authed.
create table if not exists join_requests (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  account_id    uuid not null references accounts(id) on delete cascade,
  name          text not null,
  phone         text,
  language      text not null default 'en' check (language in ('en','es')),
  department    text not null check (department in ('housekeeping','front_desk','maintenance','other')),
  status        text not null default 'pending' check (status in ('pending','approved','denied')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references accounts(id) on delete set null
);

-- One live pending request per account per hotel; re-request allowed after
-- a denial (the old row keeps status='denied').
create unique index if not exists join_requests_pending_unique
  on join_requests (property_id, account_id) where status = 'pending';

create index if not exists join_requests_property_status_idx
  on join_requests (property_id, status, created_at desc);
create index if not exists join_requests_account_idx
  on join_requests (account_id, created_at desc);

alter table join_requests enable row level security;

insert into public.applied_migrations (version, description)
values ('0315', 'join_requests: pending staff signups awaiting manager approval')
on conflict (version) do nothing;
