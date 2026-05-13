-- Migration 0101: agent_messages.is_error for tool-error-rate visibility
--
-- Today /admin/agent shows which tools are called the most, but not
-- which ones are FAILING. A broken tool surfaces only via angry users.
-- This adds an is_error column on agent_messages so the metrics route
-- can count failures per tool and surface a "Tool errors today" KPI.
--
-- Longevity L8B, 2026-05-13.
--
-- The column is nullable. It's only set for role='tool' rows
-- (assistant + user rows don't have a concept of "error"). Historical
-- rows pre-0101 stay NULL — we don't backfill because we don't know
-- which ones were errors (the tool_result blob shape varied).

ALTER TABLE public.agent_messages
  ADD COLUMN IF NOT EXISTS is_error boolean;

COMMENT ON COLUMN public.agent_messages.is_error IS
  'true when this tool_result represents a tool failure (role=tool only). NULL on non-tool rows and on legacy rows pre-0101. Longevity L8B, 2026-05-13.';

-- Index supports the metrics route's "errors today by tool" aggregation
-- without scanning the whole table. Partial — only error rows.
CREATE INDEX IF NOT EXISTS agent_messages_tool_errors_idx
  ON public.agent_messages(created_at DESC, conversation_id)
  WHERE role = 'tool' AND is_error = true;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0101', 'L8B: agent_messages.is_error column for tool error rate KPI')
ON CONFLICT (version) DO NOTHING;
