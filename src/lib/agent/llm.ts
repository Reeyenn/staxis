// ─── Agent LLM wrapper ─────────────────────────────────────────────────────
// Thin wrapper over @anthropic-ai/sdk that:
//   1. Picks the model (smart routing, see pickModel below)
//   2. Builds the request shape (system prompt + tools + history + new turn)
//   3. Drives the tool-call loop (model calls tool → run tool → feed result back → repeat)
//   4. Tracks token usage + cost
//   5. Exposes both sync and streaming variants
//
// Sync runAgent() is for tests, evals, and one-shot internal calls.
// Streaming streamAgent() is what the /api/agent/command endpoint uses to
// pipe Claude's response token-by-token to the client via SSE.

import Anthropic from '@anthropic-ai/sdk';
import {
  executeTool,
  toAnthropicTools,
  type ToolContext,
  type ToolDefinition,
} from './tools';

// ─── Configuration ─────────────────────────────────────────────────────────

// Model IDs pinned. Bumping any of these requires re-running evals before
// merging — see src/lib/agent/evals/ (to be added).
export const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
} as const;

export type ModelTier = keyof typeof MODELS;

// Pricing in USD per million tokens (input | output). Cached input is 10×
// cheaper. Numbers are approximate per the cost-estimation rule — real
// spend should be read off console.anthropic.com/cost after we ship.
const PRICING: Record<ModelTier, { input: number; output: number; cachedInput: number }> = {
  haiku:  { input: 1.00,  output: 5.00,  cachedInput: 0.10 },
  sonnet: { input: 3.00,  output: 15.00, cachedInput: 0.30 },
  opus:   { input: 15.00, output: 75.00, cachedInput: 1.50 },
};

// Per-request timeout. Tool loops can fan out — if Claude calls 5 tools
// each with their own DB round-trips, total wall time matters. Set to 50s
// so the SDK fails BEFORE Vercel's maxDuration=60s kills the function —
// gives the route's finally block time to release the cost reservation
// and synthesize tool_result rows for any dangling tool_use. Codex review
// fix B5, 2026-05-13.
const REQUEST_TIMEOUT_MS = 50_000;

// Max tool-call iterations within one user turn before we give up. Prevents
// runaway loops where the model keeps calling tools without resolving.
const MAX_TOOL_ITERATIONS = 8;

// ─── Client ────────────────────────────────────────────────────────────────

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. The agent layer requires it. ' +
      'Set in Vercel → Project Settings → Environment Variables and redeploy.',
    );
  }
  cachedClient = new Anthropic({ apiKey: key, timeout: REQUEST_TIMEOUT_MS });
  return cachedClient;
}

// ─── Model selection ──────────────────────────────────────────────────────
// Pinned to Sonnet 4.6 — the workhorse model Reeyen approved ("same brain
// Notion / Linear / Anthropic use"). Smart routing (Haiku for confirmed-
// simple commands → ~10× cost win) is backlog and requires evals to prove
// no regression before flipping the default. Codex review fix A6, 2026-05-13:
// removed the dead RoutingHints surface that was never used by callers.
function pickModel(): ModelTier {
  return 'sonnet';
}

// ─── Cost estimation ───────────────────────────────────────────────────────

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  model: ModelTier;
  costUsd: number;
}

export function estimateCost(
  model: ModelTier,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = PRICING[model];
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput / 1_000_000) * p.input +
    (cachedInputTokens / 1_000_000) * p.cachedInput +
    (outputTokens / 1_000_000) * p.output
  );
}

// ─── Public agent interface ────────────────────────────────────────────────

// Conversation history as our agent module sees it. We translate to Claude's
// shape inside the wrapper so callers don't need to know the SDK layout.
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; result: unknown; isError?: boolean };

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * System prompt split into stable (cache-eligible) and dynamic (changes
 * every turn) pieces. The Anthropic API accepts an array of system blocks
 * with per-block cache_control — only the stable block gets cached, so
 * the dynamic snapshot doesn't invalidate the cache. Codex review fix A1.
 */
export interface SystemPromptBlocks {
  /** Stable across the conversation — eligible for prompt caching. */
  stable: string;
  /** Changes every turn (e.g. live hotel snapshot). NOT cached. */
  dynamic: string;
}

export interface RunAgentOpts {
  /** System prompt — split into stable (cached) + dynamic (not cached). */
  systemPrompt: SystemPromptBlocks;
  /** Conversation history (the past). */
  history: AgentMessage[];
  /** The user's new turn. */
  newUserMessage: string;
  /** Tools the model can call this turn. */
  tools: ToolDefinition[];
  /** Tool execution context (user + property + request id). */
  toolContext: ToolContext;
}

export interface RunAgentResult {
  /** Final assistant text after the tool loop resolves. */
  text: string;
  /** Tool calls that were made + their results. */
  toolCallsExecuted: Array<{ call: AgentToolCall; result: unknown; isError: boolean }>;
  /** All assistant messages produced in this turn (in case there were several). */
  assistantMessages: Array<{ content: string; toolCalls?: AgentToolCall[] }>;
  /** Token + cost report. */
  usage: UsageReport;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

type ClaudeMessage = Anthropic.Messages.MessageParam;
type ClaudeContent = Anthropic.Messages.ContentBlockParam;

/**
 * Translate our AgentMessage shape into Claude's MessageParam list.
 *
 * Anthropic's strict requirement: every assistant `tool_use` block must
 * be IMMEDIATELY followed by a user message containing the matching
 * `tool_result` block(s). Multiple tool_results from one iteration must
 * be packed into a SINGLE user message — not adjacent ones.
 *
 * This function reconstructs that exact shape from our DB-row representation,
 * AND repairs dangling tool_use blocks left behind when a prior request
 * was aborted or crashed before its tool_results landed.
 *
 * Adjacency-aware repair (Codex review fix C3, 2026-05-13): we look only
 * at the contiguous run of `tool` rows IMMEDIATELY after each assistant
 * turn — anything outside that adjacent block doesn't count as a match.
 * The previous implementation searched the entire history for matching
 * tool_result ids, which could let an out-of-order persistence (e.g.
 * abort-cleanup row racing a new user turn) be misclassified as
 * "matched" while still producing an invalid message sequence.
 */
function toClaudeMessages(history: AgentMessage[], newUser: string): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];

  // Iterate over history with explicit index control so we can peek
  // ahead at the contiguous tool-result block after each assistant turn.
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      i++;
      continue;
    }
    if (m.role === 'tool') {
      // Stray tool result with no immediately-preceding assistant tool_use.
      // Skip it — emitting a tool_result without a matching tool_use would
      // make Claude reject the whole request.
      i++;
      continue;
    }

    // Assistant turn. Emit text + tool_use blocks.
    const blocks: ClaudeContent[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    const toolCallIds: string[] = [];
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        toolCallIds.push(tc.id);
      }
    }
    out.push({ role: 'assistant', content: blocks });
    i++;

    // If this assistant turn had no tool calls, no tool_result follow-up
    // is expected — continue to the next iteration.
    if (toolCallIds.length === 0) continue;

    // Otherwise, consume the contiguous `tool` rows that follow as the
    // matching tool_result block. Stop at the first non-tool row.
    const adjacentResults = new Map<string, AgentMessage & { role: 'tool' }>();
    while (i < history.length && history[i].role === 'tool') {
      const tm = history[i] as AgentMessage & { role: 'tool' };
      if (tm.toolCallId) adjacentResults.set(tm.toolCallId, tm);
      i++;
    }

    // For each tool_use in the assistant turn, emit a matching tool_result.
    // Missing ones (dangling — never persisted, or aborted) get a synthetic
    // error result so the message sequence still validates.
    const resultBlocks: ClaudeContent[] = toolCallIds.map(id => {
      const tm = adjacentResults.get(id);
      if (tm) {
        return {
          type: 'tool_result' as const,
          tool_use_id: id,
          content: typeof tm.result === 'string' ? tm.result : JSON.stringify(tm.result),
          is_error: tm.isError ?? false,
        };
      }
      return {
        type: 'tool_result' as const,
        tool_use_id: id,
        content: 'Tool result was not captured (request was aborted or crashed before completion).',
        is_error: true,
      };
    });
    out.push({ role: 'user', content: resultBlocks });
  }

  // The new user turn always goes at the end.
  out.push({ role: 'user', content: newUser });
  return out;
}

/**
 * Build the system blocks for a request.
 *
 * Two blocks: stable (cache_control: ephemeral) + dynamic (no caching).
 * The stable block (base + role prompt) is identical across turns of a
 * conversation, so Anthropic's prompt cache hits — typically 80%+ of
 * system tokens. The dynamic block (live hotel snapshot) is appended
 * un-cached because it changes every turn. Codex review fix A1.
 */
function buildSystemBlocks(systemPrompt: SystemPromptBlocks): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: systemPrompt.stable,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (systemPrompt.dynamic && systemPrompt.dynamic.trim().length > 0) {
    blocks.push({ type: 'text', text: systemPrompt.dynamic });
  }
  return blocks;
}

// ─── Sync agent loop ───────────────────────────────────────────────────────

/**
 * Run one full agent turn: send user message → model thinks → maybe calls
 * tools → we run tools → feed results back → model produces final answer.
 * Returns when the model produces a text response with no further tool
 * calls (or we hit MAX_TOOL_ITERATIONS).
 */
export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const model = pickModel();
  const client = getClient();
  const tools = toAnthropicTools(opts.tools);

  let messages = toClaudeMessages(opts.history, opts.newUserMessage);
  const toolCallsExecuted: RunAgentResult['toolCallsExecuted'] = [];
  const assistantMessages: RunAgentResult['assistantMessages'] = [];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCachedInput = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: MODELS[model],
      max_tokens: 4096,
      system: buildSystemBlocks(opts.systemPrompt),
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    totalCachedInput += response.usage.cache_read_input_tokens ?? 0;

    // Collect text + tool_use blocks from this assistant turn.
    const textParts: string[] = [];
    const calls: AgentToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        calls.push({
          id: block.id,
          name: block.name,
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
    const turnText = textParts.join('\n');
    assistantMessages.push({ content: turnText, toolCalls: calls.length ? calls : undefined });

    // Append the assistant turn to the conversation for the next iteration.
    messages = [...messages, { role: 'assistant', content: response.content }];

    if (response.stop_reason !== 'tool_use' || calls.length === 0) {
      // Done — final answer. If we hit the token cap, surface that
      // clearly in the response text instead of silently returning a
      // truncated answer (Codex review fix A2).
      const finalText = response.stop_reason === 'max_tokens'
        ? `${turnText}\n\n_(Response hit the 4096-token limit. Ask a follow-up to continue.)_`
        : turnText;
      return {
        text: finalText,
        toolCallsExecuted,
        assistantMessages,
        usage: {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cachedInputTokens: totalCachedInput,
          model,
          costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
        },
      };
    }

    // Execute each tool call and append the results as a single user turn.
    const toolResultBlocks: ClaudeContent[] = [];
    for (const call of calls) {
      const result = await executeTool(call.name, call.args, opts.toolContext);
      const isError = !result.ok;
      toolCallsExecuted.push({ call, result: result.data ?? result.error, isError });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.ok
          ? typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data ?? null)
          : (result.error ?? 'Tool failed without a message'),
        is_error: isError,
      });
    }
    messages = [...messages, { role: 'user', content: toolResultBlocks }];
  }

  // Hit the iteration cap — return what we have with a stub error message.
  return {
    text: 'I reached the maximum number of tool calls without resolving. Please rephrase or try a more specific question.',
    toolCallsExecuted,
    assistantMessages,
    usage: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedInputTokens: totalCachedInput,
      model,
      costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
    },
  };
}

// ─── Streaming agent loop ──────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  // Emitted once per iteration when the assistant is about to invoke tools.
  // Lets the route persist the assistant turn (text + tool_use blocks) in
  // the same DB order Claude expects on replay: assistant tool_use BEFORE
  // user tool_result.
  | { type: 'assistant_turn'; text: string; toolCalls: AgentToolCall[]; usage: UsageReport }
  | { type: 'tool_call_started'; call: AgentToolCall }
  | { type: 'tool_call_finished'; call: AgentToolCall; result: unknown; isError: boolean }
  | { type: 'done'; usage: UsageReport; finalText: string }
  | { type: 'error'; message: string };

/**
 * Streaming version of runAgent. Yields events the SSE endpoint can pipe to
 * the client. The shape is intentionally narrow — we only forward what the
 * UI needs to render (text deltas, tool call status, final done).
 */
export async function* streamAgent(opts: RunAgentOpts): AsyncGenerator<AgentEvent> {
  const model = pickModel();
  const client = getClient();
  const tools = toAnthropicTools(opts.tools);

  let messages = toClaudeMessages(opts.history, opts.newUserMessage);
  let totalInput = 0;
  let totalOutput = 0;
  let totalCachedInput = 0;
  let finalText = '';

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const stream = client.messages.stream({
        model: MODELS[model],
        max_tokens: 4096,
        system: buildSystemBlocks(opts.systemPrompt),
        tools: tools.length > 0 ? tools : undefined,
        messages,
      });

      // Buffer the assistant content blocks as we stream so we can replay them
      // on the next iteration if there are tool calls.
      const turnText: string[] = [];
      const calls: AgentToolCall[] = [];

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          turnText.push(event.delta.text);
          finalText = ''; // reset — final text is reassembled at end of iteration
          yield { type: 'text_delta', delta: event.delta.text };
        }
      }

      const finalMsg = await stream.finalMessage();
      totalInput += finalMsg.usage.input_tokens;
      totalOutput += finalMsg.usage.output_tokens;
      totalCachedInput += finalMsg.usage.cache_read_input_tokens ?? 0;

      for (const block of finalMsg.content) {
        if (block.type === 'tool_use') {
          calls.push({
            id: block.id,
            name: block.name,
            args: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }
      finalText = turnText.join('');

      messages = [...messages, { role: 'assistant', content: finalMsg.content }];

      if (finalMsg.stop_reason !== 'tool_use' || calls.length === 0) {
        // Final answer reached. If we hit the 4096-token output cap,
        // append a clear truncation marker so the user knows the answer
        // was cut off (Codex review fix A2). Otherwise it looks like a
        // normal answer that just happened to end mid-sentence.
        const completionText = finalMsg.stop_reason === 'max_tokens'
          ? `${finalText}\n\n_(Response hit the 4096-token limit — ask a follow-up to continue.)_`
          : finalText;
        yield {
          type: 'done',
          usage: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cachedInputTokens: totalCachedInput,
            model,
            costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
          },
          finalText: completionText,
        };
        return;
      }

      // Mid-conversation turn: model wants to call tools. Tell the route to
      // persist the assistant turn NOW, before the tool results land —
      // otherwise the DB ends up with tool_results before the matching
      // tool_use entries and Claude rejects the replayed conversation.
      yield {
        type: 'assistant_turn',
        text: finalText,
        toolCalls: calls,
        usage: {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cachedInputTokens: totalCachedInput,
          model,
          costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
        },
      };

      // Run the tools and feed results back.
      const toolResultBlocks: ClaudeContent[] = [];
      for (const call of calls) {
        yield { type: 'tool_call_started', call };
        const result = await executeTool(call.name, call.args, opts.toolContext);
        const isError = !result.ok;
        yield { type: 'tool_call_finished', call, result: result.data ?? result.error, isError };
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: result.ok
            ? typeof result.data === 'string'
              ? result.data
              : JSON.stringify(result.data ?? null)
            : (result.error ?? 'Tool failed without a message'),
          is_error: isError,
        });
      }
      messages = [...messages, { role: 'user', content: toolResultBlocks }];
    }

    // Iteration cap reached.
    yield {
      type: 'error',
      message: 'Reached maximum tool-call iterations without resolving.',
    };
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
