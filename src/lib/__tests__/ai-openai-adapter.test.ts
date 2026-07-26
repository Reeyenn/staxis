// The OpenAI chat adapter: shape translation, streaming, usage/cost honesty.
//
// These exercise the real translator functions rather than asserting on source
// text. The bar for each: it would fail if the translation were wrong in a way
// that silently costs money, drops evidence, or breaks a guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createOpenAiMessagesClient,
  emitStreamEvents,
  fromOpenAiCompletion,
  toAnthropicStopReason,
  toAnthropicUsage,
  toOpenAiMessages,
  toOpenAiRequest,
} from '@/lib/ai/openai-messages';
import { estimateAiCostUsd } from '@/lib/ai/runtime';
import { normalizeAnthropicUsage } from '@/lib/ai/usage';

// ─── Request translation ────────────────────────────────────────────────────

test('system blocks flatten and cache_control markers are dropped', () => {
  const request = toOpenAiRequest({
    model: 'gpt-5.4-mini',
    max_tokens: 100,
    system: [
      { type: 'text', text: 'stable rules', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'live snapshot' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  } as Anthropic.Messages.MessageCreateParamsNonStreaming, { stream: false });

  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, 'stable rules\n\nlive snapshot');
  // OpenAI rejects unknown fields; a leaked cache_control would 400 every call.
  assert.equal(JSON.stringify(request).includes('cache_control'), false);
  // GPT-5-era models reject the legacy max_tokens field outright.
  assert.equal(request.max_completion_tokens, 100);
  assert.equal('max_tokens' in request, false);
});

test('a tool-call round trip keeps ids paired across both wire formats', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: 'is room 12 clean?' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_room', input: { room: '12' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'clean' }],
    },
  ] as Anthropic.Messages.MessageParam[]);

  const assistant = messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls?.[0].id, 'toolu_1');
  assert.equal(assistant.tool_calls?.[0].function?.name, 'get_room');
  assert.equal(assistant.tool_calls?.[0].function?.arguments, '{"room":"12"}');

  // Anthropic packs results into one user turn; OpenAI needs one `tool`
  // message each, carrying the id that pairs it to the call. A mismatch here
  // is a 400 on every tool turn.
  const result = messages[2];
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, 'toolu_1');
  assert.equal(result.content, 'clean');
});

test('several tool results in one turn become several tool messages, in order', () => {
  const messages = toOpenAiMessages([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'first' },
        { type: 'tool_result', tool_use_id: 'b', content: 'second' },
      ],
    },
  ] as Anthropic.Messages.MessageParam[]);

  assert.deepEqual(
    messages.map((m) => [m.role, m.tool_call_id, m.content]),
    [['tool', 'a', 'first'], ['tool', 'b', 'second']],
  );
});

test('a forced tool choice survives translation', () => {
  // The walkthrough generator and the admin probe both treat a prose reply as a
  // failure, so dropping tool_choice would read as a broken model.
  const request = toOpenAiRequest({
    model: 'gpt-5.4',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'go' }],
    tools: [{
      name: 'emit_step',
      description: 'emit',
      input_schema: { type: 'object', properties: {}, required: [] },
    }],
    tool_choice: { type: 'tool', name: 'emit_step' },
  } as Anthropic.Messages.MessageCreateParamsNonStreaming, { stream: false });

  assert.deepEqual(request.tool_choice, { type: 'function', function: { name: 'emit_step' } });
  assert.equal(request.tools?.[0].function.name, 'emit_step');
});

test('an image block becomes a data URI part', () => {
  const messages = toOpenAiMessages([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'count the towels' },
    ],
  }] as Anthropic.Messages.MessageParam[]);

  const parts = messages[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(parts[0], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAAA' },
  });
  assert.deepEqual(parts[1], { type: 'text', text: 'count the towels' });
});

test('an untranslatable block is refused rather than silently dropped', () => {
  // A dropped PDF would send an invoice-reading request containing no invoice,
  // and the model would answer confidently from nothing. Blank extractions that
  // look successful are worse than a failed attempt the fallback can catch.
  assert.throws(
    () => toOpenAiMessages([{
      role: 'user',
      content: [{
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' },
      }],
    }] as Anthropic.Messages.MessageParam[]),
    /cannot translate a "document" content block/,
  );
});

// ─── Usage and cost ─────────────────────────────────────────────────────────

test('cached tokens are subtracted from input rather than double-counted', () => {
  // OpenAI's prompt_tokens INCLUDES the cached portion; Anthropic's
  // input_tokens excludes it. Getting this backwards bills the cached tokens
  // twice — once at the full rate and once at the cache rate.
  const usage = toAnthropicUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 },
  });
  assert.equal(usage.input_tokens, 200);
  assert.equal(usage.cache_read_input_tokens, 800);
  assert.equal(usage.output_tokens, 200);
  // OpenAI charges nothing to populate a cache entry, so there is no write.
  assert.equal(usage.cache_creation_input_tokens, 0);

  // The ledger's own normalizer must reconstruct OpenAI's original total.
  const normalized = normalizeAnthropicUsage(usage);
  assert.equal(normalized.inputTokens, 1000);
  assert.equal(normalized.cachedInputTokens, 800);
});

test('the cost of a cached OpenAI turn is priced at the published cache rate', () => {
  const gpt54mini = {
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 4.5,
    cachedInputUsdPerMillionTokens: 0.075,
    source: 'https://developers.openai.com/api/docs/pricing',
    asOf: '2026-07-26',
  };
  const usage = normalizeAnthropicUsage(toAnthropicUsage({
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    prompt_tokens_details: { cached_tokens: 900_000 },
  }));
  const cost = estimateAiCostUsd(gpt54mini, {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
  });
  // 100k fresh @ $0.75/M + 900k cached @ $0.075/M + 1M out @ $4.50/M
  assert.equal(Math.round(cost * 1e6) / 1e6, 0.075 + 0.0675 + 4.5);
});

test('missing usage counts as zero rather than NaN', () => {
  const usage = toAnthropicUsage(undefined);
  assert.deepEqual(usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('a cached count larger than the prompt total cannot make input negative', () => {
  const usage = toAnthropicUsage({ prompt_tokens: 100, cached_tokens: 0, prompt_tokens_details: { cached_tokens: 500 } } as never);
  assert.equal(usage.input_tokens, 0);
  assert.equal(usage.cache_read_input_tokens, 100);
});

// ─── Response translation ───────────────────────────────────────────────────

test('finish reasons map onto the stop reasons the loops branch on', () => {
  // streamAgent ends the turn unless stop_reason === 'tool_use'; runAgent
  // appends a truncation notice on 'max_tokens'. Both depend on this mapping.
  assert.equal(toAnthropicStopReason('tool_calls', true), 'tool_use');
  assert.equal(toAnthropicStopReason('length', false), 'max_tokens');
  assert.equal(toAnthropicStopReason('stop', false), 'end_turn');
  // A model that emitted tool calls without saying so still needs the loop to
  // run them, or the turn stalls with an unanswered tool_use.
  assert.equal(toAnthropicStopReason('stop', true), 'tool_use');
});

test('a completion with tool calls becomes text + tool_use blocks', () => {
  const message = fromOpenAiCompletion({
    id: 'chatcmpl-1',
    model: 'gpt-5.4-mini-2026-03-17',
    choices: [{
      message: {
        content: 'looking that up',
        tool_calls: [{
          id: 'call_9',
          type: 'function',
          function: { name: 'get_room', arguments: '{"room":"302"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  }, 'gpt-5.4-mini');

  assert.equal(message.stop_reason, 'tool_use');
  // The response model id, not the alias — this is what lands in
  // agent_costs.model_id and lets an operator see which snapshot answered.
  assert.equal(message.model, 'gpt-5.4-mini-2026-03-17');
  assert.deepEqual(message.content[0], { type: 'text', text: 'looking that up', citations: null });
  const toolUse = message.content[1] as Anthropic.Messages.ToolUseBlock;
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.id, 'call_9');
  assert.deepEqual(toolUse.input, { room: '302' });
});

test('malformed tool arguments reach the handler as empty input, not a crash', () => {
  const message = fromOpenAiCompletion({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'get_room', arguments: '{"room":' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }, 'gpt-5.4');
  const toolUse = message.content[0] as Anthropic.Messages.ToolUseBlock;
  assert.deepEqual(toolUse.input, {});
});

// ─── Streaming ──────────────────────────────────────────────────────────────

async function* chunks(items: unknown[]) {
  for (const item of items) yield item as never;
}

test('streamed text and tool arguments arrive as the deltas the loop counts', async () => {
  let final: Anthropic.Messages.Message | null = null;
  const events: Anthropic.Messages.RawMessageStreamEvent[] = [];
  for await (const event of emitStreamEvents(chunks([
    { id: 'chatcmpl-2', model: 'gpt-5.4', choices: [{ delta: { content: 'Room ' } }] },
    { choices: [{ delta: { content: '302 is clean' } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'mark_clean', arguments: '{"ro' } }],
        },
      }],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'om":"302"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 7 } },
  ]), 'gpt-5.4', (message) => { final = message; })) {
    events.push(event);
  }

  const textDeltas = events
    .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
    .map((e) => (e as { delta: { text: string } }).delta.text);
  assert.deepEqual(textDeltas, ['Room ', '302 is clean']);

  // input_json_delta bytes are what streamAgent counts as billing evidence for
  // a tool-only stream that dies before completing.
  const jsonDeltas = events
    .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
    .map((e) => (e as { delta: { partial_json: string } }).delta.partial_json);
  assert.deepEqual(jsonDeltas, ['{"ro', 'om":"302"}']);

  assert.ok(final);
  const message = final as unknown as Anthropic.Messages.Message;
  assert.equal(message.stop_reason, 'tool_use');
  const toolUse = message.content.find((b) => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock;
  assert.deepEqual(toolUse.input, { room: '302' });
  assert.equal(message.usage.input_tokens, 30);
  assert.equal(message.usage.output_tokens, 7);
});

test('no message_start is emitted, so a dying stream is not billed at zero', async () => {
  // streamAgent treats message_start as provider-counted proof of input usage
  // and, on a mid-flight failure, commits exactly the counts it carried. OpenAI
  // reports usage only in its final chunk, so a synthetic message_start could
  // only carry zeros — and a crashed turn OpenAI really billed would be
  // recorded as free. Emitting none leaves inflightUsage null, which is the
  // signal to fall back to a conservative request-size estimate.
  const events: string[] = [];
  for await (const event of emitStreamEvents(
    chunks([{ choices: [{ delta: { content: 'hi' } }] }]),
    'gpt-5.4',
    () => {},
  )) {
    events.push(event.type);
  }
  assert.equal(events.includes('message_start'), false);
  assert.ok(events.includes('content_block_delta'));
  assert.ok(events.includes('message_stop'));
});

test('text streamed alongside tool calls keeps distinct block indices', async () => {
  const starts: Array<{ index: number; type: string }> = [];
  for await (const event of emitStreamEvents(chunks([
    { choices: [{ delta: { content: 'one moment' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'y', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]), 'gpt-5.4', () => {})) {
    if (event.type === 'content_block_start') {
      starts.push({ index: event.index, type: (event.content_block as { type: string }).type });
    }
  }
  // Colliding indices would make two tool calls overwrite each other.
  assert.deepEqual(starts, [
    { index: 0, type: 'text' },
    { index: 1, type: 'tool_use' },
    { index: 2, type: 'tool_use' },
  ]);
});

// ─── Client behaviour ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('an HTTP error carries a status the shared classifier understands', async () => {
  const { classifyAnthropicError } = await import('@/lib/agent/loop-core');
  const client = createOpenAiMessagesClient({
    apiKey: 'sk-test',
    timeoutMs: 5_000,
    fetchImpl: async () => jsonResponse({ error: { message: 'slow down' } }, 429),
  });
  await assert.rejects(
    () => client.messages.create({
      model: 'gpt-5.4',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    } as Anthropic.Messages.MessageCreateParamsNonStreaming),
    (error: unknown) => {
      // Same bucket an Anthropic 429 lands in, so every retry and alerting rule
      // downstream keeps working without learning about a second provider.
      assert.equal(classifyAnthropicError(error), 'rate_limit');
      return true;
    },
  );
});

test('a transient failure retries once and a bad request does not', async () => {
  let calls = 0;
  const retrying = createOpenAiMessagesClient({
    apiKey: 'sk-test',
    timeoutMs: 5_000,
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: { message: 'overloaded' } }, 503)
        : jsonResponse({
            id: 'c', model: 'gpt-5.4',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
    },
  });
  const message = await retrying.messages.create({
    model: 'gpt-5.4', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
  } as Anthropic.Messages.MessageCreateParamsNonStreaming);
  assert.equal(calls, 2);
  assert.equal((message.content[0] as Anthropic.Messages.TextBlock).text, 'ok');

  let badCalls = 0;
  const notRetrying = createOpenAiMessagesClient({
    apiKey: 'sk-test',
    timeoutMs: 5_000,
    maxRetries: 1,
    fetchImpl: async () => {
      badCalls += 1;
      return jsonResponse({ error: { message: 'bad model' } }, 400);
    },
  });
  await assert.rejects(() => notRetrying.messages.create({
    model: 'nope', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
  } as Anthropic.Messages.MessageCreateParamsNonStreaming));
  // A malformed request fails identically on a retry — spending twice for the
  // same 400 is pure waste.
  assert.equal(badCalls, 1);
});

test('the streaming client parses SSE and resolves a final message', async () => {
  const sse = [
    'data: {"id":"chatcmpl-3","model":"gpt-5.4","choices":[{"delta":{"content":"all"}}]}',
    'data: {"choices":[{"delta":{"content":" clear"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
    'data: [DONE]',
    '',
  ].join('\n');

  const client = createOpenAiMessagesClient({
    apiKey: 'sk-test',
    timeoutMs: 5_000,
    fetchImpl: async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });

  const stream = client.messages.stream({
    model: 'gpt-5.4', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
  } as Anthropic.Messages.MessageStreamParams);

  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
    }
  }
  const message = await stream.finalMessage();
  assert.equal(text, 'all clear');
  assert.equal(message.stop_reason, 'end_turn');
  assert.equal(message.usage.input_tokens, 12);
  assert.equal(message.usage.output_tokens, 3);
});
