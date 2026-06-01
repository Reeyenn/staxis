-- ═══════════════════════════════════════════════════════════════════════════
-- 0251 — Recognition / Kudos
--
-- A lightweight "recognition" log for the manager-only Staff page. A manager
-- picks a staff member, writes a short kudos (optionally tagged with a
-- category), and it's stored here. The recipient sees their recognition in
-- their own in-app Staff view (My Shifts). NO SMS — in-app only.
--
-- RLS posture — SERVICE-ROLE ONLY (mirrors equipment 0249 / compliance 0229 /
-- labor-wage 0245). Every read/write goes through /api/staff/kudos using
-- supabaseAdmin: this is an authenticated manager/staff surface, never a
-- public SMS-link page, so anon + authenticated are deny-all and the route
-- enforces requireSession + a management-role gate (giving) / self-or-manager
-- scope (reading). The 2026 convention is "service-role + API gate", not
-- direct anon-client access.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. staff_kudos — one row per recognition ───────────────────────────────
-- @rls: service-role-only — all UI access mediated by /api/staff/kudos via supabaseAdmin (authenticated manager/staff surface; matches equipment 0249).
create table if not exists public.staff_kudos (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  staff_id      uuid not null references public.staff(id) on delete cascade,      -- recipient
  given_by      uuid references public.accounts(id) on delete set null,           -- manager who gave it (null if account later deleted)
  given_by_name text,                                                             -- snapshot of giver's display name at give-time (survives account deletion / avoids a join)
  message       text not null check (char_length(message) between 1 and 500),
  category      text check (category in ('guest-praise','teamwork','above-and-beyond','attendance')),
  created_at    timestamptz not null default now()
);

comment on table public.staff_kudos is
  'Recognition/kudos a manager gives a staff member. property_id scoped, service-role-only. Read/written via /api/staff/kudos. In-app only — no SMS. Added 0251.';
comment on column public.staff_kudos.given_by_name is
  'Snapshot of the giving manager''s display name at give-time. Denormalized so the feed renders the giver even if the account is later removed.';
comment on column public.staff_kudos.category is
  'Optional tag: guest-praise | teamwork | above-and-beyond | attendance. NULL = untagged.';

-- Feed query is "recent kudos for a property, optionally for one recipient",
-- newest first — matches (property_id, staff_id, created_at desc).
create index if not exists staff_kudos_property_staff_created_idx
  on public.staff_kudos (property_id, staff_id, created_at desc);

-- ── 2. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.staff_kudos enable row level security;

revoke all on public.staff_kudos from public, anon, authenticated;
grant select, insert, update, delete on public.staff_kudos to service_role;

drop policy if exists staff_kudos_deny_all on public.staff_kudos;
create policy staff_kudos_deny_all on public.staff_kudos
  for all to anon, authenticated using (false) with check (false);

-- ── 3. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0251',
  'Recognition/Kudos: staff_kudos table (property_id + staff_id recipient + given_by accounts FK + given_by_name snapshot + message<=500 + optional category), service-role-only RLS, (property_id, staff_id, created_at desc) index. UI = manager-only Staff > Recognition tab; recipient read on My Shifts. Reads/writes via /api/staff/kudos. In-app only, no SMS.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
