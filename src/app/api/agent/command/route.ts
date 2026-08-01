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
// is the absolute 55-second execution deadline shared by every provider
// attempt and fallback in `src/lib/agent/llm.ts`. Treat the disconnect signal
// as best effort; the shared deadline is the deterministic route ceiling.

import type { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';

import {
  ASK_STAXIS_EXECUTION_BUDGET_MS,
  ASK_STAXIS_FALLBACK_RESERVE_MS,
  resolveAskStaxisExecutionPlan,
  resolveCompanionChatExecutionPlan,
  streamAgent,
  type AgentMessage,
} from '@/lib/agent/llm';
import { scaleAiReservationUsd, type AiExecutionPlan } from '@/lib/ai/runtime';
import type { AiFeatureKey } from '@/lib/ai/types';
import { anthropicTierTokenRates } from '@/lib/ai/feature-registry';
import { getToolsForRole } from '@/lib/agent/tools';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { requireSectionEnabled } from '@/lib/sections/server';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildAwareness, formatAwarenessForPrompt } from '@/lib/agent/awareness';
import { buildSystemPrompt, PROMPT_VERSION } from '@/lib/agent/prompts';
import { retrieveMemoryForTurn } from '@/lib/agent/memory-context';
import {
  createConversation,
  loadConversationScope,
  lockLoadAndRecordUserTurn,
  recordUserTurn,
} from '@/lib/agent/memory';
import {
  reserveCostBudget,
  cancelCostReservation,
  COST_LIMITS,
} from '@/lib/agent/cost-controls';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';

import {
  runAgentStream,
  finishAgentStream,
  drainDanglingToolCalls,
  loadAgentUserCtx,
  makePendingApprovalHandler,
  reconcileCostReservation,
  sweepSupersededPending,
} from './_stream-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RequestBody {
  conversationId?: string;
  propertyId: string;
  message: string;
  /**
   * The route the browser is on, e.g. '/inventory'.
   *
   * OPTIONAL, and it stays optional forever. Making it required would break the
   * approval-resume path and the lens integration suite, which build a request
   * by hand — and more importantly a chat turn must never fail because a client
   * did not tell us what screen it was on. Absent simply means the awareness
   * block says nothing about the screen.
   *
   * UNTRUSTED. Never interpolated into the prompt: `resolveSurface` matches it
   * against an allowlist and prints that table's own constant. See
   * src/lib/agent/awareness.ts.
   */
  pathname?: string;
  /**
   * Which surface this turn came from.
   *
   * OPTIONAL, and absent means the Ask Staxis bar, which is every existing
   * caller. The ONLY thing it changes is which AI Control Center slot governs
   * the model and carries the cost: 'companion' turns run on
   * `companion.conversation`, everything else on `agent.ask_staxis`.
   *
   * UNTRUSTED, and safely so. It cannot widen anything: the auth, the property
   * access, the section gate, the role lens and the tool catalog are all
   * resolved before this is read, and both slots resolve through the same
   * registry with the same pricing requirement. The worst a forged value can do
   * is bill a turn to the wrong line of Reeyen's own cost book.
   */
  origin?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const executionDeadlineAt = Date.now() + ASK_STAXIS_EXECUTION_BUDGET_MS;

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
  const sectionGate = await requireSectionEnabled(req, body.propertyId, 'staxis');
  if (!sectionGate.ok) return sectionGate.response;

  // ── Load account row + role + staff.id + department (shared with resolve) ─
  // Approval-cards feature: the new comms tools (send_message, create_todo,
  // add_logbook_entry) post AS the caller, so staffId is resolved for EVERY
  // role, not just floor roles. Room-mutation scoping is unaffected — that gate
  // lives in assertFloorRoleCanMutateRoom, which only checks housekeeping/
  // maintenance, so surfacing every role's staffId here is safe.
  const ctxLoad = await loadAgentUserCtx(auth.userId, body.propertyId);
  if (!ctxLoad.ok) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  const { userCtx, staffId, companyOrganizationId } = ctxLoad;

  // ── WHO LENSES: the hat at THIS hotel decides whether there is a chat ──
  // Housekeeping has no Ask Staxis, by product rule: their whole surface is the
  // room card on the phone they already carry, and the standing rule is that
  // Staxis never adds a step to that job. Refused HERE, before the cost
  // reservation, so an unmounted hat can never spend a cent. The bar does not
  // render for them either — this is the door behind the door.
  if (!chatIsMountedForRole(userCtx.role)) {
    return Response.json(
      { ok: false, error: 'Ask Staxis is not part of this role at this hotel.', code: 'chat_not_mounted', requestId },
      { status: 403 },
    );
  }

  // A conversation id is an untrusted selector. Prove ownership, immutable
  // property scope, and conversation kind before model selection or budget
  // reservation. The atomic prep RPC repeats the same predicates before replay.
  let preflightConversationScope: Awaited<ReturnType<typeof loadConversationScope>> = null;
  if (body.conversationId) {
    try {
      preflightConversationScope = await loadConversationScope(
        body.conversationId,
        userCtx.accountId,
      );
    } catch {
      return Response.json(
        { ok: false, error: 'conversation authorization is unavailable', requestId },
        { status: 503 },
      );
    }
    if (!preflightConversationScope) {
      return Response.json(
        { ok: false, error: 'conversation not found or not yours', requestId },
        { status: 404 },
      );
    }
    if (preflightConversationScope.conversationKind !== 'property') {
      return Response.json(
        {
          ok: false,
          error: 'conversation belongs to portfolio mode',
          code: 'wrong_conversation_kind',
          requestId,
        },
        { status: 400 },
      );
    }
    if (preflightConversationScope.propertyId !== body.propertyId) {
      return Response.json(
        { ok: false, error: 'conversation is scoped to a different property', requestId },
        { status: 400 },
      );
    }
  }

  // ── Cost reservation (Codex review fix #1) ────────────────────────────
  // Atomic: cap check + reservation insert happen under an advisory lock
  // keyed on user_id. Concurrent requests for the same user serialize.
  const fromCompanion = body.origin === 'companion';
  const featureKey: AiFeatureKey = fromCompanion ? 'companion.conversation' : 'agent.ask_staxis';
  let estimatedUsd: number;
  let executionPlan: AiExecutionPlan;
  try {
    executionPlan = fromCompanion
      ? await resolveCompanionChatExecutionPlan()
      : await resolveAskStaxisExecutionPlan();
    estimatedUsd = scaleAiReservationUsd(
      [executionPlan.primary, executionPlan.fallback].filter(
        (model): model is NonNullable<typeof model> => model !== null,
      ),
      {
        usd: COST_LIMITS.estimatedRequestUsd,
        ...anthropicTierTokenRates('sonnet'),
      },
    );
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Ask Staxis is unavailable',
      requestId,
    }, { status: 503 });
  }
  const reservation = await reserveCostBudget({
    userId: userCtx.accountId,
    propertyId: body.propertyId,
    estimatedUsd,
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
  // IDs of approval cards this new turn superseded — emitted as an SSE event
  // once the stream opens so the browser drops any still-displayed cards.
  let supersededPendingIds: string[] = [];
  try {
    if (conversationId) {
      // Reject another security domain BEFORE the best-effort pending-action
      // sweep below can mutate it. The RPC repeats owner/kind/property checks
      // atomically before replay/append; this preflight protects the earlier
      // cleanup side effect, and conversation kind is DB-immutable.
      if (!preflightConversationScope) throw new Error('conversation preflight was not retained');

      // Sweep any still-pending approval cards BEFORE recording the new user
      // turn: sending a fresh message abandons the earlier proposals. Flipping
      // them to 'expired' + persisting a synthetic tool_result per tool_call_id
      // here (before the user-turn row exists) keeps the abandoned assistant
      // turn's tool_use blocks from dangling and stops an orphaned card from
      // being approved later. Best-effort — never blocks the new turn.
      supersededPendingIds = await sweepSupersededPending(conversationId, requestId);

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
        if (prep.reason === 'wrong_kind') {
          return Response.json({ ok: false, error: 'conversation belongs to portfolio mode', code: 'wrong_conversation_kind', requestId }, { status: 400 });
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
  // enabledSections drives the section gate: any tool tagged with a section the
  // hotel has turned OFF is dropped from the catalog (and refused in executeTool
  // as defense-in-depth). Reuse the exact map read by the fail-closed gate.
  const [snapshot, memoryBlock] = await Promise.all([
    buildHotelSnapshot(body.propertyId, userCtx.role, staffId),
    retrieveMemoryForTurn(body.propertyId, userCtx.accountId),
  ]);
  const enabledSections = sectionGate.enabledSections;

  // "Right now" — the screen, the hotel's clock, what this person has already
  // done today, what is waiting on them. Built AFTER the snapshot because it
  // reuses the snapshot's timezone and PMS-freshness gate rather than
  // re-deriving either. Never throws: every feed inside is settled
  // independently, so the worst case is a block with only the clock in it, and
  // the chat turn is unaffected.
  const awareness = await buildAwareness({
    propertyId: body.propertyId,
    role: userCtx.role,
    accountId: userCtx.accountId,
    authUserId: userCtx.uid,
    organizationId: companyOrganizationId,
    pathname: body.pathname,
    snapshot,
  });
  const systemPrompt = await buildSystemPrompt(
    userCtx.role,
    snapshot,
    conversationId,
    undefined,
    memoryBlock,
    new Date(),
    formatAwarenessForPrompt(awareness),
    userCtx,
  );
  const tools = getToolsForRole(
    userCtx.role,
    'chat',
    undefined,
    enabledSections,
    userCtx,
  );

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

      // Tell the browser to drop any approval cards this new message superseded.
      if (supersededPendingIds.length > 0) {
        send({
          type: 'pending_actions_superseded',
          conversationId: finalConversationId,
          pendingActionIds: supersededPendingIds,
        });
      }

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
          featureKey,
          executionPlan,
          deadlineAt: executionDeadlineAt,
          fallbackReserveMs: ASK_STAXIS_FALLBACK_RESERVE_MS,
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
            enabledSections,
          },
        });

        result = await runAgentStream(iter, runnerCtx, {
          pendingToolCallIds,
          // Persist a pending row per proposed mutation + stream the card. The
          // browser renders it and POSTs /api/agent/command/resolve-action on
          // the user's decision. Shared factory — same handler both routes use.
          onPendingApproval: makePendingApprovalHandler({
            propertyId: body.propertyId,
            conversationId: finalConversationId,
            accountId: userCtx.accountId,
            send,
            // Decision corpus (0350): the snapshot the model was shown this
            // turn is only in hand HERE. Persisting it is what makes "what did
            // the AI see when it proposed that" answerable later.
            corpus: {
              snapshot,
              actorRole: userCtx.role,
              promptVersion: systemPrompt.versionLabel,
            },
          }),
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
        // user decides) reserves its own budget on the resolve route. Shared
        // tail — same finalize→cancel ladder both routes run. ──
        await reconcileCostReservation({
          reservationId,
          conversationId: finalConversationId,
          finalUsage: result?.finalUsage ?? result?.lastTurnUsage ?? null,
          userId: userCtx.accountId,
          propertyId: body.propertyId,
          requestId,
          feature: 'agent.ask_staxis',
        });

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
