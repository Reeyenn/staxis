// ─── Deterministic fake model ─────────────────────────────────────────────
// A scripted stand-in for the Anthropic client, implementing exactly the
// `MessagesClient` slice llm.ts calls (`messages.stream`, `messages.create`).
//
// WHY THIS EXISTS
// The eval bank we had before this file could only assert things about the
// MODEL's judgment (did it pick the right tool?), which costs money, needs the
// network, and needs a live hotel. It could not assert anything about OUR
// code — the prompt we assemble, the escaping we apply, the approval gate we
// enforce — because there was no way to hold the model's output fixed.
//
// With a scripted model, "given this exact model output, does our runtime do
// the right thing?" becomes a plain unit test that runs on every commit for
// $0. That is the half of agent quality that can be ratcheted.
//
// WHAT IT RECORDS
// Every request the runtime sends is captured (system prompt text, tool
// catalog, message history, and every tool_result payload). Injection,
// memory-assembly, and staleness cases assert on what the model was SHOWN,
// which is the only place those defenses are observable.
//
// SHAPE FIDELITY (accepted residual risk, documented in the workstream):
// this fake mimics the 2026 SDK's streaming contract — an async-iterable of
// raw events PLUS a `finalMessage()` method. If the SDK's event types change,
// this fake keeps passing while production breaks. The mitigation is the LIVE
// smoke bank (`npm run agent:evals`), which runs the same cases through the
// real API. Do not treat a green hermetic run as proof the SDK still matches.

import type Anthropic from '@anthropic-ai/sdk';
import type { AgentMessageStream, MessagesClient } from '@/lib/agent/llm';

/** One content block the scripted model emits. */
export type ScriptedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id?: string };

/** One model turn. The runtime loops until a turn has no tool_use blocks. */
export interface ScriptedTurn {
  blocks: ScriptedBlock[];
  /** Defaults to 'tool_use' when the turn contains a tool_use block, else 'end_turn'. */
  stopReason?: Anthropic.Messages.Message['stop_reason'];
}

/** One captured request — what the model was actually shown. */
export interface RecordedModelRequest {
  modelId: string;
  /** Every system block concatenated: the full prompt text the model saw. */
  systemText: string;
  /** Tool names offered this request, in the order the catalog was built. */
  toolNames: string[];
  /** Raw message history sent this request. */
  messages: Anthropic.Messages.MessageParam[];
  /** Text of every tool_result block in this request (post-wrapping). */
  toolResultTexts: string[];
}

export interface FakeModel {
  client: MessagesClient;
  /** Requests in the order they were issued. */
  requests: RecordedModelRequest[];
  /** Scripted turns not consumed — a non-empty list means the loop ended early. */
  remaining(): number;
}

/** Capture what a request asked the model for. Shared by the scripted fake and
 * by the recording wrapper below so both produce identical evidence. */
function recordRequestInto(
  requests: RecordedModelRequest[],
  body: Anthropic.Messages.MessageCreateParams | Anthropic.Messages.MessageStreamParams,
): void {
  requests.push({
    modelId: String(body.model),
    systemText: systemTextOf(body.system),
    toolNames: (body.tools ?? []).map((t) => ('name' in t ? String(t.name) : '?')),
    messages: body.messages as Anthropic.Messages.MessageParam[],
    toolResultTexts: toolResultTextsOf(body.messages as Anthropic.Messages.MessageParam[]),
  });
}

/**
 * Wrap a REAL client so the harness still records what the model was shown.
 *
 * Without this, pointing the hermetic runner at a live model would leave
 * `promptsSeenByModel`, `toolNamesOffered` and `toolResultsSeenByModel` empty —
 * and every assertion built on them would PASS by vacuity. That is precisely
 * the shape of failure the eval bank exists to catch, so the recording must not
 * depend on which client is in use.
 */
export function recordingClient(inner: MessagesClient): FakeModel {
  const requests: RecordedModelRequest[] = [];
  return {
    requests,
    remaining: () => 0,
    client: {
      messages: {
        create(body, options) {
          recordRequestInto(requests, body);
          return inner.messages.create(body, options);
        },
        stream(body, options) {
          recordRequestInto(requests, body);
          return inner.messages.stream(body, options);
        },
      },
    },
  };
}

// Fixed usage. Real numbers would make cost assertions non-deterministic, and
// the hermetic bank asserts behaviour, not spend. Non-zero so the runtime's
// billing-evidence branches behave like production.
const FIXED_USAGE: Anthropic.Messages.Usage = {
  input_tokens: 1200,
  output_tokens: 80,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: null,
  service_tier: null,
} as unknown as Anthropic.Messages.Usage;

const FAKE_MODEL_ID = 'fake-scripted-model-1';

function systemTextOf(system: Anthropic.Messages.MessageCreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => ('text' in b ? b.text : '')).join('\n');
}

function toolResultTextsOf(messages: Anthropic.Messages.MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type !== 'tool_result') continue;
      const c = block.content;
      if (typeof c === 'string') out.push(c);
      else if (Array.isArray(c)) {
        for (const inner of c) if (inner.type === 'text') out.push(inner.text);
      }
    }
  }
  return out;
}

function buildFinalMessage(turn: ScriptedTurn, index: number): Anthropic.Messages.Message {
  const content: Anthropic.Messages.ContentBlock[] = turn.blocks.map((b, i) => {
    if (b.type === 'text') {
      return { type: 'text', text: b.text, citations: null } as Anthropic.Messages.ContentBlock;
    }
    return {
      type: 'tool_use',
      id: b.id ?? `toolu_fake_${index}_${i}`,
      name: b.name,
      input: b.input,
    } as Anthropic.Messages.ContentBlock;
  });
  const hasToolUse = turn.blocks.some((b) => b.type === 'tool_use');
  return {
    id: `msg_fake_${index}`,
    type: 'message',
    role: 'assistant',
    model: FAKE_MODEL_ID,
    content,
    stop_reason: turn.stopReason ?? (hasToolUse ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: FIXED_USAGE,
  } as Anthropic.Messages.Message;
}

/** Raw stream events for one scripted turn, in SDK order. */
function* streamEvents(
  msg: Anthropic.Messages.Message,
): Generator<Anthropic.Messages.RawMessageStreamEvent> {
  yield {
    type: 'message_start',
    message: { ...msg, content: [], stop_reason: null },
  } as Anthropic.Messages.RawMessageStreamEvent;

  for (let idx = 0; idx < msg.content.length; idx++) {
    const block = msg.content[idx];
    if (block.type === 'text') {
      yield {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '', citations: null },
      } as Anthropic.Messages.RawMessageStreamEvent;
      yield {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'text_delta', text: block.text },
      } as Anthropic.Messages.RawMessageStreamEvent;
      yield { type: 'content_block_stop', index: idx } as Anthropic.Messages.RawMessageStreamEvent;
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      } as Anthropic.Messages.RawMessageStreamEvent;
      yield {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      } as Anthropic.Messages.RawMessageStreamEvent;
      yield { type: 'content_block_stop', index: idx } as Anthropic.Messages.RawMessageStreamEvent;
    }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: FIXED_USAGE.output_tokens },
  } as Anthropic.Messages.RawMessageStreamEvent;
  yield { type: 'message_stop' } as Anthropic.Messages.RawMessageStreamEvent;
}

/**
 * Build a scripted model client.
 *
 * Under-scripting is a LOUD failure: when the runtime asks for a turn the
 * script does not have, we throw rather than returning a plausible empty
 * answer. A silent empty turn would let an eval "pass" against a model that
 * said nothing, which is the exact class of vacuous green this workstream
 * exists to prevent.
 */
export function createFakeModel(script: ScriptedTurn[]): FakeModel {
  const requests: RecordedModelRequest[] = [];
  let cursor = 0;

  const nextTurn = (): ScriptedTurn => {
    if (cursor >= script.length) {
      throw new Error(
        `[fake-model] runtime requested turn ${cursor + 1} but the script has only ${script.length}. ` +
        'Add the missing ScriptedTurn — an under-scripted case tests nothing.',
      );
    }
    return script[cursor++];
  };

  const record = (
    body: Anthropic.Messages.MessageCreateParams | Anthropic.Messages.MessageStreamParams,
  ): void => recordRequestInto(requests, body);

  const client: MessagesClient = {
    messages: {
      async create(body) {
        record(body);
        return buildFinalMessage(nextTurn(), requests.length - 1);
      },
      stream(body): AgentMessageStream {
        record(body);
        const msg = buildFinalMessage(nextTurn(), requests.length - 1);
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of streamEvents(msg)) yield ev;
          },
          async finalMessage() {
            return msg;
          },
        };
      },
    },
  };

  return { client, requests, remaining: () => script.length - cursor };
}

/** Convenience: a single turn that just answers in text. */
export function scriptText(text: string): ScriptedTurn[] {
  return [{ blocks: [{ type: 'text', text }] }];
}

/** Convenience: call one tool, then answer in text with the result in hand. */
export function scriptToolThenText(
  tool: { name: string; input: Record<string, unknown> },
  finalText: string,
): ScriptedTurn[] {
  return [
    { blocks: [{ type: 'tool_use', name: tool.name, input: tool.input }] },
    { blocks: [{ type: 'text', text: finalText }] },
  ];
}
