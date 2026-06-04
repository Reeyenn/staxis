-- ═══════════════════════════════════════════════════════════════════════════
-- 0256 — Agent memory (long-term copilot recall: per-property + per-user)
--
-- Makes the AI copilot "get smarter the more each hotel uses it." Two scopes in
-- one table:
--   • property  — institutional memory shared across ALL conversations + ALL
--                 users of a hotel (subject_account_id IS NULL). e.g. "room 305's
--                 AC fails often", "we call the breakfast area the bistro".
--   • user      — private preference scoped to (property, account). e.g. "this
--                 GM wants terse answers", "Maria prefers Spanish".
--
-- READ path: the server deterministically reads active rows each turn, ranks +
-- caps them, and injects them (escaped, inside a <staxis-memory> trust marker)
-- into the DYNAMIC half of the system prompt. The model treats memory as
-- REFERENCE DATA, never instructions (base-prompt rule added in 0257).
--
-- WRITE path: the `remember` / `forget` agent tools call the advisory-locked
-- RPCs below (staxis_store_memory / staxis_forget_memory) via supabaseAdmin.
-- Hotel-scope writes are management-only (enforced at the tool layer).
--
-- ACCESS MODEL — SERVICE-ROLE ONLY (mirrors comms_* 0241 / knowledge 0252 /
-- equipment 0249 / compliance 0229). All access via supabaseAdmin behind the
-- agent routes + tools AFTER the caller is authenticated and role/property
-- checked. anon + authenticated are deny-all so a browser client can never read
-- or write this table directly. Because supabaseAdmin BYPASSES RLS, the real
-- per-tenant guarantee is the property_id filter in app code + these RPCs — RLS
-- deny-all is the backstop, and app-layer tenant-isolation tests are mandatory.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. agent_memory ─────────────────────────────────────────────────────────
-- @rls: service-role-only — all access via supabaseAdmin behind the agent routes/tools (role + property checked; hotel-scope writes management-only). No anon/authenticated path.
create table if not exists public.agent_memory (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references public.properties(id) on delete cascade,

  scope                  text not null check (scope in ('property','user')),
  subject_account_id     uuid,                       -- accounts.id for user scope; NULL for property scope (soft ref, no hard FK — mirrors knowledge_articles.created_by)
  topic                  text not null check (char_length(topic) between 1 and 80),   -- dedup/supersede slug, e.g. 'room_305_ac'
  content                text not null check (char_length(content) between 1 and 500),-- the human-readable fact

  source                 text not null default 'explicit_user'
                           check (source in ('explicit_user','inferred','correction','consolidation')),
  confidence             text not null default 'normal' check (confidence in ('low','normal','high')),

  created_by_account_id  uuid,                        -- accounts.id of the author (audit; soft ref)
  created_by_name        text,                        -- display-name snapshot for the manager UI without a join
  created_by_role        text,                        -- role snapshot at write time (drives the by="role:…" attribution; NEVER taken from tool args)
  source_conversation_id uuid,                        -- agent_conversations.id that produced/reinforced it (soft ref)

  is_active              boolean not null default true,
  superseded_by          uuid,                        -- reserved for a future audit chain (unused in v1)
  use_count              integer not null default 0,  -- reserved for future ranking (not written in v1)
  last_used_at           timestamptz,                 -- reserved for future ranking (not written in v1)
  expires_at             timestamptz,                 -- optional TTL; swept by the Move #2 consolidation cron

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- DB-enforced scope/subject invariant: property ⇒ no subject; user ⇒ has subject.
  constraint agent_memory_scope_subject_ck check (
    (scope = 'property' and subject_account_id is null) or
    (scope = 'user'     and subject_account_id is not null)
  )
);

comment on table public.agent_memory is
  'Long-term AI copilot memory, per-property (shared) + per-user (private). Read each turn and injected into the prompt as escaped <staxis-memory> reference data; written via staxis_store_memory / staxis_forget_memory. Service-role-only (deny-all anon+authenticated); per-tenant scoping enforced in app code + RPCs. Added 0256.';

-- One ACTIVE fact per (property, scope, subject, topic). Coalesce sentinel
-- because NULL is not comparable in a unique index. This guarantees dedup even
-- if a write path ever bypasses the RPC.
create unique index if not exists agent_memory_active_topic_key on public.agent_memory
  (property_id, scope, coalesce(subject_account_id, '00000000-0000-0000-0000-000000000000'::uuid), topic)
  where is_active;

-- Fast per-property active retrieval (the read path's only query).
create index if not exists agent_memory_property_active_idx on public.agent_memory
  (property_id, is_active, scope);

-- Expiry sweep support (Move #2 cron).
create index if not exists agent_memory_expires_idx on public.agent_memory (expires_at)
  where expires_at is not null and is_active;

-- ── 2. RLS — service-role only; anon + authenticated deny-all ───────────────
alter table public.agent_memory enable row level security;
revoke all on public.agent_memory from public, anon, authenticated;
grant select, insert, update, delete on public.agent_memory to service_role;
drop policy if exists agent_memory_deny_all on public.agent_memory;
create policy agent_memory_deny_all on public.agent_memory for all to anon, authenticated
  using (false) with check (false);

-- ── 3. updated_at trigger (shared fn from 0202/0211) ────────────────────────
drop trigger if exists set_updated_at on public.agent_memory;
create trigger set_updated_at before update on public.agent_memory
  for each row execute function public._pms_set_updated_at();

-- ── 4. RPC: staxis_store_memory ─────────────────────────────────────────────
-- Atomic upsert-by-topic + row-cap enforcement under a per-property advisory
-- lock (low write volume — serializing all of one property's memory writes is
-- cheap and makes both dedup and the cap race-free). Re-stating a topic
-- overwrites the active row in place (the dedup backbone). When inserting a new
-- topic, enforce the per-property (200) / per-user (50) active-row caps and
-- return a 'full' action code instead of raising, so the tool can surface a
-- friendly message. Returns the row id + the action taken.
create or replace function public.staxis_store_memory(
  p_property_id uuid,
  p_scope text,
  p_subject_account_id uuid,
  p_topic text,
  p_content text,
  p_source text default 'explicit_user',
  p_confidence text default 'normal',
  p_created_by_account_id uuid default null,
  p_created_by_name text default null,
  p_created_by_role text default null,
  p_source_conversation_id uuid default null,
  p_expires_at timestamptz default null,
  p_property_cap int default 200,
  p_user_cap int default 50
)
returns table(memory_id uuid, action text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_sentinel uuid := '00000000-0000-0000-0000-000000000000';
  v_id uuid;
  v_count int;
begin
  -- Validate scope/subject invariant early (the table CHECK is the backstop).
  if p_scope = 'property' and p_subject_account_id is not null then
    raise exception 'property scope must have null subject' using errcode = '22023';
  elsif p_scope = 'user' and p_subject_account_id is null then
    raise exception 'user scope requires a subject' using errcode = '22023';
  end if;

  -- Serialize all memory writes for THIS property (dedup + cap race-free).
  v_lock_key := ('x' || substr(md5('agent_memory:' || p_property_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- 1) Upsert: if an active row for this exact (scope, subject, topic) exists,
  --    overwrite it in place (correction / restatement). created_by_* stays as
  --    the ORIGINAL author (audit); content/source/confidence/conversation move
  --    to the latest.
  update public.agent_memory
     set content = p_content,
         source = p_source,
         confidence = p_confidence,
         source_conversation_id = coalesce(p_source_conversation_id, source_conversation_id),
         expires_at = p_expires_at,
         updated_at = now()
   where property_id = p_property_id
     and scope = p_scope
     and coalesce(subject_account_id, v_sentinel) = coalesce(p_subject_account_id, v_sentinel)
     and topic = p_topic
     and is_active
   returning id into v_id;

  if found then
    return query select v_id, 'updated'::text;
    return;
  end if;

  -- 2) New topic — enforce the active-row cap for this scope.
  if p_scope = 'property' then
    select count(*) into v_count from public.agent_memory
      where property_id = p_property_id and scope = 'property' and is_active;
    if v_count >= p_property_cap then
      return query select null::uuid, 'property_full'::text;
      return;
    end if;
  else
    select count(*) into v_count from public.agent_memory
      where property_id = p_property_id and scope = 'user'
        and subject_account_id = p_subject_account_id and is_active;
    if v_count >= p_user_cap then
      return query select null::uuid, 'user_full'::text;
      return;
    end if;
  end if;

  insert into public.agent_memory (
    property_id, scope, subject_account_id, topic, content, source, confidence,
    created_by_account_id, created_by_name, created_by_role, source_conversation_id, expires_at
  ) values (
    p_property_id, p_scope, p_subject_account_id, p_topic, p_content, p_source, p_confidence,
    p_created_by_account_id, p_created_by_name, p_created_by_role, p_source_conversation_id, p_expires_at
  )
  returning id into v_id;

  return query select v_id, 'inserted'::text;
end;
$$;

comment on function public.staxis_store_memory(uuid, text, uuid, text, text, text, text, uuid, text, text, uuid, timestamptz, int, int) is
  'Atomic upsert-by-topic + per-property/per-user active-row cap for agent memory, under a per-property advisory lock. Returns (memory_id, action) where action in (inserted|updated|property_full|user_full). Added 0256.';

revoke execute on function public.staxis_store_memory(uuid, text, uuid, text, text, text, text, uuid, text, text, uuid, timestamptz, int, int) from public, anon, authenticated;
grant  execute on function public.staxis_store_memory(uuid, text, uuid, text, text, text, text, uuid, text, text, uuid, timestamptz, int, int) to service_role;

-- ── 5. RPC: staxis_forget_memory ────────────────────────────────────────────
-- Soft-delete (is_active=false) the active row matching (scope, subject, topic),
-- retaining the row for audit. Returns the number of rows deactivated (0 = the
-- caller had nothing matching). Same per-property advisory lock.
create or replace function public.staxis_forget_memory(
  p_property_id uuid,
  p_scope text,
  p_subject_account_id uuid,
  p_topic text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_sentinel uuid := '00000000-0000-0000-0000-000000000000';
  v_count int;
begin
  v_lock_key := ('x' || substr(md5('agent_memory:' || p_property_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  update public.agent_memory
     set is_active = false, updated_at = now()
   where property_id = p_property_id
     and scope = p_scope
     and coalesce(subject_account_id, v_sentinel) = coalesce(p_subject_account_id, v_sentinel)
     and topic = p_topic
     and is_active;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.staxis_forget_memory(uuid, text, uuid, text) is
  'Soft-delete (is_active=false) the active agent_memory row for (property, scope, subject, topic), retained for audit. Returns rows deactivated. Added 0256.';

revoke execute on function public.staxis_forget_memory(uuid, text, uuid, text) from public, anon, authenticated;
grant  execute on function public.staxis_forget_memory(uuid, text, uuid, text) to service_role;

-- ── 6. Bookkeeping + schema reload ──────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0256',
  'agent_memory: long-term copilot memory (per-property shared + per-user private). Service-role-only (deny-all anon+authenticated); per-tenant scoping in app + RPCs. Atomic upsert/cap via staxis_store_memory; soft-delete via staxis_forget_memory. Read each turn + injected as escaped <staxis-memory> reference data.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
