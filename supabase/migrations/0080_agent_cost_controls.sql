-- Migration 0080: agent_costs — per-request spend ledger for the agent layer
--
-- Cheapest insurance in the system. Before every LLM call we sum recent
-- agent_costs rows and reject the request if the user/property/global
-- daily cap is hit. Same table powers the /admin/agent monitoring page
-- (today's spend, top spenders, cost per tool).
--
-- agent_messages.cost_usd ALREADY exists (from 0079) and we'll keep
-- writing there too — that captures "cost per turn" for replay. This
-- new table captures "cost per request" for accounting (one row per
-- /api/agent/command call, including the input prompt+context cost
-- that doesn't belong to any single message row).

create table if not exists public.agent_costs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  conversation_id uuid references public.agent_conversations(id) on delete set null,
  model text not null,         -- 'haiku' | 'sonnet' | 'opus' | etc
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cached_input_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null,
  -- 'request' = a full /api/agent/command call (may include multiple tool iterations)
  -- 'eval'    = an eval suite run (separate so it doesn't count against user caps)
  kind text not null default 'request' check (kind in ('request', 'eval', 'background')),
  created_at timestamptz not null default now()
);

-- Hot path: SUM(cost_usd) for a user since midnight (cap enforcement).
create index if not exists agent_costs_user_day_idx
  on public.agent_costs(user_id, created_at desc);

-- Property-level rollup for the monitoring page + property cap.
create index if not exists agent_costs_property_day_idx
  on public.agent_costs(property_id, created_at desc);

-- Global daily roll-up for the global cap + spend dashboard.
create index if not exists agent_costs_day_idx
  on public.agent_costs(created_at desc);

-- RLS: users can see their own spend. Admins (service-role bypass) see all.
alter table public.agent_costs enable row level security;

create policy "agent_costs_select_own"
  on public.agent_costs
  for select
  using (
    exists (
      select 1 from public.accounts a
      where a.id = agent_costs.user_id
        and a.data_user_id = auth.uid()
    )
  );

insert into public.applied_migrations (version, description)
values ('0080', 'Agent layer: per-request cost ledger (caps + rate limiting)')
on conflict (version) do nothing;
