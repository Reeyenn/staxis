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

// Type-only: since the provider seam moved to ./loop-core and the client
// factory to @/lib/ai/messages-client, this module no longer constructs an
// Anthropic client — it only speaks the request/response SHAPES, which both
// providers' clients accept.
import type Anthropic from '@anthropic-ai/sdk';
import {
  executeTool,
  toAnthropicTools,
  isMutationTool,
  approvalTierFor,
  confirmsInChat,
  type ToolContext,
  type ToolDefinition,
} from './tools';
import { captureException } from '@/lib/sentry';
import {
  detectUnbackedCompletionClaim,
  fakeSuccessCorrection,
  type FakeSuccessLanguage,
  type FakeSuccessRule,
  type UnbackedClaim,
} from '@/lib/agent/fake-success-guard';
import {
  buildAnswerReceipt,
  checkAnswerNumbers,
  detectAnswerLanguage,
  numberGuardCorrection,
  violationTokens,
  type NumberGuardLanguage,
  type NumberViolation,
} from '@/lib/agent/number-guard';
import { env } from '@/lib/env';
import { getMessagesClient, MESSAGES_RUNTIME_PROVIDERS } from '@/lib/ai/messages-client';
import type { AiFeatureKey, AiModelRef } from '@/lib/ai/types';
import { ANTHROPIC_TIER_PRICING } from '@/lib/ai/feature-registry';
import {
  AiExecutionDeadlineError,
  createAiAttemptContext,
  estimateAiCostUsd,
  executeAiPlan,
  resolveAiExecutionPlan,
  shouldRetryAiFallback,
  type AiExecutionPlan,
} from '@/lib/ai/runtime';
import {
  normalizeAnthropicUsage,
  type NormalizedAnthropicUsage,
} from '@/lib/ai/usage';
import {
  applyLegacyModelOverrideToPlan,
  EFFECTIVE_LEGACY_MODELS,
} from '@/lib/ai/legacy-model-overrides';
// The shared iteration core. Everything both loops below need in common —
// usage accounting, trust-marker wrapping, the mid-stream billing estimate,
// the fan-out cap, SDK error classification — lives there so a fix lands ONCE.
// See src/lib/agent/loop-core.ts and scripts/audit-anthropic-tool-loops.mjs.
import {
  AgentUsageLedger,
  classifyAnthropicError,
  collectToolUseCalls,
  estimateInflightUsage,
  hasInflightBillingEvidence,
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOLS_PER_ITERATION,
  safeStringify,
  tooManyToolCallsRefusal,
  wrapToolResultForModel,
  type AgentToolCall,
  type MessagesClient,
  type ModelTier,
  type UsageReport,
} from './loop-core';

// Re-exported so the ~20 existing importers of '@/lib/agent/llm' keep working
// and there is still exactly one import path for the agent surface.
export {
  classifyAnthropicError,
  escapeTrustMarkerContent,
  estimateAnthropicRequestInputTokens,
  hasInflightBillingEvidence,
  modelTierForModelId,
  wrapToolResultForModel,
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOLS_PER_ITERATION,
} from './loop-core';
export type {
  AgentMessageStream,
  AgentToolCall,
  AnthropicErrorClass,
  MessagesClient,
  ModelTier,
  UsageReport,
} from './loop-core';

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
// ModelTier + modelTierForModelId now live in ./loop-core (shared with every
// other Anthropic loop) and are re-exported above.

export const MODELS: Record<ModelTier, string> = { ...EFFECTIVE_LEGACY_MODELS };

// NO PRICE TABLE LIVES HERE. Model prices are written down in exactly one
// place — ANTHROPIC_TIER_PRICING in src/lib/ai/feature-registry.ts — and this
// module reads them from there.
//
// Until 2026-07-25 this file carried a second, hand-maintained table that had
// drifted: it priced Opus at $15/$75 per million tokens (the retired Opus 3
// rate) against the registry's correct $5/$25. Nothing was visibly broken only
// because the one price-sensitive consumer — the cost-cap reservation in
// cost-controls.ts — happens to read the Sonnet row, where the two tables
// agreed. If you are about to add `const PRICING = {...}` back to this file:
// don't. Add or correct the rate in feature-registry.ts instead.
// Guard: src/lib/__tests__/ai-model-pricing-single-source.test.ts.

// Per-request timeout. Tool loops can fan out — if the model calls 5 tools
// each with their own DB round-trips, total wall time matters. It is 50s so the
// request fails BEFORE Vercel's maxDuration=60s kills the function, giving the
// route's finally block time to release the cost reservation and synthesize
// tool_result rows for any dangling tool_use. Codex review fix B5, 2026-05-13.
//
// 2026-05-17: the value lives in src/lib/external-service-config.ts so every
// call site shares one ceiling. 2026-07-26: applying it moved to
// getMessagesClient (@/lib/ai/messages-client), which defaults to exactly this
// constant — so both providers' clients inherit the same budget and neither can
// drift past the route ceiling on its own.

/** Route maxDuration is 60s. Start this absolute budget at route entry so
 * provider attempts, fallback, and pre-stream work share one ceiling. */
export const ASK_STAXIS_EXECUTION_BUDGET_MS = 55_000;
export const ASK_STAXIS_FALLBACK_RESERVE_MS = 15_000;
export const AGENT_TOOL_START_RESERVE_MS = 2_000;
export const AGENT_KNOWLEDGE_SEARCH_START_RESERVE_MS = 31_000;

// The loop bounds (MAX_OUTPUT_TOKENS, MAX_TOOL_ITERATIONS,
// MAX_TOOLS_PER_ITERATION, MAX_TOOL_RESULT_CHARS), the defensive serializer,
// the SDK error classifier, and the trust-marker wrap all moved to
// ./loop-core so the streaming loop, the sync loop, and the comms @Staxis
// assistant share one copy. They are re-exported at the top of this file.

// ─── Client ────────────────────────────────────────────────────────────────

// The MessagesClient / AgentMessageStream seam and the per-provider client
// factory now live in ./loop-core and @/lib/ai/messages-client respectively, so
// the comms assistant and the findings servers share one definition and one
// key-handling posture. Both are re-exported above/below for the existing
// importers of '@/lib/agent/llm'.
//
// `getMessagesClient` is called with the provider of the model actually
// SELECTED for an attempt, not once per turn: a configured fallback may live
// with a different provider than the primary, and a turn that fails over from
// Claude to GPT (or back) has to switch clients mid-loop.

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
// UsageReport + estimateModelRefCost live in ./loop-core.

/** Cost of one tier-default call at the registry's verified list price. */
export function estimateCost(
  model: ModelTier,
  uncachedInputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheCreationInputTokens = 0,
  cacheCreation5mInputTokens = 0,
  cacheCreation1hInputTokens = 0,
): number {
  return estimateAiCostUsd(ANTHROPIC_TIER_PRICING[model], {
    uncachedInputTokens,
    outputTokens,
    cacheReadInputTokens: cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
  });
}

/** The model + price the agent bills against when no admin-configured feature
 * plan applies. Exported so the pricing single-source guard can assert the
 * live default path really carries the registry's price, not a local copy. */
export function defaultModelRef(tier: ModelTier): AiModelRef {
  return {
    provider: 'anthropic',
    modelId: MODELS[tier],
    pricing: { ...ANTHROPIC_TIER_PRICING[tier] },
  };
}

async function resolveAgentExecutionPlan(
  opts: Pick<RunAgentOpts, 'executionPlan' | 'featureKey'>,
  tier: ModelTier,
): Promise<AiExecutionPlan | null> {
  if (opts.executionPlan) {
    if (opts.featureKey && opts.executionPlan.config.featureKey !== opts.featureKey) {
      throw new Error(
        `Agent execution plan is for ${opts.executionPlan.config.featureKey}, not ${opts.featureKey}`,
      );
    }
    return applyLegacyModelOverrideToPlan(opts.executionPlan, tier);
  }
  if (!opts.featureKey) return null;
  const resolved = await resolveAiExecutionPlan(
    opts.featureKey,
    MESSAGES_RUNTIME_PROVIDERS,
    { requirePricing: true },
  );
  return applyLegacyModelOverrideToPlan(resolved, tier);
}

export async function resolveAskStaxisExecutionPlan(): Promise<AiExecutionPlan> {
  const resolved = await resolveAiExecutionPlan(
    'agent.ask_staxis',
    MESSAGES_RUNTIME_PROVIDERS,
    { requirePricing: true },
  );
  return applyLegacyModelOverrideToPlan(resolved, 'sonnet');
}

/**
 * Cross-hotel chat's own plan, so the AI Control Center governs which model
 * answers company questions independently of the per-hotel copilot. Same shape,
 * same legacy-override handling — only the registry key differs.
 */
export async function resolvePortfolioChatExecutionPlan(): Promise<AiExecutionPlan> {
  const resolved = await resolveAiExecutionPlan(
    'agent.portfolio_chat',
    MESSAGES_RUNTIME_PROVIDERS,
    { requirePricing: true },
  );
  return applyLegacyModelOverrideToPlan(resolved, 'sonnet');
}

function agentDeadlineAt(opts: RunAgentOpts): number | null {
  if (typeof opts.deadlineAt === 'number' && Number.isFinite(opts.deadlineAt)) {
    return opts.deadlineAt;
  }
  return opts.featureKey === 'agent.ask_staxis'
    ? Date.now() + ASK_STAXIS_EXECUTION_BUDGET_MS
    : null;
}

export type AgentStopReason = 'caller_abort' | 'deadline' | null;

/** Boundary-only stop check. We intentionally do not race an already-started
 * tool/mutation against a timer: returning while it continues could strand its
 * result and invite a duplicate retry. */
export function agentStopReason(
  deadlineAt: number | null,
  abortSignal?: AbortSignal,
  now = Date.now(),
): AgentStopReason {
  if (abortSignal?.aborted) return 'caller_abort';
  if (deadlineAt !== null && now >= deadlineAt) return 'deadline';
  return null;
}

/** Prevent a tool from starting when it cannot reasonably finish inside the
 * shared route budget. Knowledge search gets a larger reserve because its
 * query-embedding request has a 30s provider timeout. This remains a boundary
 * check: an already-started mutation is never raced or abandoned. */
export function agentToolStopReason(
  toolName: string,
  deadlineAt: number | null,
  abortSignal?: AbortSignal,
  now = Date.now(),
): AgentStopReason {
  const reserveMs = toolName === 'search_knowledge'
    ? AGENT_KNOWLEDGE_SEARCH_START_RESERVE_MS
    : AGENT_TOOL_START_RESERVE_MS;
  return agentStopReason(deadlineAt, abortSignal, now + reserveMs);
}

function assertAgentCanContinue(deadlineAt: number | null, abortSignal?: AbortSignal): void {
  const reason = agentStopReason(deadlineAt, abortSignal);
  if (reason === 'caller_abort') {
    const error = new Error('aborted by client');
    error.name = 'AbortError';
    throw error;
  }
  if (reason === 'deadline') throw new AiExecutionDeadlineError();
}

// ─── Public agent interface ────────────────────────────────────────────────

// Conversation history as our agent module sees it. We translate to Claude's
// shape inside the wrapper so callers don't need to know the SDK layout.
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; result: unknown; isError?: boolean };

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
  /**
   * The subset of `stable` that states FACTS about this hotel (its confirmed
   * identity, its company's rulebook, its PMS notes) rather than instructing
   * the model. Never sent to the model — `buildSystemBlocks` ignores it — and
   * read by exactly one consumer: the number-honesty guard, which uses it
   * instead of `stable` so the role prompts' illustrative numbers ("mark 10+
   * rooms", "room 302") do not silently back a fabricated count.
   *
   * OPTIONAL, and the fallback is deliberate: a caller that hand-rolls its
   * blocks (the eval runner, the summarizer) omits it, and the guard falls back
   * to `stable` — more permissive, never louder. See number-guard.ts.
   */
  factual?: string;
}

export interface RunAgentOpts {
  /** System prompt — split into stable (cached) + dynamic (not cached). */
  systemPrompt: SystemPromptBlocks;
  /** Conversation history (the past). */
  history: AgentMessage[];
  /** The user's new turn. `null` when RESUMING after an approval decision —
   *  the history already ends with the tool_result user turn Anthropic needs,
   *  so no new user message is appended. */
  newUserMessage: string | null;
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
  /** Runtime-admin feature route. Omit in evals/tests to retain the explicit
   * tier/model behavior above; production callers pass a stable registry key. */
  featureKey?: AiFeatureKey;
  /** Pre-resolved immutable config snapshot. Production Ask Staxis routes pass
   * this same plan to reservation sizing and execution to prevent activation
   * races. When present, featureKey is never resolved again. */
  executionPlan?: AiExecutionPlan;
  /** Absolute route deadline shared by every model/tool iteration. */
  deadlineAt?: number;
  /** Portion of the remaining deadline protected for configured fallback. */
  fallbackReserveMs?: number;
  /** Optional one-shot output contract checked inside each provider attempt.
   * Throwing makes a malformed/empty primary eligible for configured fallback.
   * Intended for no-tool background calls such as summaries and strict JSON. */
  validateAssistantResponse?: (candidate: {
    text: string;
    stopReason: string | null;
    toolCallCount: number;
  }) => void;
  /** Receives the aggregate billable sync usage exactly once when runAgent
   * exits, including when output validation or both configured attempts fail. */
  onUsage?: (usage: UsageReport) => void;
  /**
   * When true, MUTATION tool calls are NOT executed inline. Instead the loop
   * yields a `tool_call_pending_approval` event per mutation and ENDS the turn
   * (read-only calls in the same turn still execute inline as before). The
   * chat route sets this; evals + the sync runAgent path leave it off so their
   * behaviour is unchanged. The action resumes via a fresh streamAgent call
   * (newUserMessage: null) once the user approves/denies on a card.
   */
  approvalMode?: boolean;
  /**
   * Voice variant of the approval gate. When true, only CARD-tier mutations are
   * HELD (staged as a spoken read-back the user confirms next turn); QUICK-tier
   * mutations still execute INLINE this turn (they're low-stakes logging, and a
   * spoken yes/no on every compliance reading would ruin the walkthrough). A
   * turn with only quick mutations runs to completion and the model speaks its
   * result — the gate does NOT end early in that case.
   *
   * The voice-brain route sets this; chat leaves it off (chat uses
   * `approvalMode`, which holds ALL mutations). The two flags are mutually
   * exclusive in practice; if both were set, `approvalMode` wins (chat semantics
   * are byte-for-byte preserved) because its branch is checked first.
   */
  voiceApprovalMode?: boolean;
  /**
   * Override the model client for THIS call. Production never passes it; the
   * hermetic eval harness passes a scripted fake so the full loop runs with
   * zero API spend and zero network. When absent, the client is chosen from
   * the provider of the model each attempt actually selected — see
   * `getMessagesClient` — and still throws when that provider's key is missing.
   *
   * An override wins for EVERY attempt regardless of provider, which is what
   * keeps a hermetic eval hermetic even when the feature under test is
   * configured to a model the test never intends to reach.
   */
  modelClient?: MessagesClient;
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
  /** Exact provider request bodies for this synchronous turn, including a
   * failed/rejected primary before a successful fallback. Service-only audit
   * callers persist these verbatim; ordinary callers may ignore them. */
  providerRequestAttempts?: ProviderRequestAttempt[];
}

export interface ProviderRequestAttempt {
  ordinal: number;
  provider: AiModelRef['provider'];
  requestedModelId: string;
  request: Anthropic.Messages.MessageCreateParamsNonStreaming;
  outcome: 'pending' | 'failed' | 'rejected' | 'succeeded';
  /** JSON-safe snapshot of the provider's completed 200 response. A response
   * that later fails schema validation is still retained because it was both
   * behaviorally relevant and billable. Network/pre-response failures use
   * null. */
  response: Anthropic.Messages.Message | null;
  responseModelId: string | null;
  /** Canonical billable counters derived from response.usage before output
   * validation. Together with the persisted execution-plan pricing this makes
   * every charged primary/fallback attempt independently reproducible. */
  billableUsage: NormalizedAnthropicUsage | null;
  failureName: string | null;
}

/** Capture the JSON value that crossed the provider boundary, not a live SDK
 * object that a client, callback, or later tool iteration can mutate. The
 * Messages API is JSON-only; this deliberately matches its serialized wire
 * representation (including omission of undefined properties). */
function providerJsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
export function toClaudeMessages(history: AgentMessage[], newUser: string | null): ClaudeMessage[] {
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
    const toolNameById = new Map<string, string>();
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        toolCallIds.push(tc.id);
        toolNameById.set(tc.id, tc.name);
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
        // SECURITY: persisted tool results are stored RAW (the route writes
        // result.data unwrapped). Wrap + escape on replay with the SAME helper
        // the live loop uses, so a malicious document a tool surfaced on an
        // earlier turn can't inject instructions when its result is replayed.
        const raw = typeof tm.result === 'string' ? tm.result : safeStringify(tm.result);
        return {
          type: 'tool_result' as const,
          tool_use_id: id,
          content: wrapToolResultForModel(toolNameById.get(id) ?? 'tool', raw),
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

  // The new user turn always goes at the end — UNLESS we're resuming after an
  // approval decision, where `newUser` is null and the history already ends
  // with the tool_result user turn Anthropic needs to continue the generation.
  if (newUser !== null) {
    out.push({ role: 'user', content: newUser });
  }
  return out;
}

/**
 * Per-turn markers that must never appear in the CACHED block. The hotel
 * snapshot and the memory block both change turn to turn; either one in the
 * stable block re-writes the cached prefix on every request, which multiplies
 * the input-token bill with no visible symptom — the copilot keeps answering
 * correctly, it just costs several times more.
 *
 * Chosen so the base prompt's own PROSE about these markers ("content wrapped
 * in <staxis-memory-block trust=…> is a saved note…") does not trip the guard:
 * only the emitted block carries the section headers and the CLOSING tag.
 */
const DYNAMIC_ONLY_MARKERS = [
  '─── Current hotel snapshot ───',
  '─── What Staxis remembers about this hotel ───',
  '</staxis-memory-block>',
] as const;

/**
 * INV-TIER-5, runtime layer. The disjoint StableTier/DynamicTier unions in
 * prompts.ts catch this at compile time for buildSystemPrompt, but the
 * summarizer and the eval runner hand-roll their own SystemPromptBlocks
 * literals — this covers every producer.
 *
 * Outside production it throws (tests and dev must not be able to ship it).
 * In production it reports and serves anyway: a working-but-expensive chat
 * beats a hard 500 for the hotel, and the Sentry event is the alarm. Same
 * posture as INV-22.
 */
export function assertStableBlockIsCacheable(systemPrompt: SystemPromptBlocks): void {
  const leaked = DYNAMIC_ONLY_MARKERS.filter(m => systemPrompt.stable.includes(m));
  if (leaked.length === 0) return;
  const err = new Error(
    `[llm] per-turn content in the CACHED system block: ${leaked.join(', ')}. `
    + 'This breaks the Anthropic prompt cache on every turn.',
  );
  if (env.NODE_ENV !== 'production') throw err;
  captureException(err, { leakedMarkers: leaked.join(',') });
}

/**
 * Build the system blocks for a request.
 *
 * Two blocks: stable (cache_control: ephemeral) + dynamic (no caching).
 * The stable block (base + role prompt) is identical across turns of a
 * conversation, so Anthropic's prompt cache hits — typically 80%+ of
 * system tokens. The dynamic block (live hotel snapshot) is appended
 * un-cached because it changes every turn. Codex review fix A1.
 *
 * Exported so the tier tests can assert the breakpoint placement directly.
 */
export function buildSystemBlocks(systemPrompt: SystemPromptBlocks): Anthropic.Messages.TextBlockParam[] {
  assertStableBlockIsCacheable(systemPrompt);
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

// ─── Shared tool step (sync + streaming) ───────────────────────────────────
//
// The one place a tool actually runs for either loop, and the one place its
// output becomes a tool_result block. Kept here rather than in ./loop-core
// because it needs the tool REGISTRY, which loop-core deliberately does not
// import (the comms assistant reuses loop-core and must not drag the registry
// in). Both loops call these two functions in the same order:
// execute → note the trace → (stream only: yield the event) → build the block.

/** Execute one proposed call and record it in the turn's trace. dryRun is
 *  threaded through ToolContext so handlers still run their pre-write
 *  validation (Codex F2 / round-8 B2) instead of being short-circuited here. */
async function executeAgentToolCall(
  call: AgentToolCall,
  opts: RunAgentOpts,
  trace: TurnToolTrace,
): Promise<{ result: Awaited<ReturnType<typeof executeTool>>; isError: boolean }> {
  // `opts.tools` is the immutable catalog shown to this model turn. Registry
  // presence is not authority: a hallucinated name, retired alias, replayed
  // history, or capability newly granted after catalog construction must not
  // widen that exact old floor. Fresh execution checks only narrow it further.
  const offered = opts.tools.some((tool) => tool.name === call.name);
  const result: Awaited<ReturnType<typeof executeTool>> = offered
    ? await executeTool(call.name, call.args, {
      ...opts.toolContext,
      dryRun: opts.dryRun,
    })
    : {
      ok: false,
      error: `Tool ${call.name} was not offered for this turn and did not run. Continue only with the tools in the current catalog.`,
    };
  noteToolRan(trace, call.name, result.ok, result.data);
  trace.payloads.push(result.ok ? result.data : result.error);
  return { result, isError: !result.ok };
}

/** Serialize a tool result and wrap it in the canonical trust marker:
 *  truncate (R3) → escape <>& (R4/R6 — unforgeable boundary) → wrap (A-C2 —
 *  anti-jailbreak). Same helper the history replay uses, so a tool result reads
 *  identically whether it was produced this turn or replayed from the DB. */
function toToolResultBlock(
  call: AgentToolCall,
  result: Awaited<ReturnType<typeof executeTool>>,
): ClaudeContent {
  const rawContent = result.ok
    ? typeof result.data === 'string'
      ? result.data
      : safeStringify(result.data ?? null)
    : (result.error ?? 'Tool failed without a message');
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: wrapToolResultForModel(call.name, rawContent),
    is_error: !result.ok,
  };
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
  const clientFor = (selected: AiModelRef): MessagesClient =>
    opts.modelClient ?? getMessagesClient(selected.provider);
  const tools = toAnthropicTools(opts.tools);
  const configured = await resolveAgentExecutionPlan(opts, model);
  // resolveAgentExecutionPlan applies the legacy override only to code defaults;
  // an explicit database version remains authoritative.
  let activeModel = configured?.primary ?? defaultModelRef(model);
  let fallbackModel = configured?.fallback ?? null;
  const deadlineAt = agentDeadlineAt(opts);

  let messages = toClaudeMessages(opts.history, opts.newUserMessage);
  const toolCallsExecuted: RunAgentResult['toolCallsExecuted'] = [];
  const assistantMessages: RunAgentResult['assistantMessages'] = [];
  const providerRequestAttempts: ProviderRequestAttempt[] = [];
  // Same evidence the streaming path collects — see detectFakeSuccess.
  const toolTrace: TurnToolTrace = { anyToolRan: false, mutatingToolRan: false, payloads: [] };

  const ledger = new AgentUsageLedger(model);
  const buildSyncUsage = (): UsageReport => ledger.report(activeModel.modelId);

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    assertAgentCanContinue(deadlineAt, opts.abortSignal);
    const request = async (selected: AiModelRef, signal: AbortSignal | undefined) => {
      const requestBody: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model: selected.modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemBlocks(opts.systemPrompt),
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      };
      const attempt: ProviderRequestAttempt = {
        ordinal: providerRequestAttempts.length,
        provider: selected.provider,
        requestedModelId: selected.modelId,
        request: providerJsonSnapshot(requestBody),
        outcome: 'pending',
        response: null,
        responseModelId: null,
        billableUsage: null,
        failureName: null,
      };
      providerRequestAttempts.push(attempt);
      let receivedResponse = false;
      try {
        const response = await clientFor(selected).messages.create(requestBody, { signal });
        receivedResponse = true;
        attempt.response = providerJsonSnapshot(response);
        attempt.responseModelId = response.model;
        // Account before output validation. A malformed 200 is still billable
        // and may then fall back to another billable model attempt.
        attempt.billableUsage = normalizeAnthropicUsage(response.usage);
        ledger.commit(selected, attempt.billableUsage, response.model);

        if (opts.validateAssistantResponse) {
          const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          opts.validateAssistantResponse({
            text,
            stopReason: response.stop_reason,
            toolCallCount: response.content.filter((block) => block.type === 'tool_use').length,
          });
        }
        attempt.outcome = 'succeeded';
        return response;
      } catch (error) {
        attempt.outcome = receivedResponse ? 'rejected' : 'failed';
        attempt.failureName = error instanceof Error ? error.name : 'UnknownError';
        throw error;
      }
    };
    let response: Awaited<ReturnType<typeof request>>;
    if (configured) {
      const executed = await executeAiPlan(
        { ...configured, primary: activeModel, fallback: fallbackModel },
        (selected, context) => request(selected, context.signal),
        {
          deadlineAt: deadlineAt ?? undefined,
          fallbackReserveMs: opts.fallbackReserveMs ?? ASK_STAXIS_FALLBACK_RESERVE_MS,
          abortSignal: opts.abortSignal,
        },
      );
      response = executed.value;
      activeModel = executed.model;
      if (executed.usedFallback) fallbackModel = null;
    } else {
      const context = createAiAttemptContext('primary', deadlineAt, false, {
        abortSignal: opts.abortSignal,
      });
      response = await request(activeModel, context.signal);
    }

    // Collect text + tool_use blocks from this assistant turn.
    const turnText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const calls = collectToolUseCalls(response.content);
    assistantMessages.push({ content: turnText, toolCalls: calls.length ? calls : undefined });

    // Append the assistant turn to the conversation for the next iteration.
    messages = [...messages, { role: 'assistant', content: response.content }];

    if (response.stop_reason !== 'tool_use' || calls.length === 0) {
      // Done — final answer. Sync variant has no UI to stream into, so
      // we return the truncation marker inlined; streamAgent below emits
      // a synthetic text_delta instead to keep persisted text clean.
      let finalText = response.stop_reason === 'max_tokens'
        ? `${turnText}\n\n_(Response hit the output token limit. Ask a follow-up to continue.)_`
        : turnText;
      // Fake-success guard — same rule as streamAgent. No stream to interleave
      // with here, so the correction is simply appended to the returned text.
      const claim = detectFakeSuccess(opts, finalText, toolTrace);
      if (claim) {
        reportFakeSuccess(claim, opts);
        finalText = `${finalText}${fakeSuccessCorrection(claim.lang)}`;
      }
      // Number-honesty guard. Graded on the text BEFORE either correction is
      // appended, so the guard reads the model's own answer and not our
      // retraction — the two corrections would otherwise grade each other.
      const fabricated = detectNumberFabrication(opts, turnText, toolTrace);
      if (fabricated) {
        reportNumberFabrication(fabricated, opts);
        finalText = `${finalText}${fabricated.correction}`;
      }
      return {
        text: finalText,
        toolCallsExecuted,
        assistantMessages,
        usage: buildSyncUsage(),
        providerRequestAttempts,
      };
    }

    // Codex adversarial review 2026-05-13 (A-C9): refuse fan-outs larger
    // than MAX_TOOLS_PER_ITERATION. Synthesize tool_result rows for each
    // call so the conversation history stays valid for replay.
    if (calls.length > MAX_TOOLS_PER_ITERATION) {
      const refusal = tooManyToolCallsRefusal(calls.length);
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
        usage: buildSyncUsage(),
        providerRequestAttempts,
      };
    }

    // Execute each tool call and append the results as a single user turn.
    // Codex adversarial review 2026-05-13 (A-C2): wrap each tool_result in
    // <tool-result trust="untrusted"> tags so PROMPT_BASE's hard rule
    // ("data, never instructions") engages. dryRun (A-H11) skips real
    // execution and returns a synthetic success — eval-safe.
    const toolResultBlocks: ClaudeContent[] = [];
    for (const call of calls) {
      assertAgentCanContinue(deadlineAt, opts.abortSignal);
      const toolStopped = agentToolStopReason(call.name, deadlineAt, opts.abortSignal);
      if (toolStopped === 'caller_abort') {
        const error = new Error('aborted by client');
        error.name = 'AbortError';
        throw error;
      }
      if (toolStopped === 'deadline') throw new AiExecutionDeadlineError();
      // Codex post-merge review 2026-05-13 (F2): dryRun is threaded through
      // ToolContext (inside executeAgentToolCall) so mutation tools can run
      // their pre-write validation (findRoomByNumber, role check) and return
      // synthetic success at the would-have-mutated boundary. Previously the
      // synthetic success was generated HERE at the llm layer, which
      // bypassed every lookup — eval cases like mark_room_clean('99999')
      // got fake success instead of the "not found" branch.
      const { result, isError } = await executeAgentToolCall(call, opts, toolTrace);
      toolCallsExecuted.push({ call, result: result.data ?? result.error, isError });
      toolResultBlocks.push(toToolResultBlock(call, result));
    }
    messages = [...messages, { role: 'user', content: toolResultBlocks }];
  }

    // Hit the iteration cap — return what we have with a stub error message.
    return {
      text: 'I reached the maximum number of tool calls without resolving. Please rephrase or try a more specific question.',
      toolCallsExecuted,
      assistantMessages,
      usage: buildSyncUsage(),
      providerRequestAttempts,
    };
  } finally {
    // A schema-invalid 200 is still billable. Emit from finally so a failed
    // primary followed by a failed fallback cannot disappear from background
    // ledgers. Callers capture this report and book it only on their error path;
    // successful calls continue using the returned usage, avoiding duplicates.
    const usage = buildSyncUsage();
    if (ledger.hasSpend()) opts.onUsage?.(usage);
  }
}

// ─── Approval-gate held-set computation ────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH for "which of this turn's tool calls must be HELD for
// approval rather than executed inline." Pure + exported so the gate decision is
// unit-testable WITHOUT mocking the whole Anthropic stream.
//
//   • Chat (approvalMode)      → hold EVERY mutation. Byte-for-byte the prior
//                                behaviour; the only mode where any mutation is
//                                held. Quick vs card tier is irrelevant here —
//                                both go to a card.
//   • Voice (voiceApprovalMode) → hold ONLY card-tier mutations. Quick-tier
//                                mutations (remember/forget/log_found_item/
//                                log_reading/log_pm_check) run inline this turn.
//   • Neither                  → hold nothing (evals + sync runAgent path).
//
// `held` and `inline` together partition the mutation calls; read-only calls are
// never held and are handled by the normal read-only path.
export type ApprovalGateMode = 'chat' | 'voice' | 'off';

export function approvalGateMode(opts: {
  approvalMode?: boolean;
  voiceApprovalMode?: boolean;
}): ApprovalGateMode {
  // approvalMode (chat) takes precedence so chat semantics are never altered by
  // a caller that (mistakenly) also set voiceApprovalMode.
  if (opts.approvalMode) return 'chat';
  if (opts.voiceApprovalMode) return 'voice';
  return 'off';
}

/**
 * Partition a turn's proposed tool calls into the mutations that must be HELD
 * for approval and the rest that execute inline, under the given gate mode.
 * Read-only calls are always inline. In 'voice' mode a card-tier mutation is
 * held; a quick-tier (or tier-less, treated as 'card' defensively — matching the
 * gate's own default) mutation... see below.
 *
 * Defaulting rule mirrors the gate: a mutation missing an explicit tier defaults
 * to 'card' (the safe, held choice). In voice that means an untiered mutation is
 * HELD, not silently executed — fail-safe.
 */
export function partitionGatedCalls(
  calls: AgentToolCall[],
  mode: ApprovalGateMode,
): { held: AgentToolCall[]; inline: AgentToolCall[] } {
  if (mode === 'off') return { held: [], inline: calls };
  const held: AgentToolCall[] = [];
  const inline: AgentToolCall[] = [];
  for (const c of calls) {
    if (!isMutationTool(c.name)) {
      inline.push(c); // read-only — never held
      continue;
    }
    // ── confirms in the conversation instead of on a card ──
    // NOT an ungated mutation. These tools are two calls: the first writes
    // nothing and returns a read-back, the second writes only once the route
    // has recorded a message FROM THE HUMAN after that read-back
    // (chat-confirm.ts). Holding them would put a card in the middle of a
    // sentence — and, worse, the card's "Do it" would approve the PROPOSE call,
    // which does nothing, leaving the real write with no gate in front of it at
    // all. The gate is inside the tool; the tool has to run to reach it.
    if (confirmsInChat(c.name)) {
      inline.push(c);
      continue;
    }
    if (mode === 'chat') {
      held.push(c); // chat holds every mutation
      continue;
    }
    // voice: hold only card-tier mutations; quick-tier runs inline.
    const tier = approvalTierFor(c.name) ?? 'card';
    if (tier === 'card') held.push(c);
    else inline.push(c);
  }
  return { held, inline };
}

// ─── Fake-success guard ────────────────────────────────────────────────────

/**
 * Per-turn record of what actually executed, for the fake-success guard.
 *
 * Both flags count only tools that SUCCEEDED, which is the semantic each
 * consumer actually wants:
 *   • `mutatingToolRan` — a mutation that was refused by a gate or failed in
 *     the handler changed nothing, so a "Done" on top of it is still a lie.
 *   • `anyToolRan` — this exists to answer "could this sentence be quoting
 *     data the model just read?". A read that errored handed the model no
 *     data to quote, so it must not soften the guard.
 */
interface TurnToolTrace {
  anyToolRan: boolean;
  mutatingToolRan: boolean;
  /**
   * Every payload a tool handed back this turn, successful or not — the
   * number-honesty guard's half of the evidence.
   *
   * Errors are collected too, because the model is SHOWN the error text and may
   * legitimately quote a number out of it ("room 9999 is not at this hotel").
   * The guard grades what the model could have read, not what we wish it read.
   */
  payloads: unknown[];
}

/**
 * A PROPOSE call from a `confirmInChat` tool succeeded, but changed nothing.
 *
 * Without this the guard would be disarmed by the half of the exchange that
 * exists precisely to write nothing: the model proposes a maintenance schedule,
 * the propose call returns ok, and "Done — I've set that up" would then read as
 * a backed claim on a turn where the hotel's data is untouched. The payload says
 * so itself (`awaitingConfirmation`), which is the same flag the model is told
 * to read as "nothing has happened yet".
 */
export function isAwaitingConfirmation(data: unknown): boolean {
  return !!data
    && typeof data === 'object'
    && !Array.isArray(data)
    && (data as { awaitingConfirmation?: unknown }).awaitingConfirmation === true;
}

function noteToolRan(trace: TurnToolTrace, name: string, ok: boolean, data?: unknown): void {
  if (!ok) return;
  trace.anyToolRan = true;
  if (isMutationTool(name) && !isAwaitingConfirmation(data)) trace.mutatingToolRan = true;
}

/**
 * Decide whether this turn's final text is an unbacked claim of completed work.
 *
 * Returns null (guard OFF) in three cases, each a deliberate precision choice:
 *
 *  1. **A mutating tool ran.** Something really happened; the claim is backed.
 *
 *  2. **No mutating tool was even OFFERED this turn.** Background callers (the
 *     summarizer, JSON-shaped one-shots) get a read-only or empty catalog. The
 *     model there has no user to mislead, and firing would only add noise.
 *
 *  3. **`newUserMessage` is null — a post-approval RESUME turn.** This is the
 *     important one. When a user approves a card, `/api/agent/command/
 *     resolve-action` executes the tool ITSELF and then calls streamAgent with
 *     `newUserMessage: null` so the model can narrate the result. The mutation
 *     genuinely happened, but it happened OUTSIDE this generator, so
 *     `mutatingToolRan` is false and "Done — room 302 is marked clean" would be
 *     flagged as a lie when it is the plain truth. Telling a user nothing
 *     changed when it did is a worse failure than the one this guard exists to
 *     fix, so resume turns are excluded outright.
 *
 * The cost is coverage: a claim made on a resume turn about a SECOND action
 * that was never approved is not caught. That is the accepted trade — the
 * approval card already shows the user exactly what they authorised.
 */
function detectFakeSuccess(
  opts: RunAgentOpts,
  finalText: string,
  trace: TurnToolTrace,
): UnbackedClaim | null {
  if (trace.mutatingToolRan) return null;
  if (opts.newUserMessage === null) return null;
  if (!opts.tools.some(t => t.mutates === true)) return null;
  return detectUnbackedCompletionClaim(finalText, { anyToolRan: trace.anyToolRan });
}

/**
 * Make the incident countable. Sentry is the counter — same posture as INV-22
 * and `assertStableBlockIsCacheable`: the agent layer has no synchronous DB
 * handle here, and a guard whose firing leaves no trace is indistinguishable
 * from a guard that never fires.
 *
 * The matched sentence is included because the recurring phrasings are what
 * tell us whether the model is being talked out of the tool layer by a prompt
 * injection or is simply hallucinating success.
 */
// ─── Number-honesty guard ──────────────────────────────────────────────────

/** A fabrication found in the final answer, with the correction to append. */
interface NumberFabrication {
  violations: NumberViolation[];
  lang: NumberGuardLanguage;
  correction: string;
}

/**
 * Decide whether this turn's final text prints a number nothing backs.
 *
 * THE GATE — `opts.tools.length === 0` means no guard, and that one condition
 * is doing important work. Every background caller in the codebase (the
 * conversation summarizer, the findings judge, the nightly sweep, the memory
 * consolidator, the two knowledge-intake routes, the brief writer) runs with
 * `tools: []`. Several of them exist precisely to RESTATE earlier assistant
 * text — a summarizer's whole job is to repeat what the assistant said,
 * including its numbers — and this guard treats assistant text as unbacked by
 * construction. Grading them would produce a correction on every summary and
 * nothing else.
 *
 * Choosing the gate this way rather than an opt-in flag is deliberate: a new
 * conversational surface gets the guard automatically the moment it mounts a
 * tool catalog, which is the direction the mistake should fall. It is the same
 * shape as the fake-success guard's "no mutating tool offered" gate.
 */
function detectNumberFabrication(
  opts: RunAgentOpts,
  finalText: string,
  trace: TurnToolTrace,
): NumberFabrication | null {
  if (opts.tools.length === 0) return null;
  if (!finalText) return null;

  const receipt = buildAnswerReceipt({
    systemPrompt: opts.systemPrompt,
    history: opts.history,
    newUserMessage: opts.newUserMessage,
    toolPayloads: trace.payloads,
  });
  const verdict = checkAnswerNumbers(finalText, receipt);
  if (verdict.ok) return null;

  const lang = detectAnswerLanguage(finalText);
  return {
    violations: verdict.violations,
    lang,
    correction: numberGuardCorrection(lang, verdict.violations),
  };
}

/**
 * Make it countable. Same posture as `reportFakeSuccess`: the agent layer has
 * no synchronous DB handle here, so Sentry is the counter, and the offending
 * TOKENS are carried because the recurring shapes are the whole point — a
 * pattern of unbacked percentages says the model is deriving, a pattern of
 * unbacked dollar figures says it is estimating, and the two want different
 * fixes.
 */
function reportNumberFabrication(found: NumberFabrication, opts: RunAgentOpts): void {
  captureException(
    new Error('[llm] assistant printed a number nothing in the turn backs'),
    {
      subsystem: 'number-honesty-guard',
      lang: found.lang,
      surface: opts.toolContext.surface,
      role: opts.toolContext.user.role,
      kinds: [...new Set(found.violations.map(v => v.kind))].join(','),
      tokens: violationTokens(found.violations).slice(0, 12).join(', '),
      violationCount: String(found.violations.length),
    },
  );
}

function reportFakeSuccess(claim: UnbackedClaim, opts: RunAgentOpts): void {
  captureException(
    new Error(
      `[llm] assistant claimed a completed action with no mutating tool call (${claim.rule})`,
    ),
    {
      subsystem: 'fake-success-guard',
      rule: claim.rule,
      lang: claim.lang,
      surface: opts.toolContext.surface,
      role: opts.toolContext.user.role,
      matched: claim.matched.slice(0, 300),
    },
  );
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
  // Emitted (approvalMode only) when the model proposes a MUTATION tool. The
  // action is NOT executed — the route persists a pending row and streams a
  // card to the browser. `tier` + `summary` drive the card; `turnKey` groups
  // all mutations of this assistant turn so resume waits for all to resolve.
  | { type: 'tool_call_pending_approval'; call: AgentToolCall; tier: 'quick' | 'card'; turnKey: string }
  | { type: 'done'; usage: UsageReport; finalText: string }
  // The assistant claimed a completed action but no mutating tool ran this
  // turn. The correction is ALSO appended to the streamed text and to
  // `done.finalText`, so a consumer that ignores this event still shows the
  // user the retraction; the event exists so the incident is countable.
  // See src/lib/agent/fake-success-guard.ts.
  | { type: 'fake_success_blocked'; rule: FakeSuccessRule; lang: FakeSuccessLanguage; matched: string }
  // The assistant printed a number that nothing in this turn backs. Like the
  // event above, the correction is ALSO streamed and baked into
  // `done.finalText`, so a consumer that ignores this event still shows the
  // user the retraction; the event exists so the miss rate is countable.
  // See src/lib/agent/number-guard.ts.
  | {
      type: 'number_guard_blocked';
      lang: NumberGuardLanguage;
      /** The offending tokens, distinct, in the order they appeared. */
      tokens: string[];
      violations: NumberViolation[];
    }
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
  const clientFor = (selected: AiModelRef): MessagesClient =>
    opts.modelClient ?? getMessagesClient(selected.provider);
  const tools = toAnthropicTools(opts.tools);
  let configured;
  try {
    configured = await resolveAgentExecutionPlan(opts, model);
  } catch (error) {
    yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
    return;
  }
  let activeModel = configured?.primary ?? defaultModelRef(model);
  let fallbackModel = configured?.fallback ?? null;
  let usingFallback = false;
  const deadlineAt = agentDeadlineAt(opts);

  let messages = toClaudeMessages(opts.history, opts.newUserMessage);
  const ledger = new AgentUsageLedger(model);
  let finalText = '';
  // What actually executed this turn — the evidence the fake-success guard
  // grades the final text against.
  const toolTrace: TurnToolTrace = { anyToolRan: false, mutatingToolRan: false, payloads: [] };

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
  // We now track message_start input usage OR any content (text/tool_use) as
  // billing evidence.
  let inflightIterStarted = false;
  let inflightHasContent = false;
  let inflightEmittedToUser = false;
  let inflightOutputBytes = 0;
  let inflightUsage: NormalizedAnthropicUsage | null = null;
  let inflightModelId: string | null = null;

  // Helpers for the abort signal + usage report. Codex adversarial review
  // 2026-05-13 (A-C3, A-C7).
  const buildUsage = (): UsageReport => ledger.report(activeModel.modelId);
  const checkAborted = (): boolean => opts.abortSignal?.aborted ?? false;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const stopped = agentStopReason(deadlineAt, opts.abortSignal);
      if (stopped) {
        yield {
          type: 'error',
          message: stopped === 'caller_abort' ? 'aborted by client' : 'AI execution deadline exhausted',
          usage: buildUsage(),
        };
        return;
      }
      // Buffer the assistant content blocks as we stream so we can replay them
      // on the next iteration if there are tool calls.
      const turnText: string[] = [];
      const calls: AgentToolCall[] = [];
      let finalMsg: Anthropic.Message;

      // A configured fallback is safe only before this iteration emits any
      // content. Once a delta reaches the browser, retrying would duplicate or
      // splice the answer. If the primary fails pre-output, retry this same
      // message history once and keep the fallback for later tool iterations.
      while (true) {
        inflightIterStarted = true;
        inflightHasContent = false;
        inflightEmittedToUser = false;
        inflightOutputBytes = 0;
        inflightUsage = null;
        inflightModelId = null;
        const requestSystem = buildSystemBlocks(opts.systemPrompt);
        const requestTools = tools.length > 0 ? tools : undefined;
        try {
          const attemptContext = createAiAttemptContext(
            usingFallback ? 'fallback' : 'primary',
            deadlineAt,
            fallbackModel !== null,
            {
              fallbackReserveMs: opts.fallbackReserveMs ?? ASK_STAXIS_FALLBACK_RESERVE_MS,
              abortSignal: opts.abortSignal,
            },
          );
          const stream = clientFor(activeModel).messages.stream({
            model: activeModel.modelId,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: requestSystem,
            tools: requestTools,
            messages,
          }, { signal: attemptContext.signal });

          for await (const event of stream) {
            if (event.type === 'message_start') {
              inflightUsage = normalizeAnthropicUsage(event.message.usage);
              inflightModelId = event.message.model;
            }
            // Codex round-7 F3: any content block is evidence of billable output.
            if (event.type === 'content_block_start') inflightHasContent = true;
            if (event.type === 'content_block_delta') {
              inflightHasContent = true;
              if (event.delta.type === 'text_delta') {
                turnText.push(event.delta.text);
                inflightOutputBytes += event.delta.text.length;
                finalText = '';
                if (event.delta.text.length > 0) inflightEmittedToUser = true;
                yield { type: 'text_delta', delta: event.delta.text };
              } else if (event.delta.type === 'input_json_delta') {
                inflightOutputBytes += event.delta.partial_json.length;
              }
            }
          }
          finalMsg = await stream.finalMessage();
          break;
        } catch (error) {
          if (shouldRetryAiFallback({
            fallbackAvailable: fallbackModel !== null,
            aborted: checkAborted(),
            emittedToUser: inflightEmittedToUser,
            error,
          })) {
            // A content_block_start / partial tool JSON is billable even though
            // it was not user-visible. Preserve an estimate before retrying so
            // fallback resilience does not erase primary-model spend.
            if (hasInflightBillingEvidence(inflightHasContent, inflightUsage?.inputTokens ?? null)) {
              ledger.commit(
                activeModel,
                estimateInflightUsage({
                  inflightUsage,
                  inflightOutputBytes,
                  requestForEstimate: () => ({
                    system: requestSystem,
                    tools: requestTools,
                    messages,
                  }),
                }),
                inflightModelId,
              );
            }
            activeModel = fallbackModel!;
            fallbackModel = null;
            usingFallback = true;
            inflightIterStarted = false;
            inflightHasContent = false;
            continue;
          }
          throw error;
        }
      }

      ledger.commit(activeModel, normalizeAnthropicUsage(finalMsg.usage), finalMsg.model);
      // Iter usage is now committed to running totals — clear the inflight flag.
      inflightIterStarted = false;
      inflightHasContent = false;

      calls.push(...collectToolUseCalls(finalMsg.content));
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

        // ── Fake-success guard ────────────────────────────────────────────
        // The text has already streamed to the browser, so we cannot un-say
        // it — and we should not want to. Append an explicit retraction as a
        // real text_delta (the UI renders it live) and, UNLIKE the max_tokens
        // marker above, bake it into `finalText` so it is PERSISTED. That is
        // deliberate: the next turn replays this message to the model, and it
        // must see that its claim was retracted rather than treat "Done" as
        // established fact and build on it.
        // The model's own words, before either guard appends anything. Both
        // guards grade THIS, never each other's retraction.
        const modelText = finalText;

        const claim = detectFakeSuccess(opts, modelText, toolTrace);
        if (claim) {
          reportFakeSuccess(claim, opts);
          const correction = fakeSuccessCorrection(claim.lang);
          yield { type: 'text_delta', delta: correction };
          yield {
            type: 'fake_success_blocked',
            rule: claim.rule,
            lang: claim.lang,
            matched: claim.matched,
          };
          finalText = `${finalText}${correction}`;
        }

        // ── Number-honesty guard ──────────────────────────────────────────
        // Runs POST-STREAM, for the reason written up in number-guard.ts:
        // buffering every answer to check it would trade the product's
        // first-token latency on 100% of turns against a violation rate under
        // 1%. So the figure is already on screen and we do the same thing the
        // guard above does — name it, retract it, persist the retraction so the
        // next turn cannot build on a number that was already withdrawn.
        const fabricated = detectNumberFabrication(opts, modelText, toolTrace);
        if (fabricated) {
          reportNumberFabrication(fabricated, opts);
          yield { type: 'text_delta', delta: fabricated.correction };
          yield {
            type: 'number_guard_blocked',
            lang: fabricated.lang,
            tokens: violationTokens(fabricated.violations),
            violations: fabricated.violations,
          };
          finalText = `${finalText}${fabricated.correction}`;
        }

        yield {
          type: 'done',
          usage: buildUsage(),
          // No truncation marker baked in. The fake-success correction above
          // IS baked in, deliberately — see that block.
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
        usage: buildUsage(),
      };

      // Per-iteration cap. Codex adversarial review 2026-05-13 (A-C9).
      // The assistant_turn is already persisted by the route; synthesize
      // matching tool_results so the next replay validates.
      if (calls.length > MAX_TOOLS_PER_ITERATION) {
        const refusal = tooManyToolCallsRefusal(calls.length);
        for (const call of calls) {
          yield { type: 'tool_call_started', call };
          yield { type: 'tool_call_finished', call, result: refusal, isError: true };
        }
        yield { type: 'done', usage: buildUsage(), finalText: refusal };
        return;
      }

      // ── Approval gate (approvalMode / voiceApprovalMode) ───────────────
      // Some proposed calls must be HELD for approval rather than executed:
      //   • Chat (approvalMode)       → hold EVERY mutation. Unchanged.
      //   • Voice (voiceApprovalMode) → hold only CARD-tier mutations; quick-tier
      //                                 mutations run inline this turn (below).
      // partitionGatedCalls is the single source of truth for that split.
      //
      // If nothing is held, we FALL THROUGH to the normal execution path so the
      // turn runs to completion and emits `done`. Critical for voice: a turn
      // with only quick-tier mutations (e.g. "log the pool reading") must run
      // fully so the model speaks its result — it must NOT end early here.
      //
      // If something IS held, we do NOT run the held calls. We stage a
      // `tool_call_pending_approval` per held call FIRST, then execute every
      // NON-held call in this turn inline (read-only calls AND, in voice,
      // quick-tier mutations), then STOP — the turn ends here (no `done`).
      //
      // Why stop instead of continue: Anthropic requires EVERY tool_use in the
      // assistant message to get a tool_result before the conversation can go
      // on. The held tool_use blocks have no result yet (they await the user's
      // decision), so we can't safely feed the other results back and keep
      // looping. The inline results are persisted (via the route's
      // tool_call_finished handler); resume replays them alongside the held
      // results once every pending action is resolved.
      const gateMode = approvalGateMode(opts);
      if (gateMode !== 'off') {
        const partitioned = partitionGatedCalls(calls, gateMode);
        const offeredNames = new Set(opts.tools.map((tool) => tool.name));
        // An unoffered registered mutation is not an approval proposal. Keep it
        // inline so executeAgentToolCall emits the matching fail-closed result;
        // otherwise registry metadata alone could mint a card outside the old
        // catalog floor.
        const held = partitioned.held.filter((call) => offeredNames.has(call.name));
        const heldIds = new Set(held.map((call) => call.id));
        const inline = calls.filter((call) => !heldIds.has(call.id));
        if (held.length > 0) {
          // Group key for this assistant turn = its first tool_call_id. Stable
          // and unique; the resolve route uses it to know when all siblings
          // are resolved before resuming.
          const turnKey = calls[0].id;

          // Yield the pending-approval proposals FIRST, BEFORE running any
          // inline calls of the same turn (code-review finding: ordering).
          // The route persists a pending row per proposal as it consumes each
          // event. If we ran inline calls first and the client aborted in
          // that window, the held proposals would be silently discarded —
          // no card, no pending row, and the turn would hang until TTL. Staging
          // the durable proposals up front closes that window. Persistence
          // order still holds: the route already recorded the assistant turn
          // (assistant_turn event) before this branch runs, and each
          // tool_call_pending_approval removes its id from pendingToolCallIds so
          // the drain doesn't synthesize an abort result for a held mutation.
          // Tier comes from the tool's registry metadata (server-decided — the
          // client can't downgrade it); default to 'card' for any held mutation
          // missing a tier.
          for (const call of held) {
            const tier = approvalTierFor(call.name) ?? 'card';
            yield { type: 'tool_call_pending_approval', call, tier, turnKey };
          }

          // Non-held calls in the same turn still run inline, AFTER the held
          // proposals are staged. In chat these are all read-only; in voice
          // they may also include quick-tier mutations (which the gate does
          // not hold), so they really do execute and mutate here.
          for (const call of inline) {
            const stopped = agentStopReason(deadlineAt, opts.abortSignal)
              ?? agentToolStopReason(call.name, deadlineAt, opts.abortSignal);
            if (stopped) {
              yield {
                type: 'error',
                message: stopped === 'caller_abort' ? 'aborted by client' : 'AI execution deadline exhausted',
                usage: buildUsage(),
              };
              return;
            }
            yield { type: 'tool_call_started', call };
            const { result, isError } = await executeAgentToolCall(call, opts, toolTrace);
            yield { type: 'tool_call_finished', call, result: result.data ?? result.error, isError };
          }

          // Turn ends here — no `done`. The route holds the stream open only
          // long enough to persist, then closes; the browser shows the card(s)
          // / voice speaks the read-back confirmation.
          return;
        }
        // held.length === 0 → fall through to normal execution (voice quick-only
        // turn runs fully; chat with no mutations runs fully).
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
        const stopped = agentStopReason(deadlineAt, opts.abortSignal)
          ?? agentToolStopReason(call.name, deadlineAt, opts.abortSignal);
        if (stopped) {
          yield {
            type: 'error',
            message: stopped === 'caller_abort' ? 'aborted by client' : 'AI execution deadline exhausted',
            usage: buildUsage(),
          };
          return;
        }
        yield { type: 'tool_call_started', call };
        const { result, isError } = await executeAgentToolCall(call, opts, toolTrace);
        yield { type: 'tool_call_finished', call, result: result.data ?? result.error, isError };
        toolResultBlocks.push(toToolResultBlock(call, result));
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
    // For errors before message_start and before content (rate limit, bad
    // request, connection refused), totals stay 0 and the hold is cancelled.
    // ~4 chars per token is the standard fallback conversion when the provider
    // did not supply exact input usage.
    if (
      inflightIterStarted
      && hasInflightBillingEvidence(inflightHasContent, inflightUsage?.inputTokens ?? null)
    ) {
      ledger.commit(
        activeModel,
        estimateInflightUsage({
          inflightUsage,
          inflightOutputBytes,
          requestForEstimate: () => ({
            system: buildSystemBlocks(opts.systemPrompt),
            tools: tools.length > 0 ? tools : undefined,
            messages,
          }),
        }),
        inflightModelId,
      );
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
      usage: ledger.hasBilledTokens() ? buildUsage() : undefined,
    };
  }
}
