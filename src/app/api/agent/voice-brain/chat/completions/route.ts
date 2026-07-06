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

import { streamAgent, type AgentMessage, type AgentToolCall, type UsageReport } from '@/lib/agent/llm';
import { getToolsForRole, getTool } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { retrieveMemoryForTurn } from '@/lib/agent/memory-context';
import {
  getLivePendingActions,
  createPendingActions,
  reapStaleApprovedActions,
  type PendingActionRow,
} from '@/lib/agent/pending-actions';
import {
  pickVoiceLang,
  buildSpokenReadback,
  buildPendingConfirmationPromptBlock,
  type VoiceLang,
} from '@/lib/agent/voice-confirm-copy';
import { recordNonRequestCost, assertAudioBudget } from '@/lib/agent/cost-controls';
import {
  resolveVoiceSession,
  bindVoiceSessionToConnection,
  markVoiceSessionTurn,
  VOICE_SESSION_DYNVAR_KEY,
  type ResolvedVoiceSession,
} from '@/lib/agent/voice-session';
import { getOrMintRequestId, log } from '@/lib/log';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';
import { env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { captureException } from '@/lib/sentry';

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
 * Plan v2 M-1: extract the ElevenLabs `conversation_id` from the webhook
 * body. ElevenLabs forwards this on the OpenAI chat-completions payload;
 * it lands inconsistently depending on SDK version, so we check the
 * documented `elevenlabs_extra_body.conversation_id`, the older
 * `extra_body.conversation_id` shape, and the OpenAI standard `user`
 * field (some ElevenLabs versions stuff conv_id there). NULL when none
 * of those are present — caller treats absence as a fatal binding error
 * once the migration is deployed and ElevenLabs's config exposes the id.
 */
function extractElevenLabsConversationId(body: OpenAIChatRequest): string | null {
  const eb = body.elevenlabs_extra_body as Record<string, unknown> | undefined;
  const xb = body.extra_body as Record<string, unknown> | undefined;
  return (
    asString(eb?.conversation_id) ??
    asString(xb?.conversation_id) ??
    asString(body.user) ??
    null
  );
}

/**
 * Resolve the caller's spoken language ('en' | 'es') for the deterministic
 * spoken-confirmation read-back. Reads staff.language for the session's staffId;
 * that column can be en/es/ht/tl/vi, but the approval copy only has EN + ES, so
 * anything that isn't 'es' collapses to 'en'. Best-effort: any error (no staff
 * row, DB hiccup) falls back to 'en' — the read-back must never block a turn.
 */
async function resolveVoiceLang(staffId: string | null): Promise<VoiceLang> {
  if (!staffId) return 'en';
  try {
    const { data } = await supabaseAdmin
      .from('staff')
      .select('language')
      .eq('id', staffId)
      .maybeSingle();
    return pickVoiceLang(data?.language as string | null | undefined);
  } catch {
    return 'en';
  }
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
  const secret = env.ELEVENLABS_WEBHOOK_SECRET;
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
  // Plan v2 M-1: pull the ElevenLabs conversation_id off the webhook body
  // and pass it into resolveVoiceSession. If the row is already bound to a
  // different conversation_id, the resolve refuses; if the row is unbound,
  // we bind it ourselves on this first accepted turn (compare-and-set
  // below). Soft mode: when STAXIS_VOICE_REQUIRE_CONNECTION_BINDING is
  // 'false' (default during initial rollout to allow ElevenLabs SDK shape
  // verification), a missing conversation_id is logged but not fatal —
  // the binding column stays NULL and replay protection isn't engaged for
  // that session. Flip the env to 'true' once we've confirmed the
  // conversation_id is reliably present in production traffic.
  const elevenlabsConvId = extractElevenLabsConversationId(body);
  const requireBinding = (env.STAXIS_VOICE_REQUIRE_CONNECTION_BINDING ?? 'false') === 'true';
  if (!elevenlabsConvId && requireBinding) {
    log.warn('[voice-brain] missing ElevenLabs conversation_id (binding required)', {
      requestId,
      sessionId,
    });
    return NextResponse.json({ error: 'voice session missing_connection_id' }, { status: 400 });
  }

  const resolved = await resolveVoiceSession(sessionId, elevenlabsConvId);
  if (!resolved.ok) {
    log.warn('[voice-brain] voice session rejected', {
      requestId,
      sessionId,
      reason: resolved.reason,
      hasConvId: !!elevenlabsConvId,
    });
    return NextResponse.json({ error: `voice session ${resolved.reason}` }, { status: 401 });
  }
  const ctx: ResolvedVoiceSession = resolved.ctx;

  // Plan v2 M-1: if this is the first accepted turn for the session and
  // we have a conversation_id, claim the binding atomically. If somebody
  // else raced us (unlikely — ElevenLabs serializes its own webhook
  // delivery per conversation), bindVoiceSessionToConnection returns
  // false and we refuse the turn rather than risk talking on a session
  // we don't own.
  if (resolved.needsConnectionBinding && elevenlabsConvId) {
    try {
      const claimed = await bindVoiceSessionToConnection(sessionId, elevenlabsConvId);
      if (!claimed) {
        log.warn('[voice-brain] connection-binding race lost — rejecting turn', {
          requestId,
          sessionId,
        });
        return NextResponse.json({ error: 'voice session binding_mismatch' }, { status: 401 });
      }
    } catch (e) {
      log.error('[voice-brain] connection-binding write failed', { requestId, sessionId, e });
      return NextResponse.json({ error: 'voice session binding_failed' }, { status: 500 });
    }
  }

  // Stamp last_turn_at so the next turn's idle-expiry check sees fresh
  // activity. Done BEFORE the brain runs so a slow Anthropic call doesn't
  // make a 4-min-long voice turn look idle to the next webhook.
  try {
    await markVoiceSessionTurn(sessionId);
  } catch (e) {
    // Best-effort; the next turn would still pass idle unless many
    // minutes elapse. Log and continue.
    log.warn('[voice-brain] markVoiceSessionTurn failed', { requestId, sessionId, e });
  }

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
        // session accumulated brain + STT/TTS spend that the mint-time
        // check couldn't see. Per-turn check closes that gap.
        //
        // Plan v2 M-4 (Codex catch): this used to fail OPEN on
        // assertAudioBudget exceptions — a Supabase outage turned every
        // audio cap into best-effort logging while ElevenLabs + Anthropic
        // spend continued. /api/agent/speak and /transcribe both fail
        // closed on the same error class; voice-brain now matches them.
        // The user hears a one-line apology; the turn ends without ever
        // calling Anthropic.
        let budget;
        try {
          budget = await assertAudioBudget({
            userId: ctx.accountId,
            propertyId: ctx.propertyId,
          });
        } catch (budgetErr) {
          log.error('[voice-brain] budget check threw — failing CLOSED', { requestId, budgetErr });
          const id = makeOpenAiId();
          controller.enqueue(encoder.encode(sseChunk(id, model, { role: 'assistant' }, null)));
          for (const seg of splitForStream("Sorry, I can't take this turn right now — please try again in a moment.")) {
            controller.enqueue(encoder.encode(sseChunk(id, model, { content: seg }, null)));
          }
          controller.enqueue(encoder.encode(sseChunk(id, model, {}, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
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
        // surface='voice' is passed below to getToolsForRole — the general
        // voice catalog includes the memory tools (remember/forget) alongside
        // the existing general-voice tools; tools opt into voice explicitly
        // (the secure-by-default posture after the Codex P0 fix).
        //
        // Feature #11: the voice mode + UI room hint are stitched into the
        // system prompt by buildSystemPrompt so the agent in 'housekeeper_issue'
        // mode knows it should only fire createMaintenanceWorkOrder and
        // defaults the room to whatever the UI hint says.
        // Voice approval gate — cross-turn wiring (server-side, re-derived from
        // the DB every turn). BEFORE building tools + prompt, check whether a
        // CARD-tier action staged on a previous turn is still awaiting the
        // user's spoken confirmation. If so, we (a) expose the confirm/cancel
        // control tools this turn and (b) inject a prompt note so the model
        // reads the user's "yes"/"no" as a decision on that action. Resolving
        // this from getLivePendingActions means the confirmation state survives
        // the stateless, history-replayed voice model with no session mutation.
        // voiceLang drives the deterministic spoken read-back copy (EN/ES).
        // A staged card is only surfaced for confirmation for a SHORT window: a
        // spoken confirmation is a one-turn affair (stage on turn N → answer on
        // N+1). If the user moved on without answering, an older row must NOT be
        // silently confirmable against a later, unrelated "yes". We bound the
        // surfaced row to CONFIRM_WINDOW_MS by created_at (well under the row's
        // 10-min TTL). Codex review finding (voice had no stale-row sweep like
        // chat's sweepConversationPending).
        const CONFIRM_WINDOW_MS = 3 * 60_000;
        let voiceLang: 'en' | 'es' = 'en';
        let pendingRow: PendingActionRow | null = null;
        try {
          // Reap any row stuck 'approved' (claimed by a prior confirm that was
          // killed before it finalized) so it becomes terminal instead of
          // lingering. Best-effort, in parallel with the live-row read.
          const [lang, livePending] = await Promise.all([
            resolveVoiceLang(ctx.staffId),
            getLivePendingActions(ctx.conversationId),
            reapStaleApprovedActions(ctx.conversationId).catch((e) => {
              log.warn('[voice-brain] reapStaleApprovedActions failed', { requestId, e });
              return [];
            }),
          ]);
          voiceLang = lang;
          // Scope to this session's own account/property (defence in depth),
          // require a recent creation (confirmation window), and pick the newest
          // — we hold one action at a time.
          const now = Date.now();
          const owned = livePending.filter(
            (r) =>
              r.propertyId === ctx.propertyId &&
              r.accountId === ctx.accountId &&
              now - new Date(r.createdAt).getTime() <= CONFIRM_WINDOW_MS,
          );
          pendingRow = owned.length > 0 ? owned[owned.length - 1] : null;
        } catch (e) {
          // Best-effort: a failed lookup just means we don't wire the confirm
          // tools this turn (the pending row, if any, stays live for a later
          // turn). Never block the turn on it.
          log.warn('[voice-brain] pending-action lookup failed', { requestId, e });
        }

        let systemPrompt;
        try {
          const [snapshot, memoryBlock] = await Promise.all([
            buildHotelSnapshot(ctx.propertyId, ctx.role, ctx.staffId),
            retrieveMemoryForTurn(ctx.propertyId, ctx.accountId),
          ]);
          systemPrompt = await buildSystemPrompt(ctx.role, snapshot, ctx.conversationId, {
            mode: ctx.mode,
            currentRoomNumber: ctx.currentRoomNumber,
          }, memoryBlock);
          // Append the "awaiting confirmation" note to the DYNAMIC block (never
          // the cached stable prefix) — it changes turn-to-turn with DB state.
          if (pendingRow) {
            systemPrompt = {
              ...systemPrompt,
              dynamic: `${systemPrompt.dynamic}\n\n${buildPendingConfirmationPromptBlock(pendingRow.toolName, pendingRow.toolArgs, voiceLang)}`,
            };
          }
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
        // Memory tools (remember/forget) opt into general voice via
        // surfaces:['chat','voice'] + voiceModes:['general'], alongside the
        // existing general-voice tools. Curating which tools are voice-callable
        // is a deliberate product decision tracked separately.
        //
        // Feature #11 (2026-05-24): pass the voice mode so tools that opt
        // into a specific mode (e.g. createMaintenanceWorkOrder with
        // voiceModes: ['housekeeper_issue']) are only exposed when the
        // session is in that mode. General voice sessions get the memory
        // tools; housekeeper_issue mode gets just the issue-reporter tool.
        const tools = getToolsForRole(ctx.role, 'voice', ctx.mode);
        // When an action is awaiting confirmation, add the confirm/cancel control
        // tools so the model can act on the user's spoken yes/no. They are
        // surfaces:['voice'], mutates:false, and available in ALL voice modes, so
        // getTool returns them regardless of mode. Only added when a row is live,
        // so a normal turn's tool list is unchanged.
        if (pendingRow) {
          for (const name of ['confirm_pending_action', 'cancel_pending_action']) {
            const t = getTool(name);
            if (t && !tools.some((x) => x.name === name)) tools.push(t);
          }
        }
        const userCtx = {
          uid: ctx.userId,
          accountId: ctx.accountId,
          username: '',
          displayName: '',
          role: ctx.role,
          propertyAccess: [ctx.propertyId],
          dept: ctx.dept,
        };

        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage,
          tools,
          abortSignal: req.signal,
          // Voice approval gate: hold CARD-tier mutations (log_complaint,
          // createMaintenanceWorkOrder) for spoken confirmation; quick-tier
          // mutations (remember/forget/log_found_item/log_reading/log_pm_check)
          // still execute inline this turn.
          voiceApprovalMode: true,
          toolContext: {
            user: userCtx,
            propertyId: ctx.propertyId,
            staffId: ctx.staffId,
            requestId,
            surface: 'voice',
            voiceMode: ctx.mode,
            currentRoomNumber: ctx.currentRoomNumber,
            voiceSessionId: ctx.voiceSessionId,
            conversationId: ctx.conversationId,
            voiceLang,
          },
        });

        // Card-tier actions the gate held THIS turn (each arrives as a
        // tool_call_pending_approval event). We stage the FIRST one as a pending
        // row and speak its read-back; if the model somehow proposed more than
        // one card in a single turn, we hold only the first and tell the user
        // we'll take them one at a time.
        const heldThisTurn: AgentToolCall[] = [];
        let stagedRow: PendingActionRow | null = null;
        // When the gate holds a card it ENDS the turn with no `done` event (and
        // so no finalUsage), but the model still spent tokens producing the
        // proposal. Capture the most recent assistant_turn usage as a fallback so
        // the cost ledger books that spend instead of silently dropping it.
        let lastTurnUsage: UsageReport | null = null;
        for await (const event of iter) {
          if (event.type === 'assistant_turn') {
            lastTurnUsage = event.usage;
          } else if (event.type === 'tool_call_pending_approval') {
            heldThisTurn.push(event.call);
            // Persist only the FIRST held card as a pending row (one at a time).
            if (!stagedRow) {
              try {
                const [row] = await createPendingActions({
                  propertyId: ctx.propertyId,
                  conversationId: ctx.conversationId,
                  accountId: ctx.accountId,
                  turnKey: event.turnKey,
                  actions: [{
                    toolCallId: event.call.id,
                    toolName: event.call.name,
                    toolArgs: event.call.args,
                    tier: event.tier,
                  }],
                });
                stagedRow = row ?? null;
              } catch (e) {
                log.error('[voice-brain] failed to stage pending action', { requestId, e });
              }
            }
          } else if (event.type === 'done') {
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

        // If a card-tier action was held this turn, speak a DETERMINISTIC
        // read-back built from buildActionSummary (never model free-text, so the
        // confirmation is always accurate). This overrides finalText — the turn
        // ended without a `done` (the gate stops after staging), so the model's
        // own text isn't the right thing to speak here. On the NEXT turn the
        // confirm/cancel tools + the injected prompt note carry it home.
        if (stagedRow) {
          finalText = buildSpokenReadback(
            stagedRow.toolName,
            stagedRow.toolArgs,
            voiceLang,
            heldThisTurn.length > 1,
          );
        } else if (heldThisTurn.length > 0) {
          // The gate held a card but we couldn't persist the pending row
          // (createPendingActions threw — logged above). The turn ended with no
          // `done`, so the model produced no result text to speak. Speak a clear
          // "couldn't set that up" instead of the generic "no response" fallback,
          // so the user knows to retry rather than assuming it went through.
          finalText =
            voiceLang === 'es'
              ? 'No pude preparar eso para confirmar. Inténtalo de nuevo, por favor.'
              : "I couldn't set that up to confirm — please try that again.";
        }

        // Book spend for a held turn (no `done` → finalUsage stayed null).
        if (!finalUsage && lastTurnUsage) finalUsage = lastTurnUsage;

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
            // 2026-05-22 audit (Codex): cost-ledger write failure must not
            // break the reply (the SSE has already streamed), but it MUST
            // page. Anthropic was billed; agent_costs has no row; the
            // audio budget cap loses fidelity until next UTC day if this
            // persists. captureException pages immediately; the app_events
            // row is the durable reconciliation surface.
            const errObj = e instanceof Error ? e : new Error(String(e));
            log.error('[voice-brain] cost-ledger write failed', {
              requestId,
              err: errObj,
              accountId: ctx.accountId,
              propertyId: ctx.propertyId,
              unrecorded: {
                tokensIn: finalUsage.inputTokens,
                tokensOut: finalUsage.outputTokens,
                costUsd: finalUsage.costUsd,
                modelId: finalUsage.modelId,
              },
            });
            captureException(errObj, {
              subsystem: 'cost-ledger',
              route: 'voice-brain',
              severity: 'high',
              accountId: ctx.accountId,
              propertyId: ctx.propertyId,
              cost_usd: finalUsage.costUsd,
            });
            try {
              await supabaseAdmin.from('app_events').insert({
                property_id: ctx.propertyId,
                event_type: 'cost_ledger_failure',
                metadata: {
                  route: 'voice-brain',
                  accountId: ctx.accountId,
                  model: finalUsage.model,
                  modelId: finalUsage.modelId,
                  tokensIn: finalUsage.inputTokens,
                  tokensOut: finalUsage.outputTokens,
                  costUsd: finalUsage.costUsd,
                  kind: 'audio',
                },
              });
            } catch { /* Sentry already paged; durable fallback best-effort */ }
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
          // Plan v2 M-1 rollout telemetry: surface whether ElevenLabs is
          // reliably forwarding their conversation_id. We need this true
          // on real voice traffic before flipping
          // STAXIS_VOICE_REQUIRE_CONNECTION_BINDING=true; otherwise the
          // bind-required mode would refuse every turn.
          hasConvId: !!elevenlabsConvId,
          mode: ctx.mode,
          hasRoomHint: !!ctx.currentRoomNumber,
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
