// ─── Anthropic tool-loop core ───────────────────────────────────────────────
//
// The iteration machinery every Anthropic tool loop in this app shares:
// token/cost accounting, the trust-marker wrapping of tool results, the
// mid-stream billing estimate, the fan-out cap, and SDK error classification.
//
// WHY THIS FILE EXISTS
// Until 2026-07-25 there were THREE hand-rolled copies of this machinery:
// `runAgent` and `streamAgent` in llm.ts (kept in parity by hand across ~12
// rounds of review), plus `runStaxisAssistant` in src/lib/comms/assistant.ts,
// which never received that hardening and was still feeding RAW tool output
// back to the model. Every trust-marker / billing / abort fix had to be applied
// three times, and the third copy silently missed most of them.
//
// The rule now: a fix to any of the below lands HERE, once. `npm run lint`
// runs scripts/audit-anthropic-tool-loops.mjs, which fails the build if a
// fourth hand-rolled loop appears (see that script's allowlist).
//
// Deliberately dependency-light — no tool registry, no Supabase, no prompt
// assembly — so any caller (including the comms assistant) can import it
// without dragging the whole agent layer in.

import type Anthropic from '@anthropic-ai/sdk';
import { estimateAiCostUsd } from '@/lib/ai/runtime';
import type { AiModelRef } from '@/lib/ai/types';
import type { NormalizedAnthropicUsage } from '@/lib/ai/usage';
import type { LegacyModelTier } from '@/lib/ai/legacy-model-overrides';

// ─── The provider seam ──────────────────────────────────────────────────────

/**
 * The exact slice of the Messages API the loops in this app call — nothing
 * more.
 *
 * Two operations in the whole runtime: `messages.create` (sync path) and
 * `messages.stream` (SSE path). Naming that slice as an interface is what lets
 * an eval hand in a scripted model and still run the REAL loop — real prompt
 * assembly, real tool dispatch, real approval gate — with no API spend and no
 * network (see src/lib/agent/evals/hermetic-runner.ts).
 *
 * It began life in llm.ts as a test seam, deliberately NOT a provider
 * abstraction. It is now both, and the promotion cost nothing: because a real
 * `Anthropic` instance satisfies it structurally, so does anything else that
 * speaks the same two operations. `createOpenAiMessagesClient`
 * (src/lib/ai/openai-messages.ts) is one such thing, which is why running a
 * feature on GPT required no second loop, no second usage ledger, and no
 * second copy of the guards. Pick the client with `getMessagesClient(provider)`
 * from src/lib/ai/messages-client.ts.
 *
 * The request/response TYPES stay Anthropic-shaped on purpose: they are the
 * lingua franca every call site already speaks, and one adapter translating at
 * the edge is cheaper — and far safer — than thirty call sites each learning a
 * second dialect.
 */
export interface AgentMessageStream
  extends AsyncIterable<Anthropic.Messages.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Messages.Message>;
}

export interface MessagesClient {
  messages: {
    create(
      body: Anthropic.Messages.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Messages.Message>;
    stream(
      body: Anthropic.Messages.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): AgentMessageStream;
  };
}

// ─── Loop bounds ────────────────────────────────────────────────────────────

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

/** The refusal a loop feeds back (as every call's tool_result) when one turn
 *  proposes more than MAX_TOOLS_PER_ITERATION tools. Shared so the sync and
 *  streaming paths cannot drift into two different refusal texts. */
export function tooManyToolCallsRefusal(callCount: number): string {
  return `Refused: ${callCount} tool calls in one turn exceeds the limit of ${MAX_TOOLS_PER_ITERATION}. Try one action at a time.`;
}

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

export function truncateToolResultContent(
  content: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
  if (content.length <= maxChars) return content;
  return (
    content.slice(0, maxChars) +
    `\n…[truncated for context; original ${content.length} chars]`
  );
}

// ─── Serialization ──────────────────────────────────────────────────────────

// Defensive JSON serialization for tool results. Two failure modes
// JSON.stringify throws on synchronously:
//   1. BigInt values (no built-in conversion — replacer converts to string)
//   2. Circular references (no replacer can fix — catch and emit a marker)
//
// Without this guard a tool returning either kind would crash the iteration
// loop and the route would see an error event instead of a tool_result row,
// orphaning the assistant's tool_use on next replay. Defense-in-depth
// backlog cleanup, 2026-05-13.
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) =>
      typeof val === 'bigint' ? val.toString() : val,
    );
  } catch (err) {
    return `[tool result serialization failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

// ─── Trust markers ──────────────────────────────────────────────────────────

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

/**
 * Wrap a tool result in the untrusted trust-marker, applying the canonical
 * pipeline: truncate (R3) → escape <>& (R4/R6, unforgeable boundary) → wrap
 * (A-C2, anti-jailbreak). The `name` attribute is escaped too so a tool name
 * can never carry a forged attribute/tag.
 *
 * SINGLE SOURCE OF TRUTH for tool-result wrapping. Used by the live tool loop,
 * the history replay (toClaudeMessages), AND the comms @Staxis assistant — the
 * replay path previously emitted persisted results RAW, so a malicious document
 * surfaced by a tool on turn N could inject instructions when that result was
 * replayed on turn N+1. Wrapping on replay closes that (knowledge-doc-reading
 * security pass).
 *
 * `maxChars` exists for ONE caller: the comms assistant already slices its
 * knowledge payloads at 12K before it gets here, and shrinking that to the
 * agent's 6K would quietly halve how much of an SOP the model can read. Lowering
 * it there is a product decision, not a refactor. Everything else takes the
 * default and must keep taking it — the cost reservation in cost-controls.ts is
 * sized against MAX_TOOL_RESULT_CHARS.
 */
export function wrapToolResultForModel(
  toolName: string,
  rawContent: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
  const safeName = escapeTrustMarkerContent(toolName).replace(/"/g, '&quot;');
  return `<tool-result trust="untrusted" name="${safeName}">${escapeTrustMarkerContent(truncateToolResultContent(rawContent, maxChars))}</tool-result>`;
}

// ─── Model tier telemetry ───────────────────────────────────────────────────

export type ModelTier = LegacyModelTier;

/** Preserve the legacy telemetry schema while deriving its tier from the
 * model actually selected by admin routing/fallback. */
export function modelTierForModelId(
  modelId: string | null | undefined,
  fallback: ModelTier,
): ModelTier {
  const normalized = modelId?.toLowerCase() ?? '';
  if (normalized.includes('haiku')) return 'haiku';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('opus')) return 'opus';
  return fallback;
}

// ─── Usage + cost accounting ────────────────────────────────────────────────

export interface UsageReport {
  /** Total input across uncached, cache creation, and cache reads. */
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  /** The internal model tier ('haiku' | 'sonnet' | 'opus'). */
  model: ModelTier;
  /** The exact Anthropic snapshot ID, e.g. 'claude-sonnet-4-6-20260427'.
   *  Null on iteration-cap exit (no completed response to read from).
   *  Codex review fix S5. */
  modelId: string | null;
  costUsd: number;
}

export function estimateModelRefCost(
  ref: AiModelRef,
  usage: NormalizedAnthropicUsage,
): number {
  const pricing = ref.pricing;
  if (!pricing) throw new Error(`Missing pricing for ${ref.provider}/${ref.modelId}`);
  return estimateAiCostUsd(pricing, {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
  });
}

/**
 * Running token + cost totals for one agent turn.
 *
 * Both loops used to carry their own eight `let total…` counters plus a
 * hand-written report builder. They drifted twice (cache-creation split, then
 * the 5m/1h breakdown) before this existed. The reservation in cost-controls.ts
 * is finalized against whatever comes out of `report()`, so an omitted counter
 * here is money the hotel is billed for at Anthropic but that never lands in
 * our own ledger.
 */
export class AgentUsageLedger {
  private inputTokens = 0;
  private uncachedInputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private cacheCreation5mInputTokens = 0;
  private cacheCreation1hInputTokens = 0;
  private costUsd = 0;
  private lastModelId: string | null = null;

  /** `fallbackTier` is the tier reported when the response's model id doesn't
   *  classify (see modelTierForModelId). */
  constructor(private readonly fallbackTier: ModelTier) {}

  /** Absorb one provider response. Priced against the model that ACTUALLY
   *  served it, which is not always the plan's primary after a fallback. */
  commit(
    selected: AiModelRef,
    usage: NormalizedAnthropicUsage,
    responseModelId: string | null,
  ): void {
    this.inputTokens += usage.inputTokens;
    this.uncachedInputTokens += usage.uncachedInputTokens;
    this.outputTokens += usage.outputTokens;
    this.cachedInputTokens += usage.cachedInputTokens;
    this.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    this.cacheCreation5mInputTokens += usage.cacheCreation5mInputTokens;
    this.cacheCreation1hInputTokens += usage.cacheCreation1hInputTokens;
    this.costUsd += estimateModelRefCost(selected, usage);
    this.lastModelId = responseModelId;
  }

  /** `activeModelId` is read at report time, not commit time, because a
   *  fallback can swap the active model mid-turn. */
  report(activeModelId: string | null | undefined): UsageReport {
    return {
      inputTokens: this.inputTokens,
      uncachedInputTokens: this.uncachedInputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      cacheCreation5mInputTokens: this.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: this.cacheCreation1hInputTokens,
      model: modelTierForModelId(activeModelId, this.fallbackTier),
      modelId: this.lastModelId,
      costUsd: this.costUsd,
    };
  }

  /** Anything at all to report — used by the sync path's `finally`, which must
   *  not hand background ledgers an all-zero row. */
  hasSpend(): boolean {
    return this.inputTokens > 0 || this.outputTokens > 0 || this.costUsd > 0;
  }

  /** Tokens specifically. The streaming error path attaches usage only when the
   *  provider really counted tokens, so the route FINALIZES rather than cancels
   *  the reservation. Deliberately narrower than hasSpend(). */
  hasBilledTokens(): boolean {
    return this.inputTokens + this.outputTokens > 0;
  }
}

// ─── Mid-stream billing evidence ────────────────────────────────────────────

/** Conservative partial-stream input estimate that covers the entire
 * provider request, not just conversation messages. */
export function estimateAnthropicRequestInputTokens(input: {
  system: unknown;
  tools?: unknown;
  messages: unknown;
}): number {
  return Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
}

export function hasInflightBillingEvidence(
  hasContent: boolean,
  exactInputTokens: number | null,
): boolean {
  // message_start carries provider-counted input usage before the first content
  // block. A failure in that window can still be billable.
  return hasContent || exactInputTokens !== null;
}

/**
 * Reconstruct what a crashed / abandoned stream already cost.
 *
 * Codex round-6 R5 + round-7 F3: if the in-flight iteration received any
 * content (text_delta OR tool_use's input_json_delta) before erroring, Anthropic
 * almost certainly billed us for input + partial output. Estimating it is what
 * makes the route FINALIZE against actual spend instead of cancelling the
 * reservation (which would lose the billed cost silently).
 *
 * `requestForEstimate` is a THUNK on purpose: it is only evaluated when
 * message_start never arrived, matching the `??` short-circuit the two inline
 * copies of this code relied on. Calling it eagerly would re-run
 * buildSystemBlocks (and its cache-purity assertion) on every stream error.
 *
 * ~4 chars per token is the standard fallback conversion when the provider did
 * not supply exact input usage.
 */
export function estimateInflightUsage(args: {
  inflightUsage: NormalizedAnthropicUsage | null;
  inflightOutputBytes: number;
  requestForEstimate: () => { system: unknown; tools?: unknown; messages: unknown };
}): NormalizedAnthropicUsage {
  const estOutputTokens = Math.round(args.inflightOutputBytes / 4);
  if (args.inflightUsage) {
    return { ...args.inflightUsage, outputTokens: estOutputTokens };
  }
  const estUncachedInputTokens = estimateAnthropicRequestInputTokens(args.requestForEstimate());
  return {
    inputTokens: estUncachedInputTokens,
    uncachedInputTokens: estUncachedInputTokens,
    outputTokens: estOutputTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };
}

// ─── Assistant turn shape ───────────────────────────────────────────────────

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Pull the tool_use blocks out of an assistant turn, in emission order. */
export function collectToolUseCalls(
  content: readonly Anthropic.Messages.ContentBlock[],
): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    calls.push({
      id: block.id,
      name: block.name,
      args: (block.input as Record<string, unknown>) ?? {},
    });
  }
  return calls;
}

// ─── SDK error classification ───────────────────────────────────────────────

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
