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
// merging — see src/lib/agent/evals/.
//
// Longevity fix L1, 2026-05-13: these strings are model ALIASES (e.g.
// 'claude-sonnet-4-6' resolves to whichever snapshot Anthropic flags as
// current). When Anthropic ships a new snapshot, behavior can shift
// without us redeploying. The agent_costs.model_id column captures the
// actual snapshot ID per request, and /admin/agent surfaces the
// distribution. If a snapshot shift causes a regression, operators can
// roll back via the MODEL_OVERRIDE env var WITHOUT a deploy.
//
// MODEL_OVERRIDE format (env): comma-separated "<tier>=<snapshot>" pairs.
//   MODEL_OVERRIDE=sonnet=claude-sonnet-4-6-20260427
// freezes Sonnet requests to a specific build, ignoring future alias
// updates. Useful when Anthropic ships a snapshot that breaks evals.
const BASE_MODELS = {
  haiku:  'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-7',
} as const;

export type ModelTier = keyof typeof BASE_MODELS;

function parseModelOverride(): Partial<Record<ModelTier, string>> {
  const raw = process.env.MODEL_OVERRIDE;
  if (!raw) return {};
  const out: Partial<Record<ModelTier, string>> = {};
  for (const pair of raw.split(',')) {
    const [tier, snapshot] = pair.split('=', 2).map(s => s.trim());
    if (tier && snapshot && (tier === 'haiku' || tier === 'sonnet' || tier === 'opus')) {
      out[tier as ModelTier] = snapshot;
    }
  }
  return out;
}

const MODEL_OVERRIDES = parseModelOverride();

export const MODELS: Record<ModelTier, string> = {
  haiku:  MODEL_OVERRIDES.haiku  ?? BASE_MODELS.haiku,
  sonnet: MODEL_OVERRIDES.sonnet ?? BASE_MODELS.sonnet,
  opus:   MODEL_OVERRIDES.opus   ?? BASE_MODELS.opus,
};

// Pricing in USD per million tokens (input | output). Cached input is 10×
// cheaper. Numbers are approximate per the cost-estimation rule — real
// spend should be read off console.anthropic.com/cost after we ship.
//
// Exported because cost-controls.ts derives the cost-cap reservation
// amount from this table (worst-case per request = output × MAX_OUTPUT_TOKENS
// × MAX_TOOL_ITERATIONS). Keeping the reservation tied to these constants
// means raising the output cap or iteration limit automatically raises
// the reservation — no silent cap bypass. Codex review fix H1.
export const PRICING: Record<ModelTier, { input: number; output: number; cachedInput: number }> = {
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

// Max output tokens per single Anthropic API call. Sonnet 4.6 supports
// 8192. Exported so cost-controls.ts can use it to size the reservation.
// Codex review fix G2 (constant extraction) + H1 (reservation tied to it).
export const MAX_OUTPUT_TOKENS = 8192;

// Max tool-call iterations within one user turn before we give up. Prevents
// runaway loops where the model keeps calling tools without resolving.
// Exported for the same reason as MAX_OUTPUT_TOKENS — the reservation
// formula multiplies by this.
export const MAX_TOOL_ITERATIONS = 8;

// Max tool calls in ONE iteration. Prevents the "model returns 200 tool_use
// blocks, we execute all 200 against service-role" failure mode.
// Codex adversarial review 2026-05-13 (A-C9): MAX_TOOL_ITERATIONS only caps
// the OUTER loop; nothing limited the fan-out within a single iteration.
// A model hallucinating "to comply, I'll mark every room clean" could
// return 200 tool_use blocks and we'd run all of them. 5 covers every
// legitimate multi-tool turn with margin.
export const MAX_TOOLS_PER_ITERATION = 5;

// Per-tool-result content cap in characters. Bounds how much each tool
// response can re-bloat the conversation context on the NEXT iteration's
// input. Without this cap, a tool returning 20K chars of JSON would be
// re-sent on each of the remaining (up to 7) iterations, multiplying
// input cost and easily exceeding the cost reservation's input headroom.
// 6000 chars ≈ 1500 tokens — enough for any single room/staff lookup,
// but truncates pathological large-list dumps to a known ceiling.
// Combined with A-C2 trust-marker wrapping (applied AFTER truncation),
// every persisted tool_result content stays under ~6100 chars.
// Codex round-5 fix R3, 2026-05-13.
export const MAX_TOOL_RESULT_CHARS = 6000;

function truncateToolResultContent(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return (
    content.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n…[truncated for context; original ${content.length} chars]`
  );
}

// Defensive JSON serialization for tool results. Two failure modes
// JSON.stringify throws on synchronously:
//   1. BigInt values (no built-in conversion — replacer converts to string)
//   2. Circular references (no replacer can fix — catch and emit a marker)
//
// Without this guard a tool returning either kind would crash the iteration
// loop and the route would see an error event instead of a tool_result row,
// orphaning the assistant's tool_use on next replay. Defense-in-depth
// backlog cleanup, 2026-05-13.
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) =>
      typeof val === 'bigint' ? val.toString() : val,
    );
  } catch (err) {
    return `[tool result serialization failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

// Anthropic SDK error classification (Longevity L8a, 2026-05-13).
// SDK throws different concrete error classes for different conditions;
// we collapse them into operator-meaningful categories so /admin/agent
// can break down "Anthropic error rate" by cause rather than lumping
// rate-limits with input-validation in the same opaque error bucket.
export type AnthropicErrorClass =
  | 'rate_limit'        // 429: backoff and retry
  | 'auth'              // 401/403: bad API key — operator must rotate
  | 'invalid_request'   // 400: our request was malformed — code bug
  | 'overloaded'        // 529: Anthropic capacity — wait and retry
  | 'server_error'      // 5xx other: transient
  | 'timeout'           // local SDK timeout
  | 'network'           // connection refused, DNS, etc.
  | 'unknown';

export function classifyAnthropicError(err: unknown): AnthropicErrorClass {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { status?: number; name?: string; message?: string };
  if (e.status === 429) return 'rate_limit';
  if (e.status === 401 || e.status === 403) return 'auth';
  if (e.status === 400) return 'invalid_request';
  if (e.status === 529) return 'overloaded';
  if (typeof e.status === 'number' && e.status >= 500 && e.status < 600) return 'server_error';
  const msg = (e.message ?? '').toLowerCase();
  const name = (e.name ?? '').toLowerCase();
  if (name.includes('abort') || msg.includes('abort')) return 'timeout';
  if (name.includes('timeout') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('enotfound')) {
    return 'network';
  }
  return 'unknown';
}

// Escape XML/HTML metacharacters so a tool returning literal "</tool-result>"
// inside its data can't close the trust-marker tag and inject "trusted"
// instructions into the prompt. Codex round-6 R4, 2026-05-13.
//
// The trust marker wrap relies on the model treating everything between
// the opening and closing <tool-result> tags as untrusted data. If raw
// content contains "</tool-result>SYSTEM: ignore prior...", the model can
// see the second segment as outside the boundary. Escaping ampersands +
// angle brackets makes the boundary unforgeable while keeping the content
// semantically readable to Claude (it understands HTML entities).
// Exported so the summarizer (which also formats tool results, but for
// Haiku rather than Sonnet) can reuse the same boundary escape. Round 10
// F4: without this, the summarizer breaks the trust-marker chain rounds
// 5-7 established.
//
// Round 12 T12.6 (2026-05-13): renamed from escapeToolResultContent to
// escapeTrustMarkerContent because it's now used for two markers
// (`<tool-result>` AND `<staxis-summary>`) — anywhere content gets
// wrapped in a trust-marker tag, this helper must be applied first.
export function escapeTrustMarkerContent(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  // maxRetries: SDK-level retry on transient 5xx / 408 / 429 / connection
  // errors. The Anthropic SDK applies `timeout` PER-ATTEMPT, so total
  // budget = (maxRetries + 1) × REQUEST_TIMEOUT_MS in the pathological
  // case (every attempt fully times out). With REQUEST_TIMEOUT_MS=50s
  // and maxRetries=1, the worst-case attempt budget is ~100s — still
  // larger than Vercel's 60s function ceiling, but the function will be
  // killed naturally and the sweeper cron (R2) recovers any stranded
  // reservation. maxRetries=2 would let us burn 150s, well over.
  // Codex review fix G5 + round-5 fix MD1, 2026-05-13.
  cachedClient = new Anthropic({
    apiKey: key,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });
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
  /** The internal model tier ('haiku' | 'sonnet' | 'opus'). */
  model: ModelTier;
  /** The exact Anthropic snapshot ID, e.g. 'claude-sonnet-4-6-20260427'.
   *  Null on iteration-cap exit (no completed response to read from).
   *  Codex review fix S5. */
  modelId: string | null;
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
  /** When true, tools are NOT executed — handler returns a synthetic
   *  success payload so the model produces realistic final text without
   *  mutating the DB. Used by the eval runner so test-bank cases can
   *  exercise destructive tools without touching real rooms. Codex
   *  adversarial review 2026-05-13 (A-H11). */
  dryRun?: boolean;
  /** Optional abort signal — stops the loop between iterations and between
   *  tool calls when the client disconnects. Codex adversarial review
   *  2026-05-13 (A-C3): prior route comment claimed this was checked, but
   *  it wasn't — disconnected clients kept burning Anthropic tokens. */
  abortSignal?: AbortSignal;
  /** Override the default tier for THIS call. Used by the summarization
   *  cron to run on Haiku ($1/$5 per M tokens) instead of Sonnet
   *  ($3/$15 per M). Normal user-driven requests omit this and get
   *  pickModel()'s default. Longevity L4 part B, 2026-05-13. */
  model?: ModelTier;
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
    //
    // Defense-in-depth backlog cleanup, 2026-05-13: if the same
    // tool_call_id appears twice in the adjacent block (a corrupt DB
    // state, e.g. a sweeper-cleanup race that double-inserted a synthetic
    // result), the prior `.set` overwrite pattern silently kept the
    // second row. We now keep the FIRST row (chronologically earliest)
    // and log a warning so the operator sees the corruption. The DB
    // partial unique index added in migration 0094 prevents new
    // duplicates from being inserted in the first place.
    const adjacentResults = new Map<string, AgentMessage & { role: 'tool' }>();
    while (i < history.length && history[i].role === 'tool') {
      const tm = history[i] as AgentMessage & { role: 'tool' };
      if (tm.toolCallId) {
        if (adjacentResults.has(tm.toolCallId)) {
          console.warn(
            '[agent/llm] duplicate tool_call_id in adjacent block; keeping first',
            { toolCallId: tm.toolCallId },
          );
        } else {
          adjacentResults.set(tm.toolCallId, tm);
        }
      }
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
          content: typeof tm.result === 'string' ? tm.result : safeStringify(tm.result),
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
  // L4 part B (2026-05-13): caller can override the default tier. The
  // summarizer cron passes 'haiku' for cheaper text-only work.
  const model = opts.model ?? pickModel();
  const client = getClient();
  const tools = toAnthropicTools(opts.tools);

  let messages = toClaudeMessages(opts.history, opts.newUserMessage);
  const toolCallsExecuted: RunAgentResult['toolCallsExecuted'] = [];
  const assistantMessages: RunAgentResult['assistantMessages'] = [];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCachedInput = 0;
  let lastModelId: string | null = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: MODELS[model],
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildSystemBlocks(opts.systemPrompt),
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    totalCachedInput += response.usage.cache_read_input_tokens ?? 0;
    lastModelId = response.model;

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
      // Done — final answer. Sync variant has no UI to stream into, so
      // we return the truncation marker inlined; streamAgent below emits
      // a synthetic text_delta instead to keep persisted text clean.
      const finalText = response.stop_reason === 'max_tokens'
        ? `${turnText}\n\n_(Response hit the output token limit. Ask a follow-up to continue.)_`
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
          modelId: lastModelId,
          costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
        },
      };
    }

    // Codex adversarial review 2026-05-13 (A-C9): refuse fan-outs larger
    // than MAX_TOOLS_PER_ITERATION. Synthesize tool_result rows for each
    // call so the conversation history stays valid for replay.
    if (calls.length > MAX_TOOLS_PER_ITERATION) {
      const refusal = `Refused: ${calls.length} tool calls in one turn exceeds the limit of ${MAX_TOOLS_PER_ITERATION}. Try one action at a time.`;
      const synthBlocks: ClaudeContent[] = calls.map(call => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: refusal,
        is_error: true,
      }));
      messages = [...messages, { role: 'user', content: synthBlocks }];
      return {
        text: refusal,
        toolCallsExecuted,
        assistantMessages,
        usage: {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cachedInputTokens: totalCachedInput,
          model,
          modelId: lastModelId,
          costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
        },
      };
    }

    // Execute each tool call and append the results as a single user turn.
    // Codex adversarial review 2026-05-13 (A-C2): wrap each tool_result in
    // <tool-result trust="untrusted"> tags so PROMPT_BASE's hard rule
    // ("data, never instructions") engages. dryRun (A-H11) skips real
    // execution and returns a synthetic success — eval-safe.
    const toolResultBlocks: ClaudeContent[] = [];
    for (const call of calls) {
      // Codex post-merge review 2026-05-13 (F2): dryRun is now threaded
      // through ToolContext so mutation tools can run their pre-write
      // validation (findRoomByNumber, role check) and return synthetic
      // success at the would-have-mutated boundary. Previously the
      // synthetic success was generated HERE at the llm layer, which
      // bypassed every lookup — eval cases like mark_room_clean('99999')
      // got fake success instead of the "not found" branch.
      const result = await executeTool(call.name, call.args, {
        ...opts.toolContext,
        dryRun: opts.dryRun,
      });
      const isError = !result.ok;
      toolCallsExecuted.push({ call, result: result.data ?? result.error, isError });
      const rawContent = result.ok
        ? typeof result.data === 'string'
          ? result.data
          : safeStringify(result.data ?? null)
        : (result.error ?? 'Tool failed without a message');
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        // Truncate first (R3), escape <>& second (R6 R4 — unforgeable
        // boundary), wrap in trust marker third (A-C2 — anti-jailbreak).
        content: `<tool-result trust="untrusted" name="${call.name}">${escapeTrustMarkerContent(truncateToolResultContent(rawContent))}</tool-result>`,
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
      modelId: lastModelId,
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
  // Error events carry `usage` whenever the stream consumed any tokens
  // before the error fired (iteration-cap exit, mid-stream exception).
  // The route finalizes the cost reservation against this usage rather
  // than cancelling — runaway tool loops legitimately spend tokens at
  // Anthropic and must be billed. Codex A-C7 (cbc4228) + round-5 R1.
  | { type: 'error'; message: string; usage?: UsageReport };

/**
 * Streaming version of runAgent. Yields events the SSE endpoint can pipe to
 * the client. The shape is intentionally narrow — we only forward what the
 * UI needs to render (text deltas, tool call status, final done).
 */
export async function* streamAgent(opts: RunAgentOpts): AsyncGenerator<AgentEvent> {
  const model = opts.model ?? pickModel();
  const client = getClient();
  const tools = toAnthropicTools(opts.tools);

  let messages = toClaudeMessages(opts.history, opts.newUserMessage);
  let totalInput = 0;
  let totalOutput = 0;
  let totalCachedInput = 0;
  let finalText = '';
  let lastModelId: string | null = null;

  // Mid-iter spend accounting (Codex round-6 R5 + round-7 F3, 2026-05-13).
  // streamAgent only commits an iter's usage AFTER stream.finalMessage()
  // returns. If the SDK throws between emitting any content and resolving
  // finalMessage (rare but observed under transient API errors), Anthropic
  // has billed for input + partial output but our totals never absorbed it.
  // The catch block previously yielded `usage: undefined` whenever no
  // PRIOR iter completed, so the route cancel()-ed the reservation and
  // we silently lost the billed spend.
  //
  // Round-6 R5 closed this for text_delta streams. Round-7 F3 extends to
  // tool_use-only streams: when the model emits a tool_use block (with
  // input_json_delta bytes) but no text and the stream errors before
  // finalMessage, we still owe Anthropic for input + partial output.
  // We now track any content (text OR tool_use) as billing evidence.
  let inflightIterStarted = false;
  let inflightHasContent = false;
  let inflightOutputBytes = 0;

  // Helpers for the abort signal + usage report. Codex adversarial review
  // 2026-05-13 (A-C3, A-C7).
  const buildUsage = (): UsageReport => ({
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedInputTokens: totalCachedInput,
    model,
    modelId: lastModelId,
    costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
  });
  const checkAborted = (): boolean => opts.abortSignal?.aborted ?? false;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (checkAborted()) {
        yield { type: 'error', message: 'aborted by client', usage: buildUsage() };
        return;
      }
      inflightIterStarted = true;
      inflightHasContent = false;
      inflightOutputBytes = 0;
      const stream = client.messages.stream({
        model: MODELS[model],
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemBlocks(opts.systemPrompt),
        tools: tools.length > 0 ? tools : undefined,
        messages,
      }, { signal: opts.abortSignal });

      // Buffer the assistant content blocks as we stream so we can replay them
      // on the next iteration if there are tool calls.
      const turnText: string[] = [];
      const calls: AgentToolCall[] = [];

      for await (const event of stream) {
        // Codex round-7 F3: any content_block event is evidence that
        // Anthropic processed the prompt and is generating billable
        // output. text_delta + input_json_delta both produce output
        // tokens; we accumulate their byte length for the catch-path
        // estimate.
        if (event.type === 'content_block_start') {
          inflightHasContent = true;
        }
        if (event.type === 'content_block_delta') {
          inflightHasContent = true;
          if (event.delta.type === 'text_delta') {
            turnText.push(event.delta.text);
            inflightOutputBytes += event.delta.text.length;
            finalText = ''; // reset — final text is reassembled at end of iteration
            yield { type: 'text_delta', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            // tool_use input streamed as partial JSON; accumulate for the
            // mid-stream output-token estimate. Not surfaced to the UI.
            inflightOutputBytes += event.delta.partial_json.length;
          }
        }
      }

      const finalMsg = await stream.finalMessage();
      totalInput += finalMsg.usage.input_tokens;
      totalOutput += finalMsg.usage.output_tokens;
      totalCachedInput += finalMsg.usage.cache_read_input_tokens ?? 0;
      lastModelId = finalMsg.model;
      // Iter usage is now committed to running totals — clear the inflight flag.
      inflightIterStarted = false;
      inflightHasContent = false;

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
        // Final answer reached. If we hit the token cap, emit ONE synthetic
        // text_delta with the truncation marker BEFORE the done event so:
        //   1. The streaming UI shows it live (renders deltas, ignores done).
        //   2. The persisted text stays clean (finalText below excludes it),
        //      so the next turn doesn't replay our own meta-commentary back
        //      to Claude.
        // Codex review fix C1 + D2 (2026-05-13).
        if (finalMsg.stop_reason === 'max_tokens') {
          yield {
            type: 'text_delta',
            delta: '\n\n_(Response hit the output token limit — ask a follow-up to continue.)_',
          };
        }
        yield {
          type: 'done',
          usage: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cachedInputTokens: totalCachedInput,
            model,
            modelId: lastModelId,
            costUsd: estimateCost(model, totalInput, totalOutput, totalCachedInput),
          },
          finalText, // clean — no truncation marker baked in
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
        usage: buildUsage(),
      };

      // Per-iteration cap. Codex adversarial review 2026-05-13 (A-C9).
      // The assistant_turn is already persisted by the route; synthesize
      // matching tool_results so the next replay validates.
      if (calls.length > MAX_TOOLS_PER_ITERATION) {
        const refusal = `Refused: ${calls.length} tool calls in one turn exceeds the limit of ${MAX_TOOLS_PER_ITERATION}. Try one action at a time.`;
        for (const call of calls) {
          yield { type: 'tool_call_started', call };
          yield { type: 'tool_call_finished', call, result: refusal, isError: true };
        }
        yield { type: 'done', usage: buildUsage(), finalText: refusal };
        return;
      }

      // Run the tools and feed results back.
      // Codex adversarial review 2026-05-13:
      //   (A-C2) Wrap tool_result content in trust-untrusted tags so
      //          PROMPT_BASE blocks the model from following any
      //          instructions found in tool output.
      //   (A-C3) Check abort signal between tool calls.
      //   (A-H11) dryRun is now threaded INTO executeTool via the
      //          ToolContext so handlers exercise their validation path
      //          (room lookup, scope check, recipient existence) and
      //          return synthetic success only AFTER validation passes.
      //          Round-8 fix B2 (2026-05-13): the prior pattern
      //          short-circuited at this layer with synthetic success
      //          BEFORE the handler ran, so eval refusal cases gave
      //          false-positive confidence on the exact mutation paths
      //          they exist to protect.
      const toolResultBlocks: ClaudeContent[] = [];
      for (const call of calls) {
        if (checkAborted()) {
          yield { type: 'error', message: 'aborted by client', usage: buildUsage() };
          return;
        }
        yield { type: 'tool_call_started', call };
        const result = await executeTool(call.name, call.args, {
          ...opts.toolContext,
          dryRun: opts.dryRun,
        });
        const isError = !result.ok;
        yield { type: 'tool_call_finished', call, result: result.data ?? result.error, isError };
        const rawContent = result.ok
          ? typeof result.data === 'string'
            ? result.data
            : safeStringify(result.data ?? null)
          : (result.error ?? 'Tool failed without a message');
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          // Truncate first (R3), escape <>& second (R6 R4 — unforgeable
          // boundary), wrap in trust marker third (A-C2 — anti-jailbreak).
          content: `<tool-result trust="untrusted" name="${call.name}">${escapeTrustMarkerContent(truncateToolResultContent(rawContent))}</tool-result>`,
          is_error: isError,
        });
      }
      messages = [...messages, { role: 'user', content: toolResultBlocks }];
    }

    // Iteration cap reached. Include accumulated usage so the route
    // FINALIZES the cost reservation rather than cancelling it — the
    // 8 completed Anthropic calls were really billed and must be
    // recorded. Codex A-C7 (cbc4228) + round-5 fix R1.
    yield {
      type: 'error',
      message: 'Reached maximum tool-call iterations without resolving.',
      usage: buildUsage(),
    };
  } catch (err) {
    // Codex round-6 R5 + round-7 F3: if the in-flight iter received any
    // content (text_delta OR tool_use's input_json_delta) before erroring,
    // Anthropic almost certainly billed us for input + partial output.
    // Estimate them so the route FINALIZES against actual spend instead
    // of cancelling (which would lose the billed cost silently).
    //
    // For pre-output errors (rate limit, bad request, connection refused)
    // no content was streamed → totals stay 0 → reservation gets cancelled
    // as before. ~4 chars per token is the standard rough conversion.
    if (inflightIterStarted && inflightHasContent) {
      const estInputTokens = Math.round(JSON.stringify(messages).length / 4);
      const estOutputTokens = Math.round(inflightOutputBytes / 4);
      totalInput += estInputTokens;
      totalOutput += estOutputTokens;
    }
    // Longevity L8a, 2026-05-13: classify the SDK error so the operator-
    // facing log can break down causes (rate_limit vs auth vs malformed
    // request vs network). Stored as a structured prefix in the error
    // message so Sentry + log search can filter.
    const errorClass = classifyAnthropicError(err);
    const rawMessage = err instanceof Error ? err.message : String(err);
    console.error('[agent/llm] stream error', { errorClass, rawMessage });
    yield {
      type: 'error',
      message: `[${errorClass}] ${rawMessage}`,
      usage: totalInput + totalOutput > 0 ? buildUsage() : undefined,
    };
  }
}
