-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — the decision corpus learns two more surfaces (0457)
--
-- TWO VALUES, ADDED TO ONE CHECK CONSTRAINT. That is the whole migration.
--
-- ─── WHAT WENT WRONG, AND WHY IT WAS INVISIBLE ─────────────────────────────
--
-- `agent_decisions` (0350) records what the assistant was looking at when it
-- proposed or performed an act. Its `surface` column answers WHERE that
-- happened, and its CHECK has admitted the same five values since the table was
-- written: chat, voice, walkthrough, cron, api.
--
-- The AgentSurface type in the application has grown twice since:
--   'portfolio' (July 2026)  cross-hotel chat, /api/agent/portfolio
--   'messages'  (Aug 2026)   the "@Staxis" thread assistant, folded out of its
--                            own private loop and onto the one pipeline
--
-- Neither was added here, and nothing said so. Every writer in
-- src/lib/agent/decisions.ts is fail-soft by design — a corpus write must never
-- cost a user their action card — so an INSERT carrying an unlisted surface is
-- bounced by this constraint, swallowed, and logged to a console nobody reads.
--
-- The failure that actually matters is the other one. The obvious way to make a
-- new surface's rows land is to pass the nearest allowed value, and for a staff
-- thread that value is 'chat'. That is a WRONG ANSWER in the one table whose
-- entire job is answering where an act happened: a work order raised in an
-- all-staff channel, filed as though somebody typed it privately into the chat
-- bar. A missing row is a visible gap. A mislabelled row is not.
--
-- So the application refuses to guess: `decisionCorpusSurfaceOf` in
-- src/lib/agent/decisions.ts holds the list below, and a surface outside it
-- skips the write and says so rather than borrowing another surface's name.
-- This migration is what lets the two real surfaces stop being skipped. The
-- skip-and-warn machinery stays for whatever comes next, because the next
-- surface will arrive the same way these two did.
--
-- ─── WHY NOT A LOOKUP TABLE, OR NO CONSTRAINT AT ALL ───────────────────────
--
-- A domain table would make this an insert rather than a DDL change, which
-- sounds better until you notice it moves the decision from review (where a
-- widened constraint is a visible diff somebody argues with) into a row
-- somebody can add at 2am. The set is small, it changes about twice a year, and
-- every addition deserves exactly the conversation this file is.
--
-- Dropping the CHECK entirely would let a typo become a surface, and the corpus
-- would then contain two spellings of the same place with nothing to say which
-- is real.
--
-- ─── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
--
-- No backfill. Rows already in the table are correct for the surface they were
-- written from; there is no historical 'messages' or 'portfolio' row to repair,
-- because the constraint is exactly what stopped them existing.
-- No new index, no new grants, no trigger. The table's own policies, indexes
-- and service-role-only access from 0350 are untouched.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: the constraint is dropped and recreated. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The table must exist. A migration that silently no-ops on a project missing
-- 0350 would leave the corpus writing into a CHECK it thinks it widened.
DO $$
BEGIN
  IF to_regclass('public.agent_decisions') IS NULL THEN
    RAISE EXCEPTION '0457 requires the agent_decisions table from migration 0350';
  END IF;
END
$$;

-- ─── The one change: two surfaces join the domain ──────────────────────────
--
-- Restated in full rather than patched, so this file is the readable definition
-- of the constraint rather than a diff somebody has to reconstruct from 0350.
ALTER TABLE public.agent_decisions
  DROP CONSTRAINT IF EXISTS agent_decisions_surface_check;

ALTER TABLE public.agent_decisions
  ADD CONSTRAINT agent_decisions_surface_check
  CHECK (surface IN (
    -- The Ask Staxis bar and the companion bubble. Same surface: the bubble is
    -- a face on that conversation, not a second one.
    'chat',
    'voice',
    'walkthrough',
    -- Background work with no person in front of it.
    'cron',
    'api',
    -- New. The "@Staxis" thread assistant. A staff channel is a different place
    -- from a private chat bar: the answer is read by everyone in the thread,
    -- and the assistant's reach there is narrowed to five capabilities by the
    -- messages lens. Filing its acts as 'chat' would have hidden both facts.
    'messages',
    -- New. Cross-hotel chat, which answers for a whole management company
    -- rather than for one building. It has been a surface in the application
    -- since July 2026 and unrepresentable here ever since.
    'portfolio'
  ));

COMMENT ON COLUMN public.agent_decisions.surface IS
  'Where the act happened. Kept in step with AgentSurface in src/lib/agent/tools.ts plus the two non-conversational writers (cron, api); DECISION_CORPUS_SURFACES in src/lib/agent/decisions.ts mirrors this list, and a surface outside it skips the write rather than borrowing another surface''s name.';

-- ─── applied_migrations bookkeeping ─────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0457',
  'the decision corpus learns two more surfaces: agent_decisions.surface gains ''messages'' (the @Staxis thread assistant) and ''portfolio'' (cross-hotel chat), both of which existed in the application and were unrepresentable here, so their rows were silently bounced by the CHECK. One constraint widened by two values. No backfill, no new tables, no new indexes, no new grants.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
