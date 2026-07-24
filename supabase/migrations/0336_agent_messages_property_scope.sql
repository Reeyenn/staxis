-- 0336: agent_messages carries its hotel as a DB-enforced fact (INV-28).
--
-- Until now `agent_messages` was the one AI-layer table with no hotel column:
-- every "which hotel is this message from?" answer was a join through
-- `agent_conversations`. That made the table unscopable by the AI layer's
-- one-hotel accessor (src/lib/agent/scoped-db.ts), and it made the eventual
-- move to real row-level enforcement a rewrite rather than a policy change.
--
-- The column is DERIVED, never trusted:
--   a BEFORE INSERT OR UPDATE trigger overwrites whatever the writer supplied
--   with the parent conversation's property_id. So the three RPCs that insert
--   messages (staxis_lock_load_and_record_user_turn, staxis_record_assistant_turn,
--   staxis_restore_conversation) need NO changes, and the column can never
--   disagree with its conversation — including when a conversation is moved.
--
-- No FK to properties(id) on purpose: property deletion already cascades
-- properties → agent_conversations → agent_messages via
-- agent_messages_conversation_id_fkey. A second edge would add nothing but
-- another path through the 129-FK delete-hotel cascade. NOT NULL plus the
-- trigger carry the guarantee.
--
-- APPLY ORDER (migrations here are applied by hand, out of band):
--   1. apply THIS migration,
--   2. reload the PostgREST schema cache (the NOTIFY at the bottom),
--   3. then deploy the code that reads agent_messages through the accessor.
-- Between (1) and (3) all message writes still go through the unchanged RPCs,
-- so the window is safe in either order — but reads that filter on the new
-- column obviously need the column to exist first.

begin;

alter table public.agent_messages
  add column if not exists property_id uuid;

-- Backfill from the parent conversation (53 rows at authoring time; every
-- agent_messages row has a NOT NULL conversation_id with an FK, so this
-- reaches all of them).
update public.agent_messages m
   set property_id = c.property_id
  from public.agent_conversations c
 where c.id = m.conversation_id
   and m.property_id is distinct from c.property_id;

create or replace function public.staxis_agent_messages_set_property()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Derive, never trust. A writer that supplies the wrong property_id (or
  -- none) gets the conversation's. A conversation_id that does not resolve
  -- leaves property_id NULL and the NOT NULL constraint below rejects the
  -- row — the same outcome the conversation_id FK would produce.
  select c.property_id
    into new.property_id
    from public.agent_conversations c
   where c.id = new.conversation_id;
  return new;
end;
$$;

comment on function public.staxis_agent_messages_set_property() is
  'INV-28: derives agent_messages.property_id from its parent agent_conversations row on every insert and update.';

drop trigger if exists agent_messages_set_property on public.agent_messages;
create trigger agent_messages_set_property
  before insert or update on public.agent_messages
  for each row execute function public.staxis_agent_messages_set_property();

alter table public.agent_messages
  alter column property_id set not null;

comment on column public.agent_messages.property_id is
  'The hotel this message belongs to. DERIVED by staxis_agent_messages_set_property() from agent_conversations — never set by the writer.';

-- Supports "this hotel's recent agent messages" (the AI-spend / metrics reads
-- and anything that goes through scopedDb), which previously had to join
-- through agent_conversations.
create index if not exists agent_messages_property_created_idx
  on public.agent_messages (property_id, created_at desc);

insert into public.applied_migrations (version, description) values (
  '0336',
  'agent_messages.property_id derived from its parent conversation by a BEFORE trigger, backfilled, NOT NULL, with a (property_id, created_at desc) index (INV-28)'
)
on conflict (version) do nothing;

commit;

-- PostgREST caches the schema; without this the new column is invisible to
-- the REST API until the next redeploy.
notify pgrst, 'reload schema';
