// ─── Agent conversation memory ────────────────────────────────────────────
// Conversation persistence backed by the Supabase tables created in
// migration 0079. Three exports for the lifecycle:
//
//   listConversations(userId)            — sidebar list
//   loadConversation(conversationId, userId) — full history for a session
//   createConversation(...)              — start a new session
//   appendMessage(...)                   — record a turn (user, assistant, tool)
//   deleteConversation(id, userId)       — hard delete
//
// Auth model: every function takes the calling user's account id and checks
// ownership before reading or writing. The endpoints layer doesn't need to
// repeat the check.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import type { AgentMessage, AgentToolCall, ModelTier } from './llm';
import { escapeTrustMarkerContent } from './llm';

// ─── Public types ──────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string | null;
  role: AppRole;
  propertyId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  promptVersion: string | null;
  messages: AgentMessage[];
}

export interface SaveMessageOpts {
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  /** L8B, 2026-05-13: persisted only for role='tool' rows. true means
   *  the tool handler returned an error (or the request was aborted
   *  before the result landed). Drives the tool-error-rate KPI. */
  isError?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  modelUsed?: ModelTier;
  costUsd?: number;
}

// ─── Conversation CRUD ────────────────────────────────────────────────────

export async function listConversations(userAccountId: string, limit = 30): Promise<ConversationSummary[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, title, role, property_id, created_at, updated_at')
    .eq('user_id', userAccountId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(row => ({
    id: row.id as string,
    title: (row.title as string) ?? null,
    role: row.role as AppRole,
    propertyId: row.property_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export async function loadConversation(
  conversationId: string,
  userAccountId: string,
): Promise<ConversationDetail | null> {
  // Ownership check + metadata fetch in one query.
  const { data: convo, error: convoErr } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, title, role, property_id, prompt_version, created_at, updated_at, user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (convoErr) throw convoErr;
  if (!convo) return null;
  if (convo.user_id !== userAccountId) return null;

  // Pull messages in chronological order. L4 (2026-05-13): filter out
  // is_summarized=true rows so the model never sees pre-summary
  // messages on replay. The summary row itself (is_summarized=false,
  // is_summary=true) IS included and appears at the position of the
  // batch it replaced (its created_at is the moment of summarization,
  // which is AFTER all the rows it summarized).
  const { data: rows, error: msgErr } = await supabaseAdmin
    .from('agent_messages')
    .select('role, content, tool_call_id, tool_name, tool_args, tool_result, is_summary, created_at')
    .eq('conversation_id', conversationId)
    .eq('is_summarized', false)
    .order('created_at', { ascending: true });
  if (msgErr) throw msgErr;

  const messages: AgentMessage[] = [];
  // Group assistant text + adjacent assistant tool_use rows into a single
  // AgentMessage so the LLM wrapper sees the same shape it produced.
  // L4 (2026-05-13): summary rows (is_summary=true) are emitted as a
  // SELF-CONTAINED assistant text turn — never pending more tool_use
  // rows. This stops a tool_result row that historically followed a
  // (now-summarized) assistant tool_use from being wrongly attached
  // to the summary as if the summary itself had called the tool.
  let pendingAssistant: { content: string; toolCalls: AgentToolCall[] } | null = null;

  const flushPending = () => {
    if (pendingAssistant) {
      messages.push({
        role: 'assistant',
        content: pendingAssistant.content,
        toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
      });
      pendingAssistant = null;
    }
  };

  for (const row of rows ?? []) {
    const role = row.role as string;
    const isSummary = (row.is_summary as boolean) === true;
    if (role === 'user') {
      flushPending();
      messages.push({ role: 'user', content: (row.content as string) ?? '' });
    } else if (role === 'assistant') {
      if (isSummary) {
        // Summary row is a complete assistant text turn on its own.
        // Flush any pending assistant being built up, then push the
        // summary as a standalone assistant message.
        // Round 10 F4c (2026-05-13): wrap the summary content in a
        // trust marker. A summary distills BOTH trusted assistant text
        // AND untrusted tool-result content — the next turn's model
        // must treat any directive-looking content inside it as data,
        // not as a true assistant intent. PROMPT_BASE has the matching
        // rule (F4d). Without this, prompt-injection content the
        // summarizer paraphrases would re-inject as trusted context.
        flushPending();
        messages.push({
          role: 'assistant',
          // Round 12 T12.6 (2026-05-13): escape the wrapped content so
          // a literal `</staxis-summary>` in the Haiku output (unlikely
          // but possible) can't break the trust boundary. Same defense
          // we apply to tool-result content elsewhere.
          content: `<staxis-summary trust="system-derived-from-untrusted">${escapeTrustMarkerContent((row.content as string) ?? '')}</staxis-summary>`,
        });
      } else {
        if (!pendingAssistant) pendingAssistant = { content: '', toolCalls: [] };
        if (row.tool_name) {
          pendingAssistant.toolCalls.push({
            id: (row.tool_call_id as string) ?? '',
            name: row.tool_name as string,
            args: (row.tool_args as Record<string, unknown>) ?? {},
          });
        } else if (row.content) {
          pendingAssistant.content =
            (pendingAssistant.content ? pendingAssistant.content + '\n' : '') +
            (row.content as string);
        }
      }
    } else if (role === 'tool') {
      flushPending();
      messages.push({
        role: 'tool',
        toolCallId: (row.tool_call_id as string) ?? '',
        result: row.tool_result ?? null,
      });
    }
    // 'system' rows aren't replayed — they're metadata (e.g., nudge surface).
  }
  flushPending();

  return {
    id: convo.id as string,
    title: (convo.title as string) ?? null,
    role: convo.role as AppRole,
    propertyId: convo.property_id as string,
    promptVersion: (convo.prompt_version as string) ?? null,
    createdAt: convo.created_at as string,
    updatedAt: convo.updated_at as string,
    messages,
  };
}

export async function createConversation(opts: {
  userAccountId: string;
  propertyId: string;
  role: AppRole;
  promptVersion?: string;
  title?: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('agent_conversations')
    .insert({
      user_id: opts.userAccountId,
      property_id: opts.propertyId,
      role: opts.role,
      prompt_version: opts.promptVersion ?? null,
      title: opts.title ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function deleteConversation(
  conversationId: string,
  userAccountId: string,
): Promise<boolean> {
  // Ownership check first to avoid 404 vs 403 ambiguity.
  const { data: row } = await supabaseAdmin
    .from('agent_conversations')
    .select('user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!row || row.user_id !== userAccountId) return false;
  const { error } = await supabaseAdmin
    .from('agent_conversations')
    .delete()
    .eq('id', conversationId);
  if (error) throw error;
  return true;
}

export async function setConversationTitle(
  conversationId: string,
  userAccountId: string,
  title: string,
): Promise<boolean> {
  const { data: row } = await supabaseAdmin
    .from('agent_conversations')
    .select('user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!row || row.user_id !== userAccountId) return false;
  const { error } = await supabaseAdmin
    .from('agent_conversations')
    .update({ title: title.slice(0, 200) })
    .eq('id', conversationId);
  if (error) throw error;
  return true;
}

// ─── Message persistence ──────────────────────────────────────────────────

export async function appendMessage(opts: SaveMessageOpts): Promise<void> {
  const { error } = await supabaseAdmin.from('agent_messages').insert({
    conversation_id: opts.conversationId,
    role: opts.role,
    content: opts.content ?? null,
    tool_call_id: opts.toolCallId ?? null,
    tool_name: opts.toolName ?? null,
    tool_args: opts.toolArgs ?? null,
    tool_result: opts.toolResult === undefined ? null : opts.toolResult,
    is_error: opts.isError ?? null,
    tokens_in: opts.tokensIn ?? null,
    tokens_out: opts.tokensOut ?? null,
    model_used: opts.modelUsed ?? null,
    cost_usd: opts.costUsd ?? null,
  });
  if (error) throw error;
}

/** Helper: write a user turn. Convenience wrapper. */
export function recordUserTurn(conversationId: string, content: string): Promise<void> {
  return appendMessage({ conversationId, role: 'user', content });
}

/** Helper: write an assistant turn (text + optional tool calls) atomically.
 *
 * Codex review fix #2 (2026-05-13): the previous implementation did
 * sequential `appendMessage` calls — if the text row succeeded but a
 * tool_use row failed, the conversation got orphan tool_results on the
 * next iteration. Now we call `staxis_record_assistant_turn` which writes
 * all rows in a single transaction. Throws on failure (no swallow) — the
 * caller MUST abort the stream and cancel the cost reservation if this
 * throws, otherwise tool_result rows will be persisted without their
 * matching tool_use and the conversation is corrupted.
 *
 * Defense-in-depth backlog cleanup, 2026-05-13: `modelId` (exact Anthropic
 * snapshot ID, e.g. 'claude-sonnet-4-6-20260427') is now persisted on
 * the assistant text row so individual turns can be correlated to model
 * snapshot releases — closes the audit-trail gap where agent_costs had
 * model_id but agent_messages only had the tier.
 */
export async function recordAssistantTurn(
  conversationId: string,
  text: string,
  toolCalls: AgentToolCall[] | undefined,
  telemetry: {
    tokensIn: number;
    tokensOut: number;
    modelUsed: ModelTier;
    modelId: string | null;
    costUsd: number;
    /** PROMPT_VERSION captured at the moment this turn was produced.
     *  Longevity L2a, 2026-05-13: persisted per-row so we can correlate
     *  quality regressions to specific prompt versions. */
    promptVersion: string;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('staxis_record_assistant_turn', {
    p_conversation_id: conversationId,
    p_text: text ?? '',
    p_tool_calls: (toolCalls ?? []).map(c => ({
      id: c.id,
      name: c.name,
      args: c.args ?? {},
    })),
    p_tokens_in: telemetry.tokensIn,
    p_tokens_out: telemetry.tokensOut,
    p_model: telemetry.modelUsed,
    p_model_id: telemetry.modelId,
    p_cost_usd: telemetry.costUsd,
    p_prompt_version: telemetry.promptVersion,
  });
  if (error) {
    // Throw — caller is expected to catch, cancel the cost reservation,
    // and abort the stream rather than continuing into tool execution.
    throw new Error(`recordAssistantTurn failed: ${error.message}`);
  }
}

/** Helper: write a tool result row. L8B (2026-05-13): isError persisted
 *  so the metrics route can compute per-tool error rate. */
export function recordToolResult(
  conversationId: string,
  toolCallId: string,
  result: unknown,
  isError: boolean,
): Promise<void> {
  return appendMessage({
    conversationId,
    role: 'tool',
    toolCallId,
    toolResult: result,
    isError,
  });
}

/**
 * Insert a synthetic tool_result row for a tool_call_id that didn't get
 * a normal result before the stream aborted. Round-8 fix B7, 2026-05-13:
 * post-migration 0094 there's a partial unique index on
 * (conversation_id, tool_call_id) for role='tool' rows. If the normal
 * `recordToolResult` already landed earlier in the stream but the
 * route's finally still has the id in `pendingToolCallIds` (race),
 * a plain insert would throw a unique-violation. The route catches
 * and logs, producing noisy errors in prod for every abort path.
 *
 * Use ON CONFLICT DO NOTHING via supabase-js upsert so an existing row
 * is left untouched silently. Idempotent and cleaner in logs.
 */
export async function recordSyntheticAbortToolResult(
  conversationId: string,
  toolCallId: string,
  result: unknown,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_messages')
    .upsert(
      {
        conversation_id: conversationId,
        role: 'tool',
        tool_call_id: toolCallId,
        tool_result: result ?? null,
        // L8B (2026-05-13): the synthetic abort is always an error case
        // (we never know what the tool would have returned, and the
        // user sees an abort message). Counts toward tool error rate.
        is_error: true,
      },
      {
        onConflict: 'conversation_id,tool_call_id',
        ignoreDuplicates: true,
      },
    );
  if (error) {
    throw new Error(`recordSyntheticAbortToolResult failed: ${error.message}`);
  }
}

/**
 * Atomic prep for /api/agent/command: acquire per-conversation lock,
 * verify ownership + property scope, load history, and record the user
 * turn — all in ONE RPC transaction.
 *
 * Codex round-7 fix F2: replaces the prior two-step pattern (call
 * staxis_lock_conversation, then loadConversation + recordUserTurn in
 * JS) which had a race window because supabase-js wraps each .rpc() in
 * its own transaction. The lock from the first call released BEFORE
 * the JS prep ran. This RPC does everything under one tx + lock.
 */
export interface LockedPrepResult {
  ok: boolean;
  reason: 'not_found' | 'wrong_owner' | 'wrong_property' | null;
  history: AgentMessage[];
}

export async function lockLoadAndRecordUserTurn(opts: {
  conversationId: string;
  userAccountId: string;
  propertyId: string;
  userMessage: string;
}): Promise<LockedPrepResult> {
  const { data, error } = await supabaseAdmin.rpc('staxis_lock_load_and_record_user_turn', {
    p_conversation_id: opts.conversationId,
    p_user_account_id: opts.userAccountId,
    p_property_id: opts.propertyId,
    p_user_message: opts.userMessage,
  });
  if (error) throw new Error(`lockLoadAndRecordUserTurn RPC failed: ${error.message}`);

  // RPC returns table(ok, reason, history_rows) — supabase-js gives an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('lockLoadAndRecordUserTurn returned no row');

  if (!row.ok) {
    return {
      ok: false,
      reason: (row.reason as LockedPrepResult['reason']) ?? null,
      history: [],
    };
  }

  // Reconstruct AgentMessage[] from jsonb. The RPC already filters
  // is_summarized=false; we additionally need to know which rows are
  // summary rows (is_summary=true) so we can emit them as self-
  // contained assistant turns without attaching subsequent tool_result
  // rows. L4 part B fix, 2026-05-13.
  const rawRows = (row.history_rows ?? []) as Array<{
    role: string;
    content: string | null;
    tool_call_id: string | null;
    tool_name: string | null;
    tool_args: Record<string, unknown> | null;
    tool_result: unknown;
    is_summary?: boolean;
  }>;

  const messages: AgentMessage[] = [];
  let pendingAssistant: { content: string; toolCalls: AgentToolCall[] } | null = null;
  const flushPending = () => {
    if (pendingAssistant) {
      messages.push({
        role: 'assistant',
        content: pendingAssistant.content,
        toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
      });
      pendingAssistant = null;
    }
  };

  for (const r of rawRows) {
    if (r.role === 'user') {
      flushPending();
      messages.push({ role: 'user', content: r.content ?? '' });
    } else if (r.role === 'assistant') {
      if (r.is_summary === true) {
        // Round 10 F4c (2026-05-13): wrap summary content in trust
        // marker (matches loadConversation site above). PROMPT_BASE has
        // the matching read-side rule (F4d).
        flushPending();
        messages.push({
          role: 'assistant',
          // Round 12 T12.6 (2026-05-13): see matching site above in
          // loadConversation. Escape Haiku content before trust-wrap.
          content: `<staxis-summary trust="system-derived-from-untrusted">${escapeTrustMarkerContent(r.content ?? '')}</staxis-summary>`,
        });
      } else {
        if (!pendingAssistant) pendingAssistant = { content: '', toolCalls: [] };
        if (r.tool_name) {
          pendingAssistant.toolCalls.push({
            id: r.tool_call_id ?? '',
            name: r.tool_name,
            args: r.tool_args ?? {},
          });
        } else if (r.content) {
          pendingAssistant.content =
            (pendingAssistant.content ? pendingAssistant.content + '\n' : '') + r.content;
        }
      }
    } else if (r.role === 'tool') {
      flushPending();
      messages.push({
        role: 'tool',
        toolCallId: r.tool_call_id ?? '',
        result: r.tool_result ?? null,
      });
    }
  }
  flushPending();

  return { ok: true, reason: null, history: messages };
}
