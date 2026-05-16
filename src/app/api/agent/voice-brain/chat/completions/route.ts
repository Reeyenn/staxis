// ─── POST /api/agent/voice-brain ───────────────────────────────────────────
//
// ElevenLabs Conversational AI "Custom LLM" webhook. ElevenLabs sends an
// OpenAI-compatible chat-completions request on every conversation turn;
// we forward into our existing Claude brain (`streamAgent` in
// `src/lib/agent/llm.ts`) so voice + text share one set of system prompts,
// tools, role checks, trust markers, and cost-cap logic. The shape is
// translated, not re-implemented.
//
// Auth:
//   `Authorization: Bearer ${ELEVENLABS_WEBHOOK_SECRET}` — a shared secret
//   registered with ElevenLabs as a workspace secret and attached to the
//   agent's custom_llm config. Constant-time compare via timingSafeEqual.
//
// User identity (Codex 2026-05-16 P0 fix — Pattern A):
//   ElevenLabs forwards a single `staxis_voice_session_id` from
//   `extra_body.dynamic_variables`. We look that nonce up in the
//   `agent_voice_sessions` table, re-load the current role + property
//   from `accounts`, and re-run `userHasPropertyAccess`. Client-supplied
//   role/property values are NEVER used for authorization — only the
//   server-side row is canonical. Closes the cross-tenant escape where
//   a user could forge dynamic_variables to claim another property.
//
// Streaming:
//   ElevenLabs expects an OpenAI-format streaming response. We run our
//   agent to completion (tool loops finish server-side) and then emit ONE
//   chunk with the final assistant text, followed by `[DONE]`. We do NOT
//   stream intermediate-iteration text — otherwise ElevenLabs would speak
//   "Let me check that..." (intermediate iter) then "Occupancy is 84%..."
//   (final iter) with an awkward gap between. Cleanest UX is single-shot
//   delivery.

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { streamAgent, type AgentMessage, type UsageReport } from '@/lib/agent/llm';
import { getToolsForRole } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { recordNonRequestCost, assertAudioBudget } from '@/lib/agent/cost-controls';
import {
  resolveVoiceSession,
  VOICE_SESSION_DYNVAR_KEY,
  type ResolvedVoiceSession,
} from '@/lib/agent/voice-session';
import { getOrMintRequestId, log } from '@/lib/log';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// OpenAI chat-completions message shape. ElevenLabs sends content as a
// plain string for assistant + user messages; tool_calls aren't expected
// here because tool execution stays inside our brain.
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  // The SDK's `customLlmExtraBody` config is forwarded by ElevenLabs's
  // gateway to the custom-LLM webhook under the field `elevenlabs_extra_body`
  // (per the official docs, NOT `extra_body` or `custom_llm_extra_body`).
  // Earlier the code only checked `extra_body` and we lost the dynamic
  // variables on every turn — the user-visible symptom was three hours
  // of "custom_llm_error: Failed to generate response from custom LLM".
  // We still check both `extra_body` and `dynamic_variables` (top-level)
  // as defensive fallbacks for any SDK version drift.
  elevenlabs_extra_body?: {
    dynamic_variables?: Record<string, string | number | boolean>;
    [k: string]: unknown;
  };
  extra_body?: {
    dynamic_variables?: Record<string, string | number | boolean>;
    [k: string]: unknown;
  };
  dynamic_variables?: Record<string, string | number | boolean>;
  user?: string;
}

function timingSafeBearerCheck(authHeader: string, expected: string): boolean {
  const a = Buffer.from(authHeader);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function extractDynamicVariables(body: OpenAIChatRequest): Record<string, string | number | boolean> {
  // Primary: ElevenLabs forwards `customLlmExtraBody` (set via the SDK at
  // session start) as `elevenlabs_extra_body` in the OpenAI request.
  // Defensive fallbacks for SDK version drift: `extra_body.dynamic_variables`
  // and top-level `dynamic_variables`. The whole `elevenlabs_extra_body`
  // object is OUR payload — we set it as `{ dynamic_variables: { ... } }`
  // in useConversationalSession.
  return (
    body.elevenlabs_extra_body?.dynamic_variables ??
    body.extra_body?.dynamic_variables ??
    body.dynamic_variables ??
    {}
  );
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pull ONLY the voice-session nonce from dynamic_variables. Codex 2026-05-16
 * P0 fix (Pattern A): any other field that used to flow through here
 * (account_id, role, property_id, staff_id) is now diagnostic-only — never
 * used for authorization. The nonce is looked up in `agent_voice_sessions`,
 * and identity is re-resolved from accounts on every call.
 */
function extractVoiceSessionId(body: OpenAIChatRequest): string | null {
  const dv = extractDynamicVariables(body);
  return asString(dv[VOICE_SESSION_DYNVAR_KEY]);
}

/**
 * Translate the OpenAI messages array into our internal `AgentMessage`
 * history. The LAST user message becomes `newUserMessage`; everything
 * before it is history. System messages from ElevenLabs are ignored —
 * we build our own system prompt from the hotel snapshot + role prompt.
 */
function translateMessages(messages: OpenAIMessage[]): { history: AgentMessage[]; newUserMessage: string } {
  // Find the index of the last user message. Anything after it is
  // discarded — ElevenLabs should not be sending trailing assistant text
  // that hasn't been spoken yet, but we tolerate it for robustness.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }

  // ElevenLabs sends a "session init" custom-LLM call BEFORE the user
  // speaks — often messages contains only a system role (or is empty)
  // and there's no user content yet. Earlier the route rejected this
  // with 400, which ElevenLabs surfaces as "custom_llm_error" and the
  // overlay shows ERROR before the user even talks. Now: synthesize a
  // placeholder "hi" so the brain produces a friendly opener Jessica
  // can speak as the session greeting. The brain's system prompt + role
  // addendum handle the rest.
  let newUserMessage =
    lastUserIdx === -1
      ? 'hi'
      : (messages[lastUserIdx].content ?? '').trim() || 'hi';

  const history: AgentMessage[] = [];
  const upTo = lastUserIdx === -1 ? messages.length : lastUserIdx;
  for (let i = 0; i < upTo; i++) {
    const m = messages[i];
    const text = (m.content ?? '').trim();
    if (!text) continue;
    if (m.role === 'user') {
      history.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      // ElevenLabs only sends text-only assistant turns (it doesn't know
      // about our internal tool_use blocks), so a single text content
      // block is the right shape.
      history.push({ role: 'assistant', content: text });
    }
    // role === 'system' or 'tool' is skipped — we own those layers.
  }
  return { history, newUserMessage };
}

// OpenAI's streaming chat-completions emits one chunk per delta shape:
//   role-only chunk first, then many content-only chunks, then a final
//   chunk with an empty delta + finish_reason. Combining role+content in
//   one chunk is a common shape but ElevenLabs's gateway parser was
//   observed rejecting it (no LLM tokens counted, conversation marked
//   `custom_llm_error` with no Vercel logs of the call). This helper
//   emits the canonical OpenAI shape so any strict parser is satisfied.
function makeOpenAiId(): string {
  return `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}
function sseChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  const obj = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function splitForStream(text: string): string[] {
  // Split into ~30-char segments at word boundaries when possible. Mimics
  // real OpenAI streaming (small frequent chunks) without paying for
  // per-character serialization overhead. Empty text → one empty chunk
  // (still need to send something so the gateway sees content).
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return [''];
  const SIZE = 30;
  const out: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    let end = Math.min(i + SIZE, trimmed.length);
    if (end < trimmed.length) {
      const space = trimmed.lastIndexOf(' ', end);
      if (space > i + 5) end = space + 1;
    }
    out.push(trimmed.slice(i, end));
    i = end;
  }
  return out;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const tEntry = performance.now();
  log.info('[voice-brain] entry', { requestId });

  // ── Auth: shared bearer secret ────────────────────────────────────────
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {
    log.error('[voice-brain] ELEVENLABS_WEBHOOK_SECRET not configured', { requestId });
    return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
  }
  const authHeader = req.headers.get('authorization') ?? '';
  if (!timingSafeBearerCheck(authHeader, secret)) {
    log.warn('[voice-brain] auth rejected', { requestId, hasHeader: authHeader.length > 0 });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // ── Parse OpenAI-format body ──────────────────────────────────────────
  let body: OpenAIChatRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  // Don't reject on empty messages — ElevenLabs sends a session-init
  // call with messages=[] or messages=[{role:'system',...}] BEFORE
  // the user speaks. translateMessages handles the no-user-message
  // case by synthesizing a greeting prompt.
  if (!Array.isArray(body.messages)) body.messages = [];

  // ── Server-resolved identity from agent_voice_sessions ────────────────
  // Codex 2026-05-16 P0 fix (Pattern A): client-supplied identity claims
  // (role, property_id, account_id) are NEVER used for authorization. We
  // accept only a `staxis_voice_session_id` nonce and look up the canonical
  // identity in the DB on every webhook call. Role + property access are
  // re-read from the `accounts` table so mid-session revocation propagates.
  const sessionId = extractVoiceSessionId(body);
  if (!sessionId) {
    // Log the SHAPE we received (key names only — values may contain
    // sensitive IDs). If ElevenLabs ever changes their forwarding path
    // away from `extra_body.dynamic_variables`, this log line is the
    // one-glance diagnostic that names the new key path.
    const bodyKeys = Object.keys(body ?? {});
    const elevenKeys = body?.elevenlabs_extra_body ? Object.keys(body.elevenlabs_extra_body) : [];
    const extraBodyKeys = body?.extra_body ? Object.keys(body.extra_body) : [];
    const dvKeys =
      (body?.elevenlabs_extra_body?.dynamic_variables && Object.keys(body.elevenlabs_extra_body.dynamic_variables)) ??
      (body?.extra_body?.dynamic_variables && Object.keys(body.extra_body.dynamic_variables)) ??
      [];
    log.warn('[voice-brain] missing voice session id', {
      requestId,
      bodyKeys,
      elevenlabsExtraBodyKeys: elevenKeys,
      extraBodyKeys,
      dynamicVariableKeys: dvKeys,
      topLevelDynamicVarsPresent: !!body?.dynamic_variables,
    });
    return NextResponse.json({ error: `missing ${VOICE_SESSION_DYNVAR_KEY}` }, { status: 400 });
  }
  const resolved = await resolveVoiceSession(sessionId);
  if (!resolved.ok) {
    log.warn('[voice-brain] voice session rejected', {
      requestId,
      sessionId,
      reason: resolved.reason,
    });
    return NextResponse.json({ error: `voice session ${resolved.reason}` }, { status: 401 });
  }
  const ctx: ResolvedVoiceSession = resolved.ctx;

  // ── Translate messages → AgentMessage[] ───────────────────────────────
  const { history, newUserMessage } = translateMessages(body.messages);

  // NB: We DON'T build the hotel snapshot or system prompt here. Snapshot
  // builds (Supabase round-trips) can take 3–8s on a cold property and
  // ElevenLabs has a short first-byte timeout. Building inside the stream
  // start() lets us flush a keepalive SSE comment immediately so they see
  // bytes flowing before the slow work runs. Errors during the build are
  // surfaced as a polite spoken sentence inside the 200 stream instead
  // of as a 5xx — once headers go out we can't change status code.

  // ── Stream the agent → buffer final text → emit OpenAI chunk ─────────
  // We deliberately do NOT stream intermediate-iteration text deltas: the
  // tool loop can produce multiple text turns ("Let me check that..." →
  // tool result → "Occupancy is 84%..."), and speaking the early ones
  // turns voice mode into a stutter. Buffer everything, emit once when
  // the brain is done.
  const encoder = new TextEncoder();
  const model = body.model ?? 'claude-sonnet-4-6';

  const stream = new ReadableStream({
    async start(controller) {
      // First byte out the door BEFORE the slow snapshot build. ElevenLabs
      // (and intermediate proxies) reset connections that look idle; an
      // SSE comment is ignored by their parser but flushes the HTTP
      // response headers and proves the stream is alive. Repeated every
      // few seconds inside long brain turns would harden further, but
      // for now one upfront comment covers our cold-start latency.
      controller.enqueue(encoder.encode(': keepalive\n\n'));
      const tFirstByte = performance.now();

      let finalUsage: UsageReport | null = null;
      let finalText = '';

      try {
        // Security review 2026-05-16 (Surface 7 P3 — Pattern F): assert
        // the daily $ budget at the START of every voice turn. Pre-flight
        // at session-mint catches "new session over cap" but a long-lived
        // session (up to the 4hr agent_voice_sessions TTL) accumulated
        // brain + STT/TTS spend that the mint-time check couldn't see.
        // Per-turn check closes that gap. On over-budget we emit a polite
        // spoken sentence + finish — never silently keep billing.
        const budget = await assertAudioBudget({
          userId: ctx.accountId,
          propertyId: ctx.propertyId,
        }).catch((budgetErr) => {
          // Don't fail the turn on a budget-check error — log loudly and
          // proceed. Better to bill one extra turn than to brick voice
          // on a transient Supabase hiccup.
          log.error('[voice-brain] budget check threw — failing OPEN', { requestId, budgetErr });
          return { ok: true as const, userSpendUsd: 0, propertySpendUsd: 0 };
        });
        if (!budget.ok) {
          const id = makeOpenAiId();
          controller.enqueue(encoder.encode(sseChunk(id, model, { role: 'assistant' }, null)));
          for (const seg of splitForStream(budget.message)) {
            controller.enqueue(encoder.encode(sseChunk(id, model, { content: seg }, null)));
          }
          controller.enqueue(encoder.encode(sseChunk(id, model, {}, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          log.info('[voice-brain] over-budget — turn declined', {
            requestId, reason: budget.reason,
          });
          return;
        }

        // Build the system prompt for this turn AFTER keepalive flushes.
        // surface='voice' is passed below to getToolsForRole — the voice
        // catalog is empty today (no tool opts in via surfaces:['voice']),
        // which is the secure-by-default posture after the Codex P0 fix.
        let systemPrompt;
        try {
          const snapshot = await buildHotelSnapshot(ctx.propertyId, ctx.role, ctx.staffId);
          systemPrompt = await buildSystemPrompt(ctx.role, snapshot, ctx.conversationId);
        } catch (e) {
          log.error('[voice-brain] failed to build system prompt', { requestId, e });
          const id = makeOpenAiId();
          controller.enqueue(encoder.encode(sseChunk(id, model, { role: 'assistant' }, null)));
          for (const seg of splitForStream("Sorry, I couldn't load the context for this property. Try again in a moment.")) {
            controller.enqueue(encoder.encode(sseChunk(id, model, { content: seg }, null)));
          }
          controller.enqueue(encoder.encode(sseChunk(id, model, {}, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        // Codex 2026-05-16 P0 fix (Pattern E): pass surface='voice' so the
        // tool registry filters down to tools that explicitly opt into the
        // voice surface (via `surfaces: ['voice']` on their definition).
        // Today no tool opts in → voice gets an empty tool list, which is
        // the secure default. Curating which tools are voice-callable is a
        // deliberate product decision tracked separately.
        const tools = getToolsForRole(ctx.role, 'voice');
        const userCtx = {
          uid: ctx.userId,
          accountId: ctx.accountId,
          username: '',
          displayName: '',
          role: ctx.role,
          propertyAccess: [ctx.propertyId],
        };

        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage,
          tools,
          abortSignal: req.signal,
          toolContext: {
            user: userCtx,
            propertyId: ctx.propertyId,
            staffId: ctx.staffId,
            requestId,
            surface: 'voice',
          },
        });

        for await (const event of iter) {
          if (event.type === 'done') {
            finalText = event.finalText;
            finalUsage = event.usage;
          } else if (event.type === 'error') {
            // Brain errors during voice are surfaced as a polite spoken
            // sentence so ElevenLabs has something to say back. The user
            // hears "Hmm, I hit a snag — try that again?" instead of the
            // socket dying mid-reply with no audio.
            finalText = finalText || "Sorry, I hit a snag. Can you try that again?";
            finalUsage = event.usage ?? finalUsage;
            log.warn('[voice-brain] streamAgent error', { requestId, message: event.message });
            break;
          }
          // text_delta, assistant_turn, tool_call_started, tool_call_finished:
          // ignored at this layer — the final text from `done` is what
          // ElevenLabs speaks.
        }

        // Cost ledger — book the LLM spend for this turn under kind='audio'
        // so it joins the audio cap. ElevenLabs STT + TTS minutes are
        // billed separately on their side and surfaced via a different
        // job; this row covers only the Claude brain tokens consumed by
        // /voice-brain.
        if (finalUsage) {
          try {
            await recordNonRequestCost({
              userId: ctx.accountId,
              propertyId: ctx.propertyId,
              conversationId: ctx.conversationId,
              model: finalUsage.model,
              modelId: finalUsage.modelId,
              tokensIn: finalUsage.inputTokens,
              tokensOut: finalUsage.outputTokens,
              costUsd: finalUsage.costUsd,
              kind: 'audio',
            });
          } catch (e) {
            // Cost-ledger write failure must not break the reply.
            log.error('[voice-brain] cost-ledger write failed', { requestId, e });
          }
        }

        const safe = finalText || "Sorry, I didn't get a response.";
        // Canonical OpenAI streaming format:
        //   1. role-only chunk
        //   2. one or more content-only chunks
        //   3. final chunk: empty delta + finish_reason
        //   4. data: [DONE]
        // Splitting content into ~30-char segments mimics real OpenAI
        // streaming and avoids any "single huge chunk" parser quirks.
        const id = makeOpenAiId();
        controller.enqueue(encoder.encode(sseChunk(id, model, { role: 'assistant' }, null)));
        for (const seg of splitForStream(safe)) {
          controller.enqueue(encoder.encode(sseChunk(id, model, { content: seg }, null)));
        }
        controller.enqueue(encoder.encode(sseChunk(id, model, {}, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();

        const tDone = performance.now();
        log.info('[voice-brain] done', {
          requestId,
          firstByteMs: Math.round(tFirstByte - tEntry),
          totalMs: Math.round(tDone - tEntry),
          chars: safe.length,
          tokensIn: finalUsage?.inputTokens ?? 0,
          tokensOut: finalUsage?.outputTokens ?? 0,
        });
      } catch (e) {
        log.error('[voice-brain] unhandled error', { requestId, e });
        try {
          const id = makeOpenAiId();
          controller.enqueue(encoder.encode(sseChunk(id, model, { role: 'assistant' }, null)));
          for (const seg of splitForStream('Sorry, something went wrong on our end.')) {
            controller.enqueue(encoder.encode(sseChunk(id, model, { content: seg }, null)));
          }
          controller.enqueue(encoder.encode(sseChunk(id, model, {}, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch { /* controller already closed */ }
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
