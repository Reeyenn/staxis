-- Migration 0079: agent layer (chat + nudges)
--
-- Foundation for THE central AI brain (src/lib/agent/). Three tables:
--
--   agent_conversations — one row per chat session a user opens. Locked to
--     a property + role context at creation time so the tool catalog stays
--     consistent even if the user's role changes mid-conversation.
--
--   agent_messages — every turn in a conversation. Mirrors the Anthropic
--     messages format (role: user|assistant|tool). Tool calls and tool
--     results are persisted alongside content so we can replay the exact
--     model state when debugging "the AI answered wrong" reports.
--
--   agent_nudges — proactive engine output. Vercel Cron polls every 5 min,
--     fires nudges when trigger conditions met. Surfaces as system messages
--     in the chat (any surface — chat UI, voice, walkthrough).
--
-- RLS: users can only see their own conversations + their property's
-- nudges. The service role bypasses all of this (server-side endpoints
-- write on behalf of users via supabaseAdmin per the rest of the codebase).

-- ─── agent_conversations ────────────────────────────────────────────────
create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  role text not null check (role in (
    'admin', 'owner', 'general_manager', 'front_desk',
    'housekeeping', 'maintenance', 'staff'
  )),
  title text,
  -- Which prompt version was active at conversation start. Lets us correlate
  -- behaviour shifts to specific prompt commits when running evals.
  prompt_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_conversations_user_updated_idx
  on public.agent_conversations(user_id, updated_at desc);

create index if not exists agent_conversations_property_idx
  on public.agent_conversations(property_id);

-- ─── agent_messages ─────────────────────────────────────────────────────
-- One row per turn. `role` mirrors Anthropic's messages format:
--   user      — what the human typed (or what STT transcribed)
--   assistant — what the model said
--   tool      — tool result fed back to the model
--
-- Tool calls live on assistant rows (tool_name + tool_args). Tool results
-- live on tool rows (tool_call_id + tool_result). The two are correlated
-- by tool_call_id so we can reconstruct call/result pairs deterministically.
create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text,
  -- Tool call (set when role='assistant' and the model requested a tool)
  tool_call_id text,
  tool_name text,
  tool_args jsonb,
  -- Tool result (set when role='tool' answering a prior call)
  tool_result jsonb,
  -- Telemetry — populated when we have it (assistant rows from the API call).
  tokens_in integer,
  tokens_out integer,
  model_used text, -- 'haiku' | 'sonnet' | 'opus' | other
  cost_usd numeric(10, 6),
  created_at timestamptz not null default now()
);

create index if not exists agent_messages_conversation_created_idx
  on public.agent_messages(conversation_id, created_at);

-- ─── agent_nudges ───────────────────────────────────────────────────────
-- Proactive output. The 4 categories Reeyen approved:
--   operational         — overdue rooms, unresolved help, missed shifts
--   daily_summary       — 8pm property-local rollup
--   inventory           — supply thresholds + request backlog
--   revenue_occupancy   — anomalies vs forecast / rolling average
create table if not exists public.agent_nudges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  category text not null check (category in (
    'operational', 'daily_summary', 'inventory', 'revenue_occupancy'
  )),
  severity text not null default 'info' check (severity in ('info', 'warning', 'urgent')),
  -- Free-form structured payload. Schema varies by category. Always include
  -- a 'summary' string the chat surface renders directly when the user has
  -- no conversation open yet.
  payload jsonb not null,
  -- Dedupe key: if a nudge with the same category+key already exists in
  -- 'pending' state for this user, the cron re-checker skips inserting a
  -- duplicate. Example: dedupe_key='overdue_room:r-302' so we don't fire
  -- the same overdue alert every 5 minutes.
  dedupe_key text,
  status text not null default 'pending' check (status in (
    'pending', 'acknowledged', 'dismissed', 'snoozed'
  )),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create index if not exists agent_nudges_user_status_idx
  on public.agent_nudges(user_id, status, created_at desc);

create index if not exists agent_nudges_property_status_idx
  on public.agent_nudges(property_id, status, created_at desc);

create unique index if not exists agent_nudges_active_dedupe_uq
  on public.agent_nudges(user_id, category, dedupe_key)
  where status = 'pending' and dedupe_key is not null;

-- ─── RLS ────────────────────────────────────────────────────────────────
-- Reads: users see their own conversations + messages + nudges.
-- Writes: server endpoints use supabaseAdmin (service_role) — bypasses RLS.
-- Direct user writes from the browser are not supported (no policy added).
alter table public.agent_conversations enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_nudges enable row level security;

-- Helper: does the auth.uid() map to the account row that owns this
-- conversation? accounts.data_user_id is the bridge between auth.users.id
-- and accounts.id (see AuthContext.tsx for the canonical explanation).
create policy "agent_conversations_select_own"
  on public.agent_conversations
  for select
  using (
    exists (
      select 1 from public.accounts a
      where a.id = agent_conversations.user_id
        and a.data_user_id = auth.uid()
    )
  );

create policy "agent_messages_select_own"
  on public.agent_messages
  for select
  using (
    exists (
      select 1
      from public.agent_conversations c
      join public.accounts a on a.id = c.user_id
      where c.id = agent_messages.conversation_id
        and a.data_user_id = auth.uid()
    )
  );

create policy "agent_nudges_select_own"
  on public.agent_nudges
  for select
  using (
    exists (
      select 1 from public.accounts a
      where a.id = agent_nudges.user_id
        and a.data_user_id = auth.uid()
    )
  );

-- Allow users to ack/dismiss their own nudges directly from the browser
-- without an API round-trip (cheap, common operation).
create policy "agent_nudges_update_own_status"
  on public.agent_nudges
  for update
  using (
    exists (
      select 1 from public.accounts a
      where a.id = agent_nudges.user_id
        and a.data_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.accounts a
      where a.id = agent_nudges.user_id
        and a.data_user_id = auth.uid()
    )
  );

-- ─── updated_at trigger ─────────────────────────────────────────────────
-- Touch agent_conversations.updated_at whenever a new message is inserted,
-- so the conversation list can sort by recency without an extra write from
-- the API endpoint.
create or replace function public.staxis_touch_conversation_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.agent_conversations
  set updated_at = now()
  where id = NEW.conversation_id;
  return NEW;
end;
$$;

drop trigger if exists agent_messages_touch_conversation on public.agent_messages;
create trigger agent_messages_touch_conversation
  after insert on public.agent_messages
  for each row execute function public.staxis_touch_conversation_updated_at();

-- Bookkeeping
insert into public.applied_migrations (version, description)
values ('0079', 'Agent layer: conversations, messages, nudges + RLS')
on conflict (version) do nothing;
