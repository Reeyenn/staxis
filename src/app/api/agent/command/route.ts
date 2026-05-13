// ─── POST /api/agent/command ───────────────────────────────────────────────
// The main entry point to the agent layer. All surfaces (chat UI, voice,
// Clicky walkthrough) call this with a user message and get back a streamed
// SSE response with the model's tokens, tool calls, and final result.
//
// Request body:
//   {
//     conversationId?: string  // omit to start a new conversation
//     propertyId: string       // which property the user is operating on
//     message: string          // the user's input
//   }
//
// Response: text/event-stream with these event types (data is JSON):
//   {"type": "conversation_id", "id": "..."}             — sent immediately
//   {"type": "text_delta", "delta": "..."}               — streaming text from model
//   {"type": "tool_call_started", "call": {...}}         — model is calling a tool
//   {"type": "tool_call_finished", "call":..., "result":..., "isError":...} — tool returned
//   {"type": "done", "usage": {...}, "finalText": "..."} — finished
//   {"type": "error", "message": "..."}                  — fatal error

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId } from '@/lib/log';

import { streamAgent, type AgentMessage, type UsageReport } from '@/lib/agent/llm';
import { getToolsForRole } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt, PROMPT_VERSION } from '@/lib/agent/prompts';
import {
  createConversation,
  loadConversation,
  recordUserTurn,
  recordAssistantTurn,
  recordToolResult,
} from '@/lib/agent/memory';
import { checkCostCaps, recordCost } from '@/lib/agent/cost-controls';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';

import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RequestBody {
  conversationId?: string;
  propertyId: string;
  message: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── Auth ──────────────────────────────────────────────────────────────
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  // ── Parse + validate body ─────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json', requestId }, { status: 400 });
  }
  if (!body.message?.trim()) {
    return Response.json({ ok: false, error: 'message is required', requestId }, { status: 400 });
  }
  if (!body.propertyId) {
    return Response.json({ ok: false, error: 'propertyId is required', requestId }, { status: 400 });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, body.propertyId);
  if (!hasAccess) {
    return Response.json({ ok: false, error: 'no access to this property', requestId }, { status: 403 });
  }

  // ── Load the user's account row + role ────────────────────────────────
  const { data: account, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, property_access, data_user_id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (accountErr || !account) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }

  const userCtx = {
    uid: account.data_user_id as string,
    accountId: account.id as string,
    username: account.username as string,
    displayName: (account.display_name as string) ?? (account.username as string),
    role: (account.role as AppRole) ?? 'staff',
    propertyAccess: (account.property_access as string[]) ?? [],
  };

  // ── Cost + rate-limit caps ────────────────────────────────────────────
  // Block the request BEFORE we burn LLM tokens if any cap is hit.
  const capCheck = await checkCostCaps({
    userId: userCtx.accountId,
    propertyId: body.propertyId,
  });
  if (!capCheck.ok) {
    return Response.json(
      { ok: false, error: capCheck.message, code: capCheck.reason, requestId },
      { status: 429 },
    );
  }

  // ── Load or create the conversation ───────────────────────────────────
  let conversationId = body.conversationId;
  let history: AgentMessage[] = [];
  if (conversationId) {
    const convo = await loadConversation(conversationId, userCtx.accountId);
    if (!convo) {
      return Response.json({ ok: false, error: 'conversation not found or not yours', requestId }, { status: 404 });
    }
    if (convo.propertyId !== body.propertyId) {
      return Response.json({ ok: false, error: 'conversation is scoped to a different property', requestId }, { status: 400 });
    }
    history = convo.messages;
  } else {
    conversationId = await createConversation({
      userAccountId: userCtx.accountId,
      propertyId: body.propertyId,
      role: userCtx.role,
      promptVersion: PROMPT_VERSION,
      // Title is set on the first user message — auto-derived from the prompt.
      title: body.message.trim().slice(0, 120),
    });
    history = [];
  }

  // Persist the user turn before streaming (so a network failure mid-stream
  // doesn't lose the question).
  await recordUserTurn(conversationId, body.message);

  // ── Build the context for this turn ──────────────────────────────────
  const staffIdForSnapshot = userCtx.role === 'housekeeping' ? userCtx.accountId : null;
  const snapshot = await buildHotelSnapshot(body.propertyId, userCtx.role, staffIdForSnapshot);
  const systemPrompt = buildSystemPrompt(userCtx.role, snapshot);
  const tools = getToolsForRole(userCtx.role);

  // ── Stream the agent response via SSE ────────────────────────────────
  const encoder = new TextEncoder();
  // Final usage from the done event, persisted to the LAST assistant text message.
  let finalUsage: UsageReport | null = null;
  let lastDoneText = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      // Send the conversation id immediately so the client can track it.
      send({ type: 'conversation_id', id: conversationId });

      try {
        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage: body.message,
          tools,
          toolContext: {
            user: userCtx,
            propertyId: body.propertyId,
            requestId,
          },
        });

        for await (const event of iter) {
          // The internal-only assistant_turn event is for persistence; don't
          // forward it to the client (the text_deltas + tool_call_started
          // events already rendered everything the user sees).
          if (event.type !== 'assistant_turn') {
            send(event);
          }

          if (event.type === 'assistant_turn') {
            // Mid-conversation iteration: persist text + tool_use blocks NOW
            // so subsequent tool_results land AFTER them in the DB. Replay
            // depends on this ordering — Claude rejects tool_results that
            // come before their matching tool_use in the message history.
            await recordAssistantTurn(
              conversationId!,
              event.text,
              event.toolCalls.length ? event.toolCalls : undefined,
              {
                tokensIn: event.usage.inputTokens,
                tokensOut: event.usage.outputTokens,
                modelUsed: event.usage.model,
                costUsd: event.usage.costUsd,
              },
            ).catch(err => {
              console.error('[agent/command] failed to persist assistant turn', err);
            });
          } else if (event.type === 'tool_call_finished') {
            // Persist tool result row immediately so the order matches the
            // assistant turn we just saved.
            await recordToolResult(conversationId!, event.call.id, event.result).catch(err => {
              console.error('[agent/command] failed to persist tool result', err);
            });
          } else if (event.type === 'done') {
            finalUsage = event.usage;
            lastDoneText = event.finalText;
          }
        }

        // Persist the FINAL assistant text turn — the one with no tool calls
        // (those got saved via assistant_turn events above).
        if (lastDoneText) {
          await recordAssistantTurn(
            conversationId!,
            lastDoneText,
            undefined,
            {
              tokensIn: finalUsage?.inputTokens ?? 0,
              tokensOut: finalUsage?.outputTokens ?? 0,
              modelUsed: finalUsage?.model ?? 'sonnet',
              costUsd: finalUsage?.costUsd ?? 0,
            },
          ).catch(err => {
            console.error('[agent/command] failed to persist final assistant turn', err);
          });
        }

        // Record this request to the agent_costs ledger so future cap
        // checks see it. Includes ALL tokens used across tool-call iterations.
        if (finalUsage) {
          await recordCost({
            userId: userCtx.accountId,
            propertyId: body.propertyId,
            conversationId,
            model: finalUsage.model,
            tokensIn: finalUsage.inputTokens,
            tokensOut: finalUsage.outputTokens,
            cachedInputTokens: finalUsage.cachedInputTokens,
            costUsd: finalUsage.costUsd,
            kind: 'request',
          }).catch(err => {
            console.error('[agent/command] failed to record cost', err);
          });
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-request-id': requestId,
      // Disable proxy buffering so the client sees tokens as they arrive.
      'x-accel-buffering': 'no',
    },
  });
}
