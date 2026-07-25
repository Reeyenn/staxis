-- ═══════════════════════════════════════════════════════════════════════════
-- 0359 — Drip questions: the ONE thing Staxis is allowed to ask a manager.
--
-- WHAT THIS IS
-- The copilot already detects durable operational patterns from the hotel's own
-- data (src/lib/agent/operational-signals.ts — "4 hvac work orders on room 214
-- in 30 days"). Until now those only ever became LOW-confidence auto-learned
-- guesses. This table lets Staxis occasionally turn ONE of them into a single
-- one-tap question on the Staxis screen:
--
--     "4 hvac work orders on room 214 in the last 30 days — known problem room?"
--
-- A "yes" becomes a HUMAN-AUTHORED, non-expiring fact in agent_memory (via
-- staxis_store_memory with source='explicit_user'), which is a real upgrade: it
-- stops expiring and gains the 0260/0261 protection against being overwritten
-- by the nightly auto-learner.
--
-- WHY A NEW TABLE (the "extend before you add" justification)
-- The record this feature needs is "the manager was ASKED this and said
-- yes / said no / said nothing", keyed to a HOTEL and to a signal TOPIC, and it
-- must survive forever. Nothing in the schema carries that:
--
--   • agent_memory      — holds FACTS. A declined question is not a fact and
--                         must never be conflated with one; writing declines
--                         there would also pollute the "What Staxis knows"
--                         screen, which lists every active property row.
--   • agent_nudges      — per-USER inbox, category CHECK-pinned to 4 values,
--                         and its dedupe index only covers status='pending', so
--                         "never ask again" could not be expressed. Wrong grain:
--                         a hotel fact is not one manager's notification.
--   • agent_decisions   — a tool-call corpus; every row REQUIRES tool_name and
--                         a state_snapshot. No tool runs here, so every row
--                         would be a fabrication.
--
-- THE OBNOXIOUSNESS GUARANTEE (the whole point of the table)
-- One row per (property_id, topic), forever:
--   status='answered_yes' → never ask again (it is now a confirmed fact)
--   status='declined'     → never ask again (the manager said no; that is data)
--   status='asked'        → askable again only on a LATER day, and only until
--                           ask_count reaches the app-side cap. An ignored
--                           question therefore cannot come back the same day,
--                           and cannot nag forever.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY, mirroring agent_memory (0256): anon +
-- authenticated deny-all. The browser reaches this exclusively through
-- /api/memory/question behind requireSession + a manages-this-property check.
--
-- NOT APPLIED by the agent automatically — migrations are applied by hand
-- (CLAUDE.md). The reading code tolerates this table being absent (the card
-- simply never renders), so deploy order is safe either way. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. agent_knowledge_questions ───────────────────────────────────────────
-- @rls: service-role-only — read/written only by /api/memory/question behind
-- requireSession + a manages-this-property check. No anon path, no browser path.
create table if not exists public.agent_knowledge_questions (
  id                      uuid primary key default gen_random_uuid(),

  -- Tenancy. Cascades: offboarding a hotel removes its question history.
  property_id             uuid not null references public.properties(id) on delete cascade,

  -- The signal's STABLE slug — same identity key agent_memory.topic uses, so a
  -- confirmed answer lands on (and upgrades) the very row the nightly
  -- auto-learner would otherwise keep rewriting. 80 chars matches
  -- agent_memory.topic's own CHECK.
  topic                   text not null check (char_length(topic) between 1 and 80),

  -- Which detector produced it (operational-signals.ts SignalSeverity source).
  category                text not null check (category in (
                            'maintenance','complaint','noise','inspection','cleaning'
                          )),

  -- Both languages are FROZEN at ask time and stored side by side. The question
  -- is generated from structured signal data, not translated at render time —
  -- storing both is what makes the Spanish path provably Spanish rather than a
  -- silent English fallback.
  question_en             text not null check (char_length(question_en) between 1 and 300),
  question_es             text not null check (char_length(question_es) between 1 and 300),

  -- The exact sentence a "yes" writes into agent_memory. Frozen at ask time so
  -- the stored fact means precisely what the manager was shown and tapped,
  -- even if the underlying counts move before they answer.
  fact_content            text not null check (char_length(fact_content) between 1 and 500),

  status                  text not null default 'asked' check (status in (
                            'asked','answered_yes','declined'
                          )),

  -- How many times this question has been SERVED. The app caps it; the column
  -- is what makes "and it never came back a fourth time" auditable.
  ask_count               integer not null default 1 check (ask_count >= 0),

  first_asked_at          timestamptz not null default now(),
  last_asked_at           timestamptz not null default now(),
  -- The hotel's LOCAL business date of the most recent ask. A date, not a
  -- timestamp, because "did we already ask today?" is a calendar question and
  -- the hotel's calendar is the one that counts.
  last_asked_on           date not null,

  answered_at             timestamptz,
  -- SET NULL, not CASCADE: the record that a manager was asked and answered
  -- outlives the manager's account.
  answered_by_account_id  uuid references public.accounts(id) on delete set null,
  -- The agent_memory row a 'yes' produced. No FK on purpose — memory rows are
  -- soft-deleted and capped, and this link is an audit breadcrumb, not a
  -- dependency that should be able to block or cascade.
  memory_id               uuid,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ONE row per hotel per topic, forever. This unique index IS the "never ask the
-- same question twice" guarantee at the database level: a second ask can only
-- ever be an UPDATE of the existing row, never a fresh one that forgot the
-- previous verdict.
create unique index if not exists agent_knowledge_questions_property_topic_uq
  on public.agent_knowledge_questions (property_id, topic);

-- The selection read: "everything this hotel has already been asked".
create index if not exists agent_knowledge_questions_property_status_idx
  on public.agent_knowledge_questions (property_id, status, last_asked_on desc);

comment on table public.agent_knowledge_questions is
  'One row per (hotel, operational-signal topic) recording that Staxis asked the manager a one-tap question and what they said: answered_yes (became a human-authored agent_memory fact), declined (a recorded no — never ask again), or asked (served, no verdict yet; re-askable on a later day until the app-side cap). Service-role-only; written by /api/memory/question. Added 0359.';

comment on column public.agent_knowledge_questions.topic is
  'The operational signal''s stable slug (op_maint_214_hvac, …) — the SAME key agent_memory.topic uses, so a confirmed answer upgrades that memory row in place.';

comment on column public.agent_knowledge_questions.fact_content is
  'The sentence a "yes" stores into agent_memory, frozen at ask time so the fact matches exactly what the manager was shown.';

comment on column public.agent_knowledge_questions.last_asked_on is
  'Hotel-local business date of the most recent ask. An ignored question is not re-offered while this equals the hotel''s today.';

-- ── 2. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.agent_knowledge_questions enable row level security;
revoke all on public.agent_knowledge_questions from public, anon, authenticated;
grant select, insert, update, delete on public.agent_knowledge_questions to service_role;
drop policy if exists agent_knowledge_questions_deny_all on public.agent_knowledge_questions;
create policy agent_knowledge_questions_deny_all on public.agent_knowledge_questions
  for all to anon, authenticated using (false) with check (false);

-- ── 3. updated_at trigger (shared fn from 0202) ────────────────────────────
drop trigger if exists set_updated_at on public.agent_knowledge_questions;
create trigger set_updated_at before update on public.agent_knowledge_questions
  for each row execute function public._pms_set_updated_at();

-- ── 4. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0359',
  'agent_knowledge_questions: the drip-question ledger. One row per (hotel, signal topic) recording that Staxis asked the manager a one-tap question and their verdict (answered_yes / declined / asked). Unique (property_id, topic) is the never-ask-twice guarantee; last_asked_on keeps an ignored question from returning the same day. Service-role-only (deny-all anon+authenticated).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
