-- 0300 — agent_pending_actions: server-enforced approval gate for AI actions.
--
-- WHY
-- ---
-- Until now the AI assistant (AskStaxisBar + /chat) executed every action
-- tool IMMEDIATELY the moment Claude emitted a tool_use block. "Send Maria a
-- message", "log a complaint", "assign room 302" — all fired with no
-- confirmation. This table is the durable backbone of an approval flow: when
-- the model wants to run a MUTATION tool, the server persists a PENDING row
-- here instead of executing, streams a `tool_call_pending_approval` event to
-- the browser, and stops the turn. The action only runs after the user taps
-- Approve on a card, which POSTs /api/agent/command/resolve-action.
--
-- The row is the authority — the gate is enforced server-side, not in the UI.
-- A client that forged an "approve" without a matching pending row gets
-- nothing; a client that never approves leaves the row to expire (10 min TTL,
-- swept lazily on the next resolve attempt).
--
-- GROUPING (turn_key)
-- -------------------
-- Anthropic requires every tool_use block in one assistant message to receive
-- a matching tool_result before the conversation can continue. So if a single
-- assistant turn proposes several mutations, we can only resume the model once
-- ALL of them are resolved. `turn_key` groups the pending rows of one assistant
-- turn (it is the assistant-turn's first tool_call_id) so the resolve route can
-- ask "are all siblings resolved yet?" before feeding tool_results back.
--
-- SECURITY
-- --------
-- Service-role only (deny-all RLS), same idiom as staff_link_tokens (0295) and
-- every other server-only table. The resolve route uses supabaseAdmin and does
-- its OWN capability check: the row must belong to the caller's property AND
-- their conversation, be pending, and not expired. staffId/accountId scoping
-- lives in the route, not the DB, matching the rest of the agent layer.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- @rls: service-role-only — written + resolved exclusively through supabaseAdmin
-- (src/lib/agent/pending-actions.ts, /api/agent/command/resolve-action). Anon +
-- authenticated get no policies (deny-all).
CREATE TABLE IF NOT EXISTS public.agent_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope. property_id + conversation_id + account_id together pin the row to
  -- one user's one conversation on one property. The resolve route re-checks
  -- all three against the authenticated caller before executing.
  property_id     uuid NOT NULL REFERENCES public.properties(id)          ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES public.accounts(id)            ON DELETE CASCADE,

  -- Groups all tool_use blocks of ONE assistant turn (the turn's first
  -- tool_call_id). The model resumes only when every row sharing a turn_key is
  -- resolved — otherwise the Anthropic tool_result contract is violated.
  turn_key   text NOT NULL,

  -- The Anthropic tool_use block id this row stands in for. Unique per
  -- conversation so a resolve can target exactly one proposed action, and so
  -- the resumed tool_result carries the right tool_use_id.
  tool_call_id text NOT NULL,
  tool_name    text NOT NULL,
  tool_args    jsonb NOT NULL,

  -- 'quick' (one-tap compact card) | 'card' (full editable card). Drives which
  -- UI the browser renders; the tier is decided server-side from the tool's
  -- approval metadata so the client can't downgrade a card action to quick.
  tier text NOT NULL CHECK (tier IN ('quick', 'card')),

  -- Lifecycle. pending → approved/denied by the user; approved → executed/failed
  -- once the tool runs; pending → expired if the TTL passes unresolved.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),

  -- Outcome of executing an approved action. result = the tool's ok payload;
  -- error = the human-readable failure (both fed back to the model on resume).
  result jsonb,
  error  text,

  -- Single-flight resume guard. When the LAST sibling of a turn resolves, the
  -- resolve route atomically stamps every row of the turn (WHERE
  -- resume_claimed_at IS NULL) to claim the right to resume the model — exactly
  -- one concurrent resolver wins the UPDATE and streams the follow-up, so two
  -- cards approved at the same instant can neither double-resume (double-bill +
  -- racing writes) nor both back off and hang the turn.
  resume_claimed_at timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  -- Single-use, short-lived: a proposal the user ignores for 10 minutes is
  -- stale (the hotel state it was built against has moved on). Swept lazily.
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

-- One row per (conversation, tool_call_id). Guards against a double-insert if
-- the stream retries persisting the same proposed action, and makes the
-- resolve-route point-lookup a single indexed hit.
CREATE UNIQUE INDEX IF NOT EXISTS agent_pending_actions_call_uniq
  ON public.agent_pending_actions (conversation_id, tool_call_id);

-- Hot path for the resolve route's "are all siblings of this turn resolved?"
-- question and for rendering a conversation's still-pending cards on reload.
CREATE INDEX IF NOT EXISTS agent_pending_actions_turn_idx
  ON public.agent_pending_actions (conversation_id, turn_key, status);

-- Lazy-expiry sweep support.
CREATE INDEX IF NOT EXISTS agent_pending_actions_expiry_idx
  ON public.agent_pending_actions (expires_at)
  WHERE status = 'pending';

-- RLS: service-role only. Anon + authenticated get NO policies → default-deny
-- (mirrors staff_link_tokens 0295 and every other server-only table).
ALTER TABLE public.agent_pending_actions ENABLE ROW LEVEL SECURITY;

-- Idempotent re-runs: drop any pre-existing policies before (re)declaring the
-- deny-all default. We declare none on purpose.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_pending_actions'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.agent_pending_actions', pol.policyname);
  END LOOP;
END $$;

COMMENT ON TABLE public.agent_pending_actions IS
  'Server-enforced approval gate for AI assistant actions. When Claude emits a mutation tool_use, the server persists a pending row here and streams a card to the browser instead of executing. The action runs only after the user approves via /api/agent/command/resolve-action. turn_key groups one assistant turn so the model resumes only when all sibling actions are resolved (Anthropic tool_result contract). Service-role only.';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0300',
  'agent_pending_actions: durable approval gate for AI assistant mutation tools. Mutations are proposed (pending row + tool_call_pending_approval SSE event), not executed, until the user approves on a card. turn_key groups an assistant turn so resume only fires when all sibling actions resolve. 10-min single-use TTL, service-role only.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
