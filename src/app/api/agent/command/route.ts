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
import { getOrMintRequestId, log } from '@/lib/log';

import { streamAgent, type AgentMessage } from '@/lib/agent/llm';
import { getToolsForRole } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt, PROMPT_VERSION } from '@/lib/agent/prompts';
import { retrieveMemoryForTurn } from '@/lib/agent/memory-context';
import {
  createConversation,
  lockLoadAndRecordUserTurn,
  recordUserTurn,
} from '@/lib/agent/memory';
import {
  reserveCostBudget,
  finalizeCostReservation,
  cancelCostReservation,
} from '@/lib/agent/cost-controls';
import { createPendingActions } from '@/lib/agent/pending-actions';
import { buildActionSummary, addonDescriptorsForCard } from '@/lib/agent/approval';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';

import {
  runAgentStream,
  finishAgentStream,
  drainDanglingToolCalls,
} from './_stream-runner';

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
    dept: null as string | null,
  };

  // ── Resolve staff.id + department ────────────────────────────────────
  // `rooms.assigned_to` references `staff.id`, not `accounts.id` — Codex
  // review fix #4. Look it up by `staff.auth_user_id = user.uid`. We also
  // pull `department` here to gate 'dept'-scoped knowledge documents in the
  // search_knowledge tool (managers don't need it — role short-circuits the
  // gate).
  //
  // Approval-cards feature: the new comms tools (send_message, create_todo,
  // add_logbook_entry) post AS the caller, so they need staffId for EVERY
  // role, not just floor roles. We now resolve it for all roles. To keep the
  // prior rooms.assigned_to scoping behaviour intact, front_desk's staffId is
  // still suppressed for room mutations — that scoping lives in
  // assertFloorRoleCanMutateRoom, which only gates housekeeping/maintenance,
  // so surfacing front_desk's staffId here is safe (it's used by the comms
  // tools, not the room-mutation scope check).
  let staffId: string | null = null;
  {
    const { data: staffRow } = await supabaseAdmin
      .from('staff')
      .select('id, department')
      .eq('auth_user_id', userCtx.uid)
      .eq('property_id', body.propertyId)
      .maybeSingle();
    staffId = (staffRow?.id as string) ?? null;
    userCtx.dept = (staffRow?.department as string | null) ?? null;
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
    log.error('[agent/command] failed to prepare conversation', { requestId, reservationId, e });
    await cancelCostReservation(reservationId);
    return Response.json(
      { ok: false, error: 'failed to prepare conversation', requestId, details: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  // ── Build the context for this turn ──────────────────────────────────
  // L2 (2026-05-13): buildSystemPrompt is now async and takes
  // conversationId (preserved on the signature for future per-conv
  // routing; today the prompts-store always returns the single
  // globally-active row).
  // Build the live snapshot and the hotel's long-term memory in parallel; both
  // feed the DYNAMIC prompt block. Memory retrieval is non-fatal (returns '').
  const [snapshot, memoryBlock] = await Promise.all([
    buildHotelSnapshot(body.propertyId, userCtx.role, staffId),
    retrieveMemoryForTurn(body.propertyId, userCtx.accountId),
  ]);
  const systemPrompt = await buildSystemPrompt(userCtx.role, snapshot, conversationId, undefined, memoryBlock);
  const tools = getToolsForRole(userCtx.role, 'chat');

  // ── Stream the agent response via SSE ────────────────────────────────
  const encoder = new TextEncoder();
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

      const runnerCtx = {
        conversationId: finalConversationId,
        requestId,
        promptVersion: systemPrompt.versionLabel,
        send,
      };
      // Route-owned so the finally block drains dangling tool_use rows even if
      // runAgentStream throws mid-loop (before returning `result`).
      const pendingToolCallIds = new Set<string>();
      // Set by runAgentStream — the finally block reconciles the cost hold.
      let result: Awaited<ReturnType<typeof runAgentStream>> | null = null;

      try {
        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage: body.message,
          tools,
          // Approval-cards feature: mutation tool_use blocks are proposed
          // (pending row + card), NOT executed inline. Read-only tools still
          // run inline.
          approvalMode: true,
          // Codex adversarial review 2026-05-13 (A-C3): forward the request
          // abort signal into the agent loop so client disconnects stop
          // burning Anthropic tokens.
          abortSignal: req.signal,
          toolContext: {
            user: userCtx,
            propertyId: body.propertyId,
            staffId,
            requestId,
            surface: 'chat',
            conversationId: finalConversationId,
          },
        });

        result = await runAgentStream(iter, runnerCtx, {
          pendingToolCallIds,
          // Persist a pending row per proposed mutation + stream the card. The
          // browser renders it and POSTs /api/agent/command/resolve-action on
          // the user's decision.
          onPendingApproval: async (ev) => {
            const [row] = await createPendingActions({
              propertyId: body.propertyId,
              conversationId: finalConversationId,
              accountId: userCtx.accountId,
              turnKey: ev.turnKey,
              actions: [{ toolCallId: ev.call.id, toolName: ev.call.name, toolArgs: ev.call.args, tier: ev.tier }],
            });
            if (!row) return;
            send({
              type: 'tool_call_pending_approval',
              pendingActionId: row.id,
              toolCallId: ev.call.id,
              toolName: ev.call.name,
              args: ev.call.args,
              tier: ev.tier,
              // Both languages so the client picks by useLang() without a round-trip.
              summary: {
                en: buildActionSummary(ev.call.name, ev.call.args, 'en'),
                es: buildActionSummary(ev.call.name, ev.call.args, 'es'),
              },
              addons: {
                en: addonDescriptorsForCard(ev.call.name, ev.call.args, 'en'),
                es: addonDescriptorsForCard(ev.call.name, ev.call.args, 'es'),
              },
            });
          },
        });

        // Persist the final assistant text turn + emit the held `done`
        // (skipped when the turn ended by proposing approval cards).
        await finishAgentStream(result, runnerCtx);
      } catch (err) {
        log.error('[agent/command] stream loop threw', {
          requestId, conversationId: finalConversationId, reservationId, err,
        });
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        // Synthesize error tool_result rows for any dangling tool_use. Uses the
        // route-owned set so a mid-loop throw is still covered.
        await drainDanglingToolCalls(pendingToolCallIds, runnerCtx);

        // ── Reconcile the cost reservation. Finalize to actual spend when we
        // have a usage report. A turn that ended by proposing approval cards
        // has no `done`/usage — but the model DID spend tokens on the proposal,
        // so we finalize against the last assistant_turn usage instead of
        // cancelling and losing that spend. The model's FOLLOW-UP (after the
        // user decides) reserves its own budget on the resolve route. ──
        const finalUsage = result?.finalUsage ?? result?.lastTurnUsage ?? null;
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
              userId: userCtx.accountId,
              propertyId: body.propertyId,
            });
          } catch (finalizeErr) {
            log.error('[agent/command] finalize failed after retries; cancelling to release budget hold (audit row written)', {
              requestId, conversationId: finalConversationId, reservationId, finalizeErr,
            });
            await cancelCostReservation(reservationId).catch(cancelErr => {
              log.error('[agent/command] cancel also failed; reservation will be stranded', {
                requestId, conversationId: finalConversationId, reservationId, cancelErr,
              });
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
