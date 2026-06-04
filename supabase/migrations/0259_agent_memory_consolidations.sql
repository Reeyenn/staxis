-- ═══════════════════════════════════════════════════════════════════════════
-- 0259 — Nightly memory consolidation runs ("what Staxis learned about your hotel")
--
-- Self-learning Move #2 (pairs with the 0256 agent_memory table). A nightly cron
-- reviews each hotel's recent copilot conversations, extracts durable facts, and
-- AUTO-SAVES them to agent_memory (source='consolidation', low confidence,
-- expiring). Each run records a row here so the dashboard "What Staxis learned"
-- card can show the latest recap + counts, and so we don't double-run a day.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY (mirrors agent_memory 0256). Written by the
-- cron via supabaseAdmin; read by /api/memory/recap (supabaseAdmin behind a
-- session + management gate). anon + authenticated are deny-all.
-- ═══════════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — written by the consolidation cron; read via /api/memory/recap (session + canManageTeam). No anon/authenticated path.
create table if not exists public.agent_memory_consolidations (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references public.properties(id) on delete cascade,
  run_date               date not null,                 -- property-local date of the run
  ran_at                 timestamptz not null default now(),
  recap                  text,                           -- one-paragraph "here's what I learned"
  learned_count          integer not null default 0,     -- new facts stored
  updated_count          integer not null default 0,     -- existing facts reinforced
  conversations_reviewed integer not null default 0,
  model                  text,
  model_id               text,
  cost_usd               numeric not null default 0,
  created_at             timestamptz not null default now()
);

comment on table public.agent_memory_consolidations is
  'Nightly memory-consolidation run log per property (self-learning Move #2). One row per property per run_date; powers the dashboard "What Staxis learned" recap. Service-role-only. Added 0259.';

-- One run per property per day (idempotent-friendly; the cron upserts).
create unique index if not exists agent_memory_consolidations_property_date_key
  on public.agent_memory_consolidations (property_id, run_date);
create index if not exists agent_memory_consolidations_property_ran_idx
  on public.agent_memory_consolidations (property_id, ran_at desc);

-- RLS: service-role only; anon + authenticated deny-all.
alter table public.agent_memory_consolidations enable row level security;
revoke all on public.agent_memory_consolidations from public, anon, authenticated;
grant select, insert, update, delete on public.agent_memory_consolidations to service_role;
drop policy if exists agent_memory_consolidations_deny_all on public.agent_memory_consolidations;
create policy agent_memory_consolidations_deny_all on public.agent_memory_consolidations
  for all to anon, authenticated using (false) with check (false);

insert into public.applied_migrations (version, description)
values (
  '0259',
  'agent_memory_consolidations: nightly memory-consolidation run log per property (self-learning Move #2). Service-role-only (deny-all); powers the dashboard "What Staxis learned" recap.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
