-- ═══════════════════════════════════════════════════════════════════════════
-- 0374 — agent_costs learns WHICH JOB spent the money.
--
-- WHY
-- `agent_costs` has always answered who (user), where (property), and with what
-- (model). It has never answered WHAT FOR. That was survivable while the only
-- question anyone asked of it was "are we about to blow a cap" — a cap does not
-- care what the money was for.
--
-- The AI Staff page asks the other question. It draws thirteen named jobs over
-- one engine and puts a bill on each card, and a bill needs an answer to "what
-- for". Today the only ledger that can answer is `findings_ai_spend` (0361),
-- which carries a `feature` column but covers exactly three background callers.
-- The Morning Briefer's card works because `findings.brief` happens to be one
-- of the three; employee #2's card would show nothing, and every card after it
-- would have the same problem for the same reason.
--
-- ONE COLUMN, NOT A SECOND LEDGER. `agent_costs` is already the BOOKS — 0361
-- says so in its own comment, and every background caller writes here as
-- kind='background' whether or not it also takes a hold against the findings
-- gate. Adding a second per-feature ledger would mean two tables recording the
-- same call and a permanent question about which one to believe.
--
-- WHICH LEDGER IS AUTHORITATIVE (the double-count answer, written down once)
--   agent_costs        = THE BOOKS.  Every provider call that Staxis pays for.
--   findings_ai_spend  = THE GATE.   A per-hotel-per-day ceiling for background
--                                    work, holding worst-case reservations that
--                                    were mostly never charged.
-- The judge, the sweep and the brief appear in BOTH: a hold in the gate and a
-- real row in the books. Anything reporting spend sums the BOOKS and nothing
-- else. Summing both would double-count all three of them, and summing the gate
-- alone would report reservation-sized money that was never spent.
--
-- NULLABLE, AND NOT BACKFILLED
-- Every row written before this migration has no honest feature to give it. The
-- model is knowable, the user is knowable, the job is not — a summary and a
-- translation from the same account on the same model are indistinguishable in
-- the row. So history stays NULL and reads it as "unattributed". Guessing would
-- put invented numbers on a page whose entire premise is that its numbers are
-- checkable, and it would be permanent: nobody would ever know which rows were
-- guessed. The readers instead report the date attribution STARTED, so a small
-- figure on a card reads as "this is what we have measured so far" rather than
-- as "this was free".
--
-- The CHECK bounds the label rather than enumerating it. The allowed values are
-- a closed TypeScript union (`AiCostFeature`, src/lib/ai/types.ts) so a bad
-- value fails to compile; an enum here would additionally require a migration
-- every time a feature is renamed, and would reject rows from a deploy that is
-- one commit ahead of the database — losing the spend record rather than the
-- label.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The column ──────────────────────────────────────────────────────────

alter table public.agent_costs
  add column if not exists feature text
    check (feature is null or char_length(feature) between 1 and 64);

comment on column public.agent_costs.feature is
  'Which named job spent this — an AI Control Center feature key (e.g. findings.brief), or one of the two ledger-only labels for spenders the Control Center does not govern (knowledge.document_ocr, agent.eval_suite). NULL means unattributed: written before 0374, or by the reservation half of a chat turn that has not been finalized yet. Never backfilled — the job a historical row was for is not recoverable from the row. Values are constrained by the closed AiCostFeature union in src/lib/ai/types.ts, not by an enum here, so a deploy ahead of the database records the spend rather than losing it. Added 0374.';

-- The per-employee read: a handful of feature keys, over a 30-day window,
-- finalized rows only. PARTIAL on `feature is not null` because the whole of
-- history is NULL and will stay that way — indexing it would double the index
-- for rows this index exists to exclude.
create index if not exists agent_costs_feature_day_idx
  on public.agent_costs (feature, created_at desc)
  where feature is not null;

-- ── 2. The finalize RPC carries it through ─────────────────────────────────
--
-- A chat turn's row is INSERTed by `staxis_reserve_agent_spend` as a hold and
-- UPDATEd into real spend by `staxis_finalize_agent_spend`. The feature is set
-- on the finalize half, deliberately:
--
--   • The reserve function is called by every user-facing chat turn and its
--     body hard-codes kind='request' in three cap sums. 0361 already declined
--     to widen it and recorded why; that reasoning has not changed.
--   • A hold is not spend. It is worth nothing to attribute a row that is about
--     to be either overwritten with the truth or cancelled to zero.
--
-- THE OLD 8-ARGUMENT SIGNATURE IS NOT DROPPED, and that is the point. This
-- migration is applied to the live database BY HAND, and the code that calls
-- the 9-argument form ships separately; between those two moments the running
-- production build is still calling with 8 arguments. Dropping that signature
-- would make every chat turn's finalize fail, which the JS side answers by
-- retrying three times and then writing an agent_cost_finalize_failures row —
-- money charged, books silent. Leaving it means the deploy order is a
-- non-event: an old caller keeps working and records NULL, which is exactly
-- what it honestly knows.
--
-- It is REPLACED WITH A DELEGATE rather than left alone so that the state guard
-- exists once. 0098's body would otherwise sit here as a second copy of the
-- same UPDATE, and the next person to change the guard would change one of them.
--
-- Neither signature takes a DEFAULT. A default on p_feature would make an
-- 8-argument call ambiguous between the two overloads, and PostgREST would
-- refuse to choose.

CREATE OR REPLACE FUNCTION public.staxis_finalize_agent_spend(
  p_reservation_id uuid,
  p_conversation_id uuid,
  p_actual_usd numeric,
  p_model text,
  p_model_id text,
  p_tokens_in integer,
  p_tokens_out integer,
  p_cached_input_tokens integer,
  p_feature text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows integer;
BEGIN
  -- The state guard is 0098's, unchanged: refuse to write a row that has
  -- already been finalized or swept, so the sweeper-vs-finalize race cannot
  -- quietly lose spend visibility.
  UPDATE public.agent_costs
  SET state               = 'finalized',
      conversation_id     = p_conversation_id,
      cost_usd            = p_actual_usd,
      model               = p_model,
      model_id            = p_model_id,
      tokens_in           = p_tokens_in,
      tokens_out          = p_tokens_out,
      cached_input_tokens = p_cached_input_tokens,
      -- COALESCE, not assignment: an older caller passing NULL must never
      -- erase a label a newer one already wrote.
      feature             = COALESCE(p_feature, feature)
  WHERE id           = p_reservation_id
    AND state        = 'reserved'
    AND swept_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'finalize_target_unavailable'
      USING DETAIL = 'reservation ' || p_reservation_id::text || ' is already finalized or swept';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer, text) IS
  'Reconcile a reservation to actual spend AND record which job spent it (0374). Refuses (raises finalize_target_unavailable) if the row has already been finalized or swept — 0098''s guard, unchanged. p_feature is COALESCEd so a legacy 8-argument caller cannot blank a label.';

REVOKE EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer, text) TO   service_role;

-- The legacy signature (from 0098), now a one-line delegate. Same name, same
-- grants, same observable behaviour — including 0098's refusal to write a row
-- that is already finalized or swept, which it now inherits instead of
-- duplicating.
CREATE OR REPLACE FUNCTION public.staxis_finalize_agent_spend(
  p_reservation_id uuid,
  p_conversation_id uuid,
  p_actual_usd numeric,
  p_model text,
  p_model_id text,
  p_tokens_in integer,
  p_tokens_out integer,
  p_cached_input_tokens integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.staxis_finalize_agent_spend(
    p_reservation_id, p_conversation_id, p_actual_usd, p_model, p_model_id,
    p_tokens_in, p_tokens_out, p_cached_input_tokens, NULL::text
  );
END;
$$;

COMMENT ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) IS
  'Compatibility shim for callers that predate 0374. Delegates to the 9-argument form with a NULL feature, so a build deployed before the feature-aware one records the spend and leaves the label unattributed rather than failing to finalize at all.';

REVOKE EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) FROM public;
REVOKE EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) TO   service_role;

-- ── 3. RLS is untouched ────────────────────────────────────────────────────
-- agent_costs keeps its single SELECT policy from 0080 (a user sees their own
-- rows). A new column inherits it. Nothing here grants anon or authenticated
-- anything they did not already have.

INSERT INTO public.applied_migrations (version, description)
VALUES ('0374', 'agent_costs.feature: which named job spent it, so an AI employee card can show its own bill. Nullable and never backfilled — history reads as unattributed. Partial index on the attributed rows. staxis_finalize_agent_spend gains a 9-argument form that records the label (COALESCEd, so a legacy caller cannot blank it); the 8-argument signature is kept as a delegating shim so applying this by hand before the code deploys cannot break a running finalize. Settles the double-count question in writing: agent_costs is the BOOKS, findings_ai_spend is the GATE, and anything reporting spend sums the books only.')
ON CONFLICT (version) DO NOTHING;
