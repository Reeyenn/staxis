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

  // Pull messages in chronological order.
  const { data: rows, error: msgErr } = await supabaseAdmin
    .from('agent_messages')
    .select('role, content, tool_call_id, tool_name, tool_args, tool_result, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (msgErr) throw msgErr;

  const messages: AgentMessage[] = [];
  // Group assistant text + adjacent assistant tool_use rows into a single
  // AgentMessage so the LLM wrapper sees the same shape it produced.
  let pendingAssistant: { content: string; toolCalls: AgentToolCall[] } | null = null;

  for (const row of rows ?? []) {
    const role = row.role as string;
    if (role === 'user') {
      if (pendingAssistant) {
        messages.push({
          role: 'assistant',
          content: pendingAssistant.content,
          toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
        });
        pendingAssistant = null;
      }
      messages.push({ role: 'user', content: (row.content as string) ?? '' });
    } else if (role === 'assistant') {
      if (!pendingAssistant) pendingAssistant = { content: '', toolCalls: [] };
      // Either a text turn (content set) or a tool_use turn (tool_name set).
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
    } else if (role === 'tool') {
      if (pendingAssistant) {
        messages.push({
          role: 'assistant',
          content: pendingAssistant.content,
          toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
        });
        pendingAssistant = null;
      }
      messages.push({
        role: 'tool',
        toolCallId: (row.tool_call_id as string) ?? '',
        result: row.tool_result ?? null,
      });
    }
    // 'system' rows aren't replayed — they're metadata (e.g., nudge surface).
  }
  if (pendingAssistant) {
    messages.push({
      role: 'assistant',
      content: pendingAssistant.content,
      toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
    });
  }

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
  });
  if (error) {
    // Throw — caller is expected to catch, cancel the cost reservation,
    // and abort the stream rather than continuing into tool execution.
    throw new Error(`recordAssistantTurn failed: ${error.message}`);
  }
}

/** Helper: write a tool result row. */
export function recordToolResult(
  conversationId: string,
  toolCallId: string,
  result: unknown,
): Promise<void> {
  return appendMessage({
    conversationId,
    role: 'tool',
    toolCallId,
    toolResult: result,
  });
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

  // Reconstruct AgentMessage[] from jsonb. Same shape as loadConversation
  // returns — assistant turns with adjacent tool_use rows get folded by
  // toClaudeMessages adjacency logic on the next replay.
  const rawRows = (row.history_rows ?? []) as Array<{
    role: string;
    content: string | null;
    tool_call_id: string | null;
    tool_name: string | null;
    tool_args: Record<string, unknown> | null;
    tool_result: unknown;
  }>;

  const messages: AgentMessage[] = [];
  let pendingAssistant: { content: string; toolCalls: AgentToolCall[] } | null = null;
  for (const r of rawRows) {
    if (r.role === 'user') {
      if (pendingAssistant) {
        messages.push({
          role: 'assistant',
          content: pendingAssistant.content,
          toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
        });
        pendingAssistant = null;
      }
      messages.push({ role: 'user', content: r.content ?? '' });
    } else if (r.role === 'assistant') {
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
    } else if (r.role === 'tool') {
      if (pendingAssistant) {
        messages.push({
          role: 'assistant',
          content: pendingAssistant.content,
          toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
        });
        pendingAssistant = null;
      }
      messages.push({
        role: 'tool',
        toolCallId: r.tool_call_id ?? '',
        result: r.tool_result ?? null,
      });
    }
  }
  if (pendingAssistant) {
    messages.push({
      role: 'assistant',
      content: pendingAssistant.content,
      toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
    });
  }

  return { ok: true, reason: null, history: messages };
}
