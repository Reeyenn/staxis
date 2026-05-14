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
// User identity:
//   ElevenLabs forwards the `dynamic_variables` we set in `/voice-session`
//   on every webhook call. The brain pulls accountId / propertyId / role /
//   staffId / conversationId out of `extra_body.dynamic_variables` and
//   reconstructs the same `ToolContext` text mode uses. The browser never
//   sends these — they were minted server-side and the user can't forge
//   them past the bearer-secret gate.
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
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { getOrMintRequestId, log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';
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
  // ElevenLabs forwards our dynamic_variables under extra_body. We also
  // accept top-level dynamic_variables and a few common aliases — the API
  // surface has churned across versions; this lets us be loose on the
  // exact path and forgiving of minor renames without redeploying.
  extra_body?: {
    dynamic_variables?: Record<string, string | number | boolean>;
    [k: string]: unknown;
  };
  dynamic_variables?: Record<string, string | number | boolean>;
  user?: string;
}

interface ResolvedContext {
  accountId: string;
  userId: string;
  propertyId: string;
  role: AppRole;
  staffId: string | null;
  conversationId: string;
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
  // Look in every place ElevenLabs might park them. We registered the
  // variables via `dynamicVariables` in the SDK's startSession, which
  // their gateway typically forwards under extra_body.dynamic_variables.
  // Fall through to top-level if their gateway changes.
  return (
    body.extra_body?.dynamic_variables ??
    body.dynamic_variables ??
    {}
  );
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function resolveContext(body: OpenAIChatRequest): ResolvedContext | { error: string } {
  const dv = extractDynamicVariables(body);
  const accountId = asString(dv.staxis_account_id);
  const userId = asString(dv.staxis_user_id);
  const propertyId = asString(dv.staxis_property_id);
  const roleRaw = asString(dv.staxis_role);
  const staffIdRaw = asString(dv.staxis_staff_id);
  const conversationId = asString(dv.staxis_conversation_id);

  if (!accountId || !userId || !propertyId || !roleRaw || !conversationId) {
    return { error: 'missing dynamic variables (account/user/property/role/conversation)' };
  }
  return {
    accountId,
    userId,
    propertyId,
    role: roleRaw as AppRole,
    // Empty string sentinel is what /voice-session sets when there's no
    // staff row (manager / owner). Coerce back to null for ToolContext.
    staffId: staffIdRaw && staffIdRaw.length > 0 ? staffIdRaw : null,
    conversationId,
  };
}

/**
 * Translate the OpenAI messages array into our internal `AgentMessage`
 * history. The LAST user message becomes `newUserMessage`; everything
 * before it is history. System messages from ElevenLabs are ignored —
 * we build our own system prompt from the hotel snapshot + role prompt.
 */
function translateMessages(messages: OpenAIMessage[]): { history: AgentMessage[]; newUserMessage: string } | { error: string } {
  // Find the index of the last user message. Anything after it is
  // discarded — ElevenLabs should not be sending trailing assistant text
  // that hasn't been spoken yet, but we tolerate it for robustness.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return { error: 'no user message in payload' };

  const newUserMessage = (messages[lastUserIdx].content ?? '').trim();
  if (!newUserMessage) return { error: 'empty user message' };

  const history: AgentMessage[] = [];
  for (let i = 0; i < lastUserIdx; i++) {
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

function openAiChunk(content: string, model: string, finishReason: string | null): string {
  const obj = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: finishReason ? {} : { role: 'assistant', content },
      finish_reason: finishReason,
    }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── Auth: shared bearer secret ────────────────────────────────────────
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {
    log.error('[voice-brain] ELEVENLABS_WEBHOOK_SECRET not configured', { requestId });
    return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
  }
  const authHeader = req.headers.get('authorization') ?? '';
  if (!timingSafeBearerCheck(authHeader, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // ── Parse OpenAI-format body ──────────────────────────────────────────
  let body: OpenAIChatRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 });
  }

  // ── Reconstruct Staxis context from ElevenLabs dynamic_variables ──────
  const ctxResult = resolveContext(body);
  if ('error' in ctxResult) {
    log.warn('[voice-brain] context resolution failed', { requestId, error: ctxResult.error });
    return NextResponse.json({ error: ctxResult.error }, { status: 400 });
  }
  const ctx = ctxResult;

  // ── Translate messages → AgentMessage[] ───────────────────────────────
  const translated = translateMessages(body.messages);
  if ('error' in translated) {
    return NextResponse.json({ error: translated.error }, { status: 400 });
  }
  const { history, newUserMessage } = translated;

  // ── Build the system prompt for this turn (snapshot + role) ──────────
  let systemPrompt;
  try {
    const snapshot = await buildHotelSnapshot(ctx.propertyId, ctx.role, ctx.staffId);
    systemPrompt = await buildSystemPrompt(ctx.role, snapshot, ctx.conversationId);
  } catch (e) {
    log.error('[voice-brain] failed to build system prompt', { requestId, e });
    return NextResponse.json({ error: 'failed to build context' }, { status: 500 });
  }

  const tools = getToolsForRole(ctx.role);
  const userCtx = {
    uid: ctx.userId,
    accountId: ctx.accountId,
    username: '',
    displayName: '',
    role: ctx.role,
    propertyAccess: [ctx.propertyId],
  };

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
      let finalUsage: UsageReport | null = null;
      let finalText = '';

      try {
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
        // so it joins the audio cap (which already counts Whisper/TTS spend
        // on the legacy path). For ElevenLabs the STT + TTS minutes are
        // billed separately by their platform and surfaced via a different
        // job later; this row covers only the Claude brain tokens consumed
        // by /voice-brain.
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
        controller.enqueue(encoder.encode(openAiChunk(safe, model, null)));
        controller.enqueue(encoder.encode(openAiChunk('', model, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        log.error('[voice-brain] unhandled error', { requestId, e });
        try {
          controller.enqueue(encoder.encode(openAiChunk(
            "Sorry, something went wrong on our end.",
            model,
            null,
          )));
          controller.enqueue(encoder.encode(openAiChunk('', model, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch { /* controller already closed */ }
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
