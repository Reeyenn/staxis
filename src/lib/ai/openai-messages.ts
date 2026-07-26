// ─── OpenAI chat-completions adapter ────────────────────────────────────────
//
// Translates the Anthropic Messages request/response shape this codebase speaks
// into OpenAI's /v1/chat/completions wire format, and translates the answer
// back. It implements `MessagesClient` (loop-core.ts) — the same narrow SDK
// slice the hermetic eval harness implements — so EVERY caller that already
// speaks Anthropic shapes can run on an OpenAI model without knowing this file
// exists.
//
// WHY AN ADAPTER AND NOT A SECOND LOOP
// Until 2026-07-25 there were three hand-rolled copies of the tool loop; they
// drifted, and the third silently missed most of the hardening. Adding a
// provider must not re-open that. Everything that matters — the iteration cap,
// the fan-out cap, the trust-marker wrapping, the number guard, the
// fake-success guard, the approval gate, the usage ledger — lives ABOVE this
// file and runs identically whichever provider answered. This module is a pure
// shape translator plus one fetch call. It contains no loop and makes no
// policy decision.
//
// TWO DELIBERATE ASYMMETRIES, both documented at their site below:
//   1. `cache_control` markers are DROPPED. OpenAI caches automatically and
//      charges nothing to write a cache entry, so there is nothing to mark.
//   2. No `message_start` event is emitted on the streaming path, because
//      OpenAI reports usage only in the FINAL chunk. See emitStreamEvents.

import type Anthropic from '@anthropic-ai/sdk';
import type { AgentMessageStream, MessagesClient } from '@/lib/agent/loop-core';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

// ─── OpenAI wire shapes (only the fields this adapter reads or writes) ───────

interface OpenAiFunctionCall {
  name?: string;
  arguments?: string;
}

interface OpenAiToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: OpenAiFunctionCall;
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

type OpenAiToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  max_completion_tokens: number;
  tools?: OpenAiTool[];
  tool_choice?: OpenAiToolChoice;
  stream?: boolean;
  stream_options?: { include_usage: true };
}

interface OpenAiUsagePayload {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
}

interface OpenAiCompletionPayload {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: OpenAiToolCall[] | null } | null;
    finish_reason?: unknown;
  }>;
  usage?: OpenAiUsagePayload | null;
}

interface OpenAiStreamChunk {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: OpenAiToolCall[] | null;
    } | null;
    finish_reason?: unknown;
  }>;
  usage?: OpenAiUsagePayload | null;
}

// ─── Request translation (ours → OpenAI) ────────────────────────────────────

/**
 * Flatten Anthropic's system parameter into one OpenAI system message.
 *
 * `cache_control` is dropped rather than translated. That is not a gap: OpenAI
 * caches long prompt prefixes automatically and bills nothing for writing a
 * cache entry, so there is no marker to place and no cache-creation token class
 * to account for. The prompt-cache purity rule in llm.ts
 * (`assertStableBlockIsCacheable`) still runs upstream of this call and is
 * still worth keeping on the OpenAI path — a stable prefix that changes every
 * turn defeats OpenAI's automatic cache exactly as it defeats Anthropic's
 * explicit one.
 */
function toOpenAiSystemText(
  system: Anthropic.Messages.MessageCreateParams['system'],
): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

function toOpenAiTools(
  tools: Anthropic.Messages.MessageCreateParams['tools'],
): OpenAiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: OpenAiTool[] = [];
  for (const tool of tools) {
    // Server-side tool definitions (web_search etc.) have no input_schema and
    // are not part of this app's catalog. Skip rather than emit a broken shape.
    if (!('input_schema' in tool) || !tool.input_schema) continue;
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema as unknown as Record<string, unknown>,
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Translate a forced tool selection.
 *
 * Load-bearing rather than cosmetic: the walkthrough step generator and the
 * admin health probe both pin `tool_choice` to one tool and treat a text reply
 * as a failure. Dropping the field would let the model answer in prose, and the
 * caller would report a broken feature rather than a translation gap.
 */
function toOpenAiToolChoice(
  toolChoice: Anthropic.Messages.MessageCreateParams['tool_choice'],
): OpenAiToolChoice | undefined {
  if (!toolChoice) return undefined;
  switch (toolChoice.type) {
    case 'tool':
      return { type: 'function', function: { name: toolChoice.name } };
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'auto':
    default:
      return 'auto';
  }
}

/** An Anthropic image block becomes an OpenAI image_url part. Base64 sources
 * become data URIs; url sources pass through. */
function toOpenAiImagePart(block: Anthropic.Messages.ImageBlockParam): Record<string, unknown> | null {
  const source = block.source;
  if (!source) return null;
  if (source.type === 'base64') {
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  if (source.type === 'url') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function toolResultText(content: Anthropic.Messages.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Translate the conversation.
 *
 * The one structural difference between the two APIs: Anthropic packs every
 * tool_result of an iteration into a SINGLE user message, while OpenAI wants
 * one `role: "tool"` message per result, each carrying its own tool_call_id,
 * immediately after the assistant turn that requested them. Order is preserved
 * so the pairing stays valid.
 */
export function toOpenAiMessages(
  messages: readonly Anthropic.Messages.MessageParam[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content ?? [];
    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAiToolCall[] = [];
      for (const block of blocks) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const assistant: OpenAiMessage = { role: 'assistant' };
      // OpenAI rejects an assistant message with neither content nor
      // tool_calls; an empty string is the accepted "text-free" form.
      assistant.content = textParts.length > 0 ? textParts.join('\n') : '';
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      out.push(assistant);
      continue;
    }

    // User turn. tool_result blocks leave as their own `tool` messages; any
    // text/image blocks in the same turn follow as a normal user message.
    const userParts: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolResultText(block.content),
        });
      } else if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const part = toOpenAiImagePart(block);
        if (part) userParts.push(part);
      } else {
        // REFUSE rather than drop. A `document` (PDF) block silently discarded
        // here would send the model an invoice-reading request containing no
        // invoice, and it would answer confidently from nothing — a blank
        // extraction that looks like a successful one. Throwing instead makes
        // the attempt fail, which lets the configured fallback take over and
        // puts a real error in front of the operator.
        //
        // The registry is the first line of defence (a feature needing
        // `pdf_input` is never offered an OpenAI model at all); this is the
        // second, for a caller that hands a PDF to a feature that only declared
        // `image_input`.
        throw new OpenAiRequestError(
          400,
          `The OpenAI adapter cannot translate a "${block.type}" content block. ` +
          'Use an Anthropic model for this feature, or extend toOpenAiMessages.',
        );
      }
    }
    if (userParts.length > 0) {
      const onlyText = userParts.every((part) => part.type === 'text');
      out.push({
        role: 'user',
        content: onlyText
          ? userParts.map((part) => String(part.text ?? '')).join('\n')
          : userParts,
      });
    }
  }
  return out;
}

/** Either shape the two loop paths hand us: the sync path builds a
 * non-streaming create body, the SSE path a stream body. They differ only in
 * the `stream` flag, which this adapter sets for itself. */
export type AnthropicRequestBody =
  | Anthropic.Messages.MessageCreateParamsNonStreaming
  | Anthropic.Messages.MessageStreamParams;

/** Build the OpenAI request body from an Anthropic-shaped one. */
export function toOpenAiRequest(
  body: AnthropicRequestBody,
  opts: { stream: boolean },
): OpenAiChatRequest {
  const systemText = toOpenAiSystemText(body.system);
  const messages = toOpenAiMessages(body.messages);
  if (systemText.trim().length > 0) {
    messages.unshift({ role: 'system', content: systemText });
  }
  const request: OpenAiChatRequest = {
    model: body.model,
    messages,
    // GPT-5-era models reject the legacy `max_tokens` field outright; the
    // reasoning-aware ceiling is `max_completion_tokens`.
    max_completion_tokens: body.max_tokens,
  };
  const tools = toOpenAiTools(body.tools);
  if (tools) {
    request.tools = tools;
    // Only meaningful alongside a tool list; OpenAI rejects tool_choice without
    // one, which an Anthropic caller is free to send.
    const toolChoice = toOpenAiToolChoice(body.tool_choice);
    if (toolChoice) request.tool_choice = toolChoice;
  }
  if (opts.stream) {
    request.stream = true;
    // Without this OpenAI omits usage from streamed responses entirely and the
    // turn would be billed as zero.
    request.stream_options = { include_usage: true };
  }
  return request;
}

// ─── Response translation (OpenAI → ours) ───────────────────────────────────

function finiteNonnegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Map OpenAI token counts onto the Anthropic usage fields the ledger reads.
 *
 * The two providers disagree about what "input tokens" means, and getting this
 * backwards silently mis-bills every OpenAI turn:
 *   • OpenAI  `prompt_tokens` is the TOTAL input, cached portion included, and
 *     `prompt_tokens_details.cached_tokens` is the part that hit the cache.
 *   • Anthropic `input_tokens` is the UNCACHED remainder, with cache reads
 *     reported separately and summed by normalizeAnthropicUsage.
 * So the cached count is SUBTRACTED here. Skipping that step would price the
 * cached tokens twice — once at the full input rate and once at the cache-read
 * rate — and overstate the hotel's bill.
 *
 * `cache_creation_input_tokens` is 0 and not merely unknown: OpenAI's caching
 * is automatic and free to populate, so there is no write to charge for.
 */
export function toAnthropicUsage(usage: OpenAiUsagePayload | null | undefined): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  const promptTokens = finiteNonnegative(usage?.prompt_tokens);
  const cachedTokens = Math.min(
    finiteNonnegative(usage?.prompt_tokens_details?.cached_tokens),
    promptTokens,
  );
  return {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: finiteNonnegative(usage?.completion_tokens),
    cache_read_input_tokens: cachedTokens,
    cache_creation_input_tokens: 0,
  };
}

export function toAnthropicStopReason(
  finishReason: unknown,
  hasToolCalls: boolean,
): Anthropic.Messages.Message['stop_reason'] {
  if (hasToolCalls || finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A model that streams malformed tool JSON must not crash the turn. An
    // empty argument object reaches the tool handler, which validates its own
    // input and returns a normal tool error the model can react to.
    return {};
  }
}

function toContentBlocks(
  text: string,
  toolCalls: OpenAiToolCall[],
): Anthropic.Messages.ContentBlock[] {
  const blocks: Anthropic.Messages.ContentBlock[] = [];
  if (text.length > 0) {
    blocks.push({ type: 'text', text, citations: null } as Anthropic.Messages.TextBlock);
  }
  for (const call of toolCalls) {
    blocks.push({
      type: 'tool_use',
      id: call.id ?? `call_${blocks.length}`,
      name: call.function?.name ?? 'unknown_tool',
      input: parseToolArguments(call.function?.arguments),
    } as Anthropic.Messages.ToolUseBlock);
  }
  return blocks;
}

function buildAnthropicMessage(args: {
  id: string;
  model: string;
  text: string;
  toolCalls: OpenAiToolCall[];
  finishReason: unknown;
  usage: OpenAiUsagePayload | null | undefined;
}): Anthropic.Messages.Message {
  const content = toContentBlocks(args.text, args.toolCalls);
  return {
    id: args.id,
    type: 'message',
    role: 'assistant',
    model: args.model,
    content,
    stop_reason: toAnthropicStopReason(args.finishReason, args.toolCalls.length > 0),
    stop_sequence: null,
    usage: toAnthropicUsage(args.usage),
  } as unknown as Anthropic.Messages.Message;
}

/** Assemble a non-streamed OpenAI completion into an Anthropic Message. */
export function fromOpenAiCompletion(
  payload: OpenAiCompletionPayload,
  requestedModel: string,
): Anthropic.Messages.Message {
  const choice = payload.choices?.[0];
  const rawContent = choice?.message?.content;
  return buildAnthropicMessage({
    id: typeof payload.id === 'string' ? payload.id : 'openai-message',
    model: typeof payload.model === 'string' ? payload.model : requestedModel,
    text: typeof rawContent === 'string' ? rawContent : '',
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    usage: payload.usage,
  });
}

// ─── Streaming translation ──────────────────────────────────────────────────

/** Accumulates streamed tool-call fragments, which OpenAI splits across chunks
 * and identifies only by array index. */
interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argumentChunks: string[];
}

/**
 * Turn a stream of OpenAI chunks into the Anthropic event sequence the loops
 * consume, accumulating the final message as it goes.
 *
 * NO `message_start` IS EMITTED, and that is a billing decision rather than an
 * omission. `streamAgent` treats a `message_start` as provider-counted proof of
 * input usage and, if the stream later dies mid-flight, commits exactly the
 * token counts that event carried. OpenAI does not report usage until its
 * final chunk, so a synthetic `message_start` could only carry zeros — and the
 * crashed turn would be booked at zero cost despite OpenAI having really
 * billed it. Emitting nothing instead leaves `inflightUsage` null, which is the
 * signal `estimateInflightUsage` uses to fall back to a conservative
 * request-size estimate. Under-reporting spend is the failure this avoids.
 */
export async function* emitStreamEvents(
  chunks: AsyncIterable<OpenAiStreamChunk>,
  requestedModel: string,
  onFinal: (message: Anthropic.Messages.Message) => void,
): AsyncGenerator<Anthropic.Messages.RawMessageStreamEvent> {
  let messageId = 'openai-message';
  let responseModel = requestedModel;
  let finishReason: unknown = null;
  let usage: OpenAiUsagePayload | null | undefined = null;
  const textParts: string[] = [];
  const toolAccumulators = new Map<number, ToolCallAccumulator>();

  // Anthropic addresses content blocks by position. Text, when present, is
  // always block 0; each tool call takes the next index in arrival order.
  let textBlockOpen = false;
  let nextBlockIndex = 0;
  const blockIndexByToolIndex = new Map<number, number>();

  for await (const chunk of chunks) {
    if (typeof chunk.id === 'string' && chunk.id.length > 0) messageId = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model.length > 0) responseModel = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!textBlockOpen) {
        textBlockOpen = true;
        nextBlockIndex = 1;
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        } as Anthropic.Messages.RawMessageStreamEvent;
      }
      textParts.push(delta.content);
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta.content },
      } as Anthropic.Messages.RawMessageStreamEvent;
    }

    for (const call of delta.tool_calls ?? []) {
      const toolIndex = typeof call.index === 'number' ? call.index : 0;
      let accumulator = toolAccumulators.get(toolIndex);
      if (!accumulator) {
        accumulator = {
          index: toolIndex,
          id: call.id ?? `call_${toolIndex}`,
          name: call.function?.name ?? '',
          argumentChunks: [],
        };
        toolAccumulators.set(toolIndex, accumulator);
        const blockIndex = Math.max(nextBlockIndex, textBlockOpen ? 1 : 0);
        nextBlockIndex = blockIndex + 1;
        blockIndexByToolIndex.set(toolIndex, blockIndex);
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: accumulator.id,
            name: accumulator.name,
            input: {},
          },
        } as Anthropic.Messages.RawMessageStreamEvent;
      }
      if (call.id) accumulator.id = call.id;
      if (call.function?.name) accumulator.name = call.function.name;
      const argumentDelta = call.function?.arguments;
      if (typeof argumentDelta === 'string' && argumentDelta.length > 0) {
        accumulator.argumentChunks.push(argumentDelta);
        yield {
          type: 'content_block_delta',
          index: blockIndexByToolIndex.get(toolIndex) ?? 0,
          delta: { type: 'input_json_delta', partial_json: argumentDelta },
        } as Anthropic.Messages.RawMessageStreamEvent;
      }
    }
  }

  for (const index of [...blockIndexByToolIndex.values()].sort((a, b) => a - b)) {
    yield { type: 'content_block_stop', index } as Anthropic.Messages.RawMessageStreamEvent;
  }
  if (textBlockOpen) {
    yield { type: 'content_block_stop', index: 0 } as Anthropic.Messages.RawMessageStreamEvent;
  }

  const toolCalls: OpenAiToolCall[] = [...toolAccumulators.values()]
    .sort((a, b) => a.index - b.index)
    .map((accumulator) => ({
      id: accumulator.id,
      type: 'function',
      function: {
        name: accumulator.name,
        arguments: accumulator.argumentChunks.join(''),
      },
    }));

  const finalMessage = buildAnthropicMessage({
    id: messageId,
    model: responseModel,
    text: textParts.join(''),
    toolCalls,
    finishReason,
    usage,
  });
  onFinal(finalMessage);

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: finalMessage.stop_reason,
      stop_sequence: null,
    },
    usage: { output_tokens: finalMessage.usage.output_tokens },
  } as Anthropic.Messages.RawMessageStreamEvent;
  yield { type: 'message_stop' } as Anthropic.Messages.RawMessageStreamEvent;
}

// ─── HTTP plumbing ──────────────────────────────────────────────────────────

/** Shaped so `classifyAnthropicError` in loop-core reads it correctly — it
 * switches on `status`, so an OpenAI 429 lands in the same `rate_limit` bucket
 * and an OpenAI 401 in the same `auth` bucket as their Anthropic equivalents,
 * and every downstream retry/alerting rule keeps working unchanged. */
export class OpenAiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAiRequestError';
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string') return parsed.error.message;
    } catch {
      /* fall through to the raw body */
    }
    return text.slice(0, 500);
  } catch {
    return response.statusText;
  }
}

/** Parse an SSE byte stream into OpenAI chunk objects. */
async function* parseSseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAiStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload) as OpenAiStreamChunk;
        } catch {
          // A truncated or non-JSON keepalive frame is not fatal; the next
          // frame carries the real content.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface OpenAiMessagesClientOptions {
  apiKey: string;
  timeoutMs: number;
  /** Transient-failure retries, matching what the Anthropic SDK does for the
   * Claude path so a single 429 or 5xx blip does not fail a turn on one
   * provider and survive on the other. */
  maxRetries?: number;
  /** Injected by tests so the translation can be exercised without network. */
  fetchImpl?: typeof fetch;
}

/** A blip worth one more try: rate limits, capacity, and transient 5xx. A 400
 * (our request is wrong) or a 401 (the key is wrong) will fail identically on a
 * retry, so those surface immediately. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * An OpenAI-backed `MessagesClient`.
 *
 * Structurally identical to a real `Anthropic` instance from the loops' point
 * of view, which is the whole point: `runAgent`, `streamAgent`, and the comms
 * assistant are handed one of these instead of the Anthropic client and need no
 * branch of their own.
 */
export function createOpenAiMessagesClient(
  opts: OpenAiMessagesClientOptions,
): MessagesClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = Math.max(0, opts.maxRetries ?? 0);

  const attempt = async (
    body: OpenAiChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    // The timeout is PER ATTEMPT, matching the Anthropic SDK's semantics, so
    // the worst-case budget for both providers is (maxRetries + 1) × timeout.
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await doFetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new OpenAiRequestError(response.status, await readErrorMessage(response));
    }
    return response;
  };

  const post = async (
    body: OpenAiChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    let lastError: unknown;
    for (let tries = 0; tries <= maxRetries; tries++) {
      try {
        return await attempt(body, signal);
      } catch (error) {
        lastError = error;
        // A caller cancellation or a blown deadline must stop spend now, not
        // buy another request. Only transient server-side conditions retry.
        if (signal?.aborted) throw error;
        const retryable = error instanceof OpenAiRequestError
          ? isRetryableStatus(error.status)
          : error instanceof Error && error.name !== 'AbortError' && error.name !== 'TimeoutError';
        if (!retryable || tries === maxRetries) throw error;
      }
    }
    throw lastError;
  };

  return {
    messages: {
      async create(body, options) {
        const response = await post(toOpenAiRequest(body, { stream: false }), options?.signal);
        const payload = await response.json() as OpenAiCompletionPayload;
        return fromOpenAiCompletion(payload, body.model);
      },

      stream(body, options): AgentMessageStream {
        let finalMessage: Anthropic.Messages.Message | null = null;
        let failure: unknown = null;

        const events = (async function* () {
          const response = await post(toOpenAiRequest(body, { stream: true }), options?.signal);
          if (!response.body) {
            throw new OpenAiRequestError(502, 'OpenAI returned a streaming response with no body');
          }
          yield* emitStreamEvents(
            parseSseChunks(response.body),
            body.model,
            (message) => { finalMessage = message; },
          );
        })();

        // One shared iterator so `finalMessage()` can finish a stream the
        // caller only partially consumed, without starting a second request.
        const iterator = events[Symbol.asyncIterator]();

        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                try {
                  return await iterator.next();
                } catch (error) {
                  failure = error;
                  throw error;
                }
              },
              async return(value?: unknown) {
                if (typeof iterator.return === 'function') {
                  return iterator.return(value as never);
                }
                return { done: true as const, value: undefined as never };
              },
            };
          },
          async finalMessage(): Promise<Anthropic.Messages.Message> {
            if (failure) throw failure;
            while (!finalMessage) {
              const { done } = await iterator.next();
              if (done) break;
            }
            if (!finalMessage) {
              throw new OpenAiRequestError(502, 'OpenAI stream ended before a complete message');
            }
            return finalMessage;
          },
        };
      },
    },
  };
}
