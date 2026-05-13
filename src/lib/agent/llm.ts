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
// each with their own DB round-trips, total wall time matters. 60s is
// generous and well under Vercel's 300s function ceiling on Pro plans.
const REQUEST_TIMEOUT_MS = 60_000;

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

// ─── Smart routing ─────────────────────────────────────────────────────────

export interface RoutingHints {
  /** Caller can force a specific tier (e.g. evals pin to Sonnet). */
  forceModel?: ModelTier;
  /** Hint that the user's request is complex (financial analysis, multi-step). */
  complex?: boolean;
}

/**
 * Pick the model tier for this turn.
 *
 * For v1: default to Sonnet, which is the workhorse model Reeyen approved
 * ("same brain Notion / Linear / Anthropic use"). Future optimization: route
 * confirmed-simple commands ("mark 302 clean") to Haiku for ~10× cost win.
 * Don't ship Haiku-default until we have evals proving it doesn't regress.
 */
export function pickModel(hints: RoutingHints = {}): ModelTier {
  if (hints.forceModel) return hints.forceModel;
  if (hints.complex) return 'opus';
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

export interface RunAgentOpts {
  /** System prompt — the brain's "you are" instructions. Will be cache-marked. */
  systemPrompt: string;
  /** Conversation history (the past). */
  history: AgentMessage[];
  /** The user's new turn. */
  newUserMessage: string;
  /** Tools the model can call this turn. */
  tools: ToolDefinition[];
  /** Tool execution context (user + property + request id). */
  toolContext: ToolContext;
  /** Routing hints (force model, etc.). */
  hints?: RoutingHints;
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
 * Subtle requirement from Anthropic: every tool_use block in an assistant
 * turn must have its matching tool_result block in the IMMEDIATELY following
 * user turn — and multiple tool_results must be packed into ONE user
 * message, not separate adjacent user messages. We coalesce consecutive
 * tool entries here so a turn with N tool calls produces exactly one
 * user message containing N tool_result blocks.
 *
 * Codex review fix #3 Layer B (2026-05-13): also repairs DANGLING tool_use
 * blocks — assistant tool_uses with no matching tool_result in the history.
 * This happens when a previous request crashed/aborted before its tool
 * results landed. We inject synthetic error tool_results for each unmatched
 * id so the replay still validates. Layer A (cleanup-on-abort in the route)
 * is the primary defense; Layer B exists for the cases where Layer A itself
 * fails (process crash, OOM, etc.).
 */
function toClaudeMessages(history: AgentMessage[], newUser: string): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];
  let toolResultBuffer: ClaudeContent[] = [];

  const flushToolResults = () => {
    if (toolResultBuffer.length) {
      out.push({ role: 'user', content: toolResultBuffer });
      toolResultBuffer = [];
    }
  };

  // Walk the history once and collect the tool_use ids that are followed
  // (eventually, before the next non-tool message) by a matching tool_result.
  // Anything in tool_use that's not in this set is dangling and gets a
  // synthetic result injected at the right spot below.
  const matchedToolUseIds = new Set<string>();
  {
    const knownToolResultIds = new Set<string>();
    for (const m of history) {
      if (m.role === 'tool' && m.toolCallId) {
        knownToolResultIds.add(m.toolCallId);
      }
    }
    for (const m of history) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (knownToolResultIds.has(tc.id)) matchedToolUseIds.add(tc.id);
        }
      }
    }
  }

  for (const m of history) {
    if (m.role === 'user') {
      flushToolResults();
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      flushToolResults();
      const blocks: ClaudeContent[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
      }
      out.push({ role: 'assistant', content: blocks });

      // If any tool_use in this assistant turn lacks a tool_result later
      // in the history, synthesize an error result for it RIGHT NOW so
      // Claude's "tool_use must be immediately followed by tool_result"
      // rule is satisfied. The dangling tools become "aborted" errors —
      // honest about what happened.
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (!matchedToolUseIds.has(tc.id)) {
            toolResultBuffer.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: 'Tool result was not captured (request was aborted or crashed before completion).',
              is_error: true,
            });
          }
        }
      }
    } else if (m.role === 'tool') {
      toolResultBuffer.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: typeof m.result === 'string' ? m.result : JSON.stringify(m.result),
        is_error: m.isError ?? false,
      });
    }
  }
  flushToolResults();

  // The new user turn always goes at the end.
  out.push({ role: 'user', content: newUser });
  return out;
}

/** Build a cache-marked system block so the prompt prefix is reused across turns. */
function buildSystemBlocks(systemPrompt: string): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ─── Sync agent loop ───────────────────────────────────────────────────────

/**
 * Run one full agent turn: send user message → model thinks → maybe calls
 * tools → we run tools → feed results back → model produces final answer.
 * Returns when the model produces a text response with no further tool
 * calls (or we hit MAX_TOOL_ITERATIONS).
 */
export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const model = pickModel(opts.hints);
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
      // Done — final answer.
      return {
        text: turnText,
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
  const model = pickModel(opts.hints);
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
        // Final answer reached.
        yield {
          type: 'done',
          usage: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cachedInputTokens: totalCachedInput,
            model,
            costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
          },
          finalText,
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
