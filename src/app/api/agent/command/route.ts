// ─── POST /api/agent/command ───────────────────────────────────────────────
// The main entry point to the agent layer. All surfaces (chat UI, voice,
// Clicky walkthrough) call this with a user message and get back a streamed
// SSE response with the model's tokens, tool calls, and final result.
//
// Codex adversarial review fixes (2026-05-13) wired in here:
//
//   - Fix #1: cost-cap atomicity. `reserveCostBudget` does the cap check
//     and inserts a reservation row in a single Postgres transaction
//     under an advisory lock. `finalizeCostReservation` reconciles to
//     actual spend; `cancelCostReservation` releases the hold on abort.
//
//   - Fix #2: atomic assistant-turn persistence. `recordAssistantTurn`
//     now THROWS on RPC failure. We catch in the stream's try/catch,
//     send an error event, cancel the reservation, and close — we do
//     NOT continue into tool execution because the assistant tool_use
//     blocks aren't safely on disk.
//
//   - Fix #3: dangling tool_use cleanup. The route tracks in-flight
//     tool_call ids in a Set; in the stream's finally, any id still
//     in the set gets a synthetic error tool_result row inserted so
//     the next replay isn't broken. Same path handles client disconnect
//     (req.signal.aborted).
//
//   - Fix #4: housekeeper identity. `staff.id` is resolved from
//     `staff.auth_user_id = userCtx.uid` and passed into ToolContext.
//     Housekeeper-scoped queries use this, NOT `accountId`.
//
// Notes on abort-signal behavior (Codex post-merge review N6):
// `req.signal` is forwarded into `streamAgent` and the Anthropic SDK. It
// fires on TCP-level disconnect, which under Vercel's edge proxy is the
// proxy timeout — NOT the browser close. In practice the abort can take
// 30–60s to fire after the user closes the tab. The actual cost ceiling
// is `REQUEST_TIMEOUT_MS = 50_000` per Anthropic call in
// `src/lib/agent/llm.ts`. Treat the abort signal as best-effort cost
// containment, not a deterministic kill switch.

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
  lockLoadAndRecordUserTurn,
  recordUserTurn,
  recordAssistantTurn,
  recordToolResult,
  recordSyntheticAbortToolResult,
} from '@/lib/agent/memory';
import {
  reserveCostBudget,
  finalizeCostReservation,
  cancelCostReservation,
} from '@/lib/agent/cost-controls';
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
  // Codex adversarial review 2026-05-13 (A-C2 length cap): refuse messages
  // that would inflate the prompt (and therefore cost). 4000 chars is well
  // above any legitimate housekeeping/manager turn but well below the
  // multi-MB DOS surface that an unbounded body left open.
  const MAX_USER_MESSAGE_CHARS = 4000;
  if (body.message.length > MAX_USER_MESSAGE_CHARS) {
    return Response.json(
      { ok: false, error: `message exceeds ${MAX_USER_MESSAGE_CHARS} chars`, requestId },
      { status: 413 },
    );
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

  // ── Resolve staff.id for floor-level roles ───────────────────────────
  // `rooms.assigned_to` references `staff.id`, not `accounts.id` — Codex
  // review fix #4. Look it up by `staff.auth_user_id = user.uid` (only
  // relevant for housekeeping / maintenance roles; managers + owners
  // typically don't have a staff row and don't need scoping).
  let staffId: string | null = null;
  if (userCtx.role === 'housekeeping' || userCtx.role === 'maintenance') {
    const { data: staffRow } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('auth_user_id', userCtx.uid)
      .eq('property_id', body.propertyId)
      .maybeSingle();
    staffId = (staffRow?.id as string) ?? null;
  }

  // ── Cost reservation (Codex review fix #1) ────────────────────────────
  // Atomic: cap check + reservation insert happen under an advisory lock
  // keyed on user_id. Concurrent requests for the same user serialize.
  const reservation = await reserveCostBudget({
    userId: userCtx.accountId,
    propertyId: body.propertyId,
  });
  if (!reservation.ok) {
    return Response.json(
      { ok: false, error: reservation.message, code: reservation.reason, requestId },
      { status: 429 },
    );
  }
  const reservationId = reservation.reservationId;

  // ── Load or create the conversation ───────────────────────────────────
  // Codex round-7 fix F2 (2026-05-13): for EXISTING conversations, do the
  // entire lock + verify + load + record-user-turn atomically inside a
  // single RPC. The prior pattern (call staxis_lock_conversation then
  // loadConversation + recordUserTurn separately) had a race because the
  // RPC's lock released as soon as its implicit transaction ended —
  // BEFORE the JS prep ran. Two browser tabs could both pass through.
  //
  // For NEW conversations, the conversationId is generated fresh so no
  // race is possible; we still create + record-user-turn in JS.
  let conversationId = body.conversationId;
  let history: AgentMessage[] = [];
  try {
    if (conversationId) {
      const prep = await lockLoadAndRecordUserTurn({
        conversationId,
        userAccountId: userCtx.accountId,
        propertyId: body.propertyId,
        userMessage: body.message,
      });
      if (!prep.ok) {
        await cancelCostReservation(reservationId);
        if (prep.reason === 'not_found' || prep.reason === 'wrong_owner') {
          return Response.json({ ok: false, error: 'conversation not found or not yours', requestId }, { status: 404 });
        }
        if (prep.reason === 'wrong_property') {
          return Response.json({ ok: false, error: 'conversation is scoped to a different property', requestId }, { status: 400 });
        }
        return Response.json({ ok: false, error: 'failed to prepare conversation', requestId }, { status: 500 });
      }
      history = prep.history;
    } else {
      conversationId = await createConversation({
        userAccountId: userCtx.accountId,
        propertyId: body.propertyId,
        role: userCtx.role,
        promptVersion: PROMPT_VERSION,
        title: body.message.trim().slice(0, 120),
      });
      history = [];
      await recordUserTurn(conversationId, body.message);
    }
  } catch (e) {
    await cancelCostReservation(reservationId);
    return Response.json(
      { ok: false, error: 'failed to prepare conversation', requestId, details: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  // ── Build the context for this turn ──────────────────────────────────
  const snapshot = await buildHotelSnapshot(body.propertyId, userCtx.role, staffId);
  const systemPrompt = buildSystemPrompt(userCtx.role, snapshot);
  const tools = getToolsForRole(userCtx.role);

  // ── Stream the agent response via SSE ────────────────────────────────
  const encoder = new TextEncoder();
  let finalUsage: UsageReport | null = null;
  let lastDoneText = '';
  // In-flight tool_call ids whose tool_result hasn't been persisted yet.
  // On stream abort or crash, we drain this set into synthetic error rows
  // so the next replay isn't broken by dangling tool_use blocks.
  const pendingToolCallIds = new Set<string>();

  const finalConversationId = conversationId;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // Controller closed (client disconnected). The finally block will clean up.
        }
      };

      send({ type: 'conversation_id', id: finalConversationId });

      try {
        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage: body.message,
          tools,
          // Codex adversarial review 2026-05-13 (A-C3): forward the request
          // abort signal into the agent loop so client disconnects stop
          // burning Anthropic tokens. The streamAgent internals check
          // signal.aborted between iterations and between tool calls.
          abortSignal: req.signal,
          toolContext: {
            user: userCtx,
            propertyId: body.propertyId,
            staffId,
            requestId,
          },
        });

        for await (const event of iter) {
          // assistant_turn is a persistence signal only — never forwarded.
          // `done` is held until the final assistant turn is durably saved
          // so the client never sees "success" for a message that failed
          // to persist (Codex review fix C4).
          //
          // Codex round-5 fix R1: `error` events now carry a `usage`
          // payload when the iter-cap was hit or any prior iteration
          // completed before the throw. Forward the error to the client
          // BUT strip the `usage` field — that's an internal signal for
          // the finally block to finalize the reservation.
          if (event.type === 'assistant_turn') {
            // Codex fix #2: throw on failure rather than continuing.
            // recordAssistantTurn uses an atomic RPC; if it fails, the
            // assistant text + tool_use rows aren't safely on disk and
            // running the tools would leave orphan tool_result rows.
            await recordAssistantTurn(
              finalConversationId,
              event.text,
              event.toolCalls.length ? event.toolCalls : undefined,
              {
                tokensIn: event.usage.inputTokens,
                tokensOut: event.usage.outputTokens,
                modelUsed: event.usage.model,
                modelId: event.usage.modelId,
                costUsd: event.usage.costUsd,
                promptVersion: PROMPT_VERSION,
              },
            );
            // Register every tool_call id from this iteration as in-flight.
            // They'll be cleared as their results stream in.
            for (const call of event.toolCalls) {
              pendingToolCallIds.add(call.id);
            }
          } else if (event.type === 'tool_call_finished') {
            await recordToolResult(finalConversationId, event.call.id, event.result).catch(err => {
              console.error('[agent/command] failed to persist tool result', err);
            });
            pendingToolCallIds.delete(event.call.id);
            send(event);
          } else if (event.type === 'done') {
            finalUsage = event.usage;
            lastDoneText = event.finalText;
          } else if (event.type === 'error') {
            // Codex A-C7 (cbc4228) + round-5 R1: error events may carry
            // accumulated usage (runaway tool loops, abort-after-spend,
            // mid-stream exception). Promote so the finally FINALIZES the
            // reservation against actual spend instead of cancelling and
            // leaking the cost. Strip the usage from the client-bound
            // event — it's an internal signal.
            if (event.usage) finalUsage = event.usage;
            send({ type: 'error', message: event.message });
          } else {
            send(event);
          }
        }

        // Persist the FINAL assistant text turn BEFORE forwarding the
        // `done` event to the client. If this throws, the catch block
        // sends an error event — the client never gets a misleading
        // success terminal (Codex review fix C4, 2026-05-13).
        if (lastDoneText) {
          await recordAssistantTurn(
            finalConversationId,
            lastDoneText,
            undefined,
            {
              tokensIn: finalUsage?.inputTokens ?? 0,
              tokensOut: finalUsage?.outputTokens ?? 0,
              modelUsed: finalUsage?.model ?? 'sonnet',
              modelId: finalUsage?.modelId ?? null,
              costUsd: finalUsage?.costUsd ?? 0,
              promptVersion: PROMPT_VERSION,
            },
          );
        }

        // Final assistant turn is now durable. Emit the held `done` event
        // so the client knows the response is complete.
        if (finalUsage) {
          send({ type: 'done', usage: finalUsage, finalText: lastDoneText });
        }
      } catch (err) {
        // Includes errors thrown from recordAssistantTurn (Fix #2). The
        // finally block handles cleanup of the cost reservation + any
        // dangling tool_use rows.
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        // ── Fix #3 cleanup: synthesize tool_result rows for any tool_use
        // that didn't get a matching result before the stream ended. This
        // keeps the conversation history valid for the next replay.
        //
        // Round-8 fix B7 (2026-05-13): post-0094 unique index on
        // (conversation_id, tool_call_id) for role='tool', a plain insert
        // would throw a constraint violation if the result actually landed
        // earlier in the stream but pendingToolCallIds wasn't cleared in
        // time. recordSyntheticAbortToolResult uses ON CONFLICT DO NOTHING
        // so existing rows are left alone — silent + idempotent. ──
        if (pendingToolCallIds.size > 0) {
          await Promise.allSettled(
            Array.from(pendingToolCallIds).map(toolCallId =>
              recordSyntheticAbortToolResult(finalConversationId, toolCallId, {
                ok: false,
                error: 'aborted — tool result was not captured before the stream ended',
              }).catch(err => {
                console.error('[agent/command] failed to insert synthetic abort result', err);
              }),
            ),
          );
        }

        // ── Fix #1 cleanup: reconcile the cost reservation. If the stream
        // completed and gave us a usage report, finalize to actual spend.
        // Otherwise cancel (release the budget hold).
        //
        // Codex review fix M1 (2026-05-13): finalizeCostReservation now
        // throws on RPC error. If it does, we attempt a cancel to release
        // the budget hold (better than leaving the row stuck in 'reserved'
        // state forever, inflating future cap checks). The user has
        // already received their response via the `done` event emitted
        // above; we're just losing the actual-cost record. ──
        if (finalUsage) {
          try {
            await finalizeCostReservation({
              reservationId,
              conversationId: finalConversationId,
              actualUsd: finalUsage.costUsd,
              model: finalUsage.model,
              modelId: finalUsage.modelId,
              tokensIn: finalUsage.inputTokens,
              tokensOut: finalUsage.outputTokens,
              cachedInputTokens: finalUsage.cachedInputTokens,
              // Codex round-7 fix F1: passed through so the audit-row
              // fallback (agent_cost_finalize_failures) can record the
              // user + property when retries are exhausted.
              userId: userCtx.accountId,
              propertyId: body.propertyId,
            });
          } catch (finalizeErr) {
            console.error('[agent/command] finalize failed after retries; cancelling to release budget hold (audit row written)', finalizeErr);
            await cancelCostReservation(reservationId).catch(cancelErr => {
              console.error('[agent/command] cancel also failed; reservation will be stranded', cancelErr);
            });
          }
        } else {
          await cancelCostReservation(reservationId);
        }

        try {
          controller.close();
        } catch {
          // Already closed (e.g. client disconnected first). Ignore.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-request-id': requestId,
      'x-accel-buffering': 'no',
    },
  });
}
