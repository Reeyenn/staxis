// ─── POST /api/agent/command/resolve-action ─────────────────────────────────
//
// The approval decision endpoint. When the user taps Approve or Deny on an AI
// action card, the browser POSTs here. This route:
//
//   1. Loads the pending row and verifies it belongs to THIS caller's property
//      + conversation, is still pending, and hasn't expired (single-use).
//   2. On approve: validates any adjustedArgs against the tool's input schema,
//      executes the tool via executeTool with a rebuilt ToolContext, stores the
//      result, runs any selected add-ons.
//      On deny: marks the row denied.
//   3. Persists the mutation's tool_result to agent_messages so the assistant
//      tool_use block gets its matching result (approved → real JSON, denied →
//      "declined", failed → the error).
//   4. When EVERY action in the assistant turn (turn_key) is resolved, RESUMES
//      the model: a fresh streamAgent(newUserMessage: null) continues from the
//      now-complete tool_results and streams its follow-up back as SSE.
//
// It streams SSE exactly like /api/agent/command so the client consumes it with
// the same reader. The one new event is `action_result` (the card's outcome),
// emitted before the model's follow-up text.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';

import { streamAgent, type AgentMessage } from '@/lib/agent/llm';
import { executeTool, getTool, getToolsForRole, type ToolContext } from '@/lib/agent/tools';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { retrieveMemoryForTurn } from '@/lib/agent/memory-context';
import { loadConversation, recordToolResult } from '@/lib/agent/memory';
import {
  reserveCostBudget,
  finalizeCostReservation,
  cancelCostReservation,
} from '@/lib/agent/cost-controls';
import {
  getPendingAction,
  claimPendingAction,
  finalizePendingAction,
  expireIfStale,
  getTurnActions,
  allActionsResolved,
  claimTurnResume,
  expiredWithoutResult,
  createPendingActions,
} from '@/lib/agent/pending-actions';
import { buildActionSummary, addonDescriptorsForCard, findAddon } from '@/lib/agent/approval';
import { validateToolArgs } from '@/lib/agent/validate-tool-args';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';

import {
  runAgentStream,
  finishAgentStream,
  drainDanglingToolCalls,
} from '../_stream-runner';

import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RequestBody {
  pid: string;
  pendingActionId: string;
  decision: 'approve' | 'deny';
  /** Optional edited args (the card's "Adjust" panel). Validated before use. */
  adjustedArgs?: Record<string, unknown>;
  /** Add-on ids the user checked (deterministic extras — see approval.ts). */
  addons?: string[];
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json', requestId }, { status: 400 });
  }
  if (!body.pid || !body.pendingActionId || (body.decision !== 'approve' && body.decision !== 'deny')) {
    return Response.json({ ok: false, error: 'pid, pendingActionId and decision are required', requestId }, { status: 400 });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, body.pid);
  if (!hasAccess) {
    return Response.json({ ok: false, error: 'no access to this property', requestId }, { status: 403 });
  }

  // ── Load the caller's account row + role ──────────────────────────────
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

  // ── Resolve staff.id + department (all roles — comms tools post as caller) ─
  let staffId: string | null = null;
  {
    const { data: staffRow } = await supabaseAdmin
      .from('staff')
      .select('id, department')
      .eq('auth_user_id', userCtx.uid)
      .eq('property_id', body.pid)
      .maybeSingle();
    staffId = (staffRow?.id as string) ?? null;
    userCtx.dept = (staffRow?.department as string | null) ?? null;
  }

  // ── Load + validate the pending action ────────────────────────────────
  const pending = await getPendingAction(body.pendingActionId);
  if (!pending) {
    return Response.json({ ok: false, error: 'that action was not found', requestId }, { status: 404 });
  }
  // Scope: must belong to THIS property, conversation-owner, and caller.
  if (pending.propertyId !== body.pid || pending.accountId !== userCtx.accountId) {
    // Same 404 as not-found — never confirm the existence of another user's row.
    return Response.json({ ok: false, error: 'that action was not found', requestId }, { status: 404 });
  }
  // Single-use: expire lazily, then refuse anything not pending.
  if (pending.status === 'pending' && (await expireIfStale(pending))) {
    return Response.json({ ok: false, error: 'that action expired — ask again to redo it', code: 'expired', requestId }, { status: 409 });
  }
  if (pending.status !== 'pending') {
    return Response.json({ ok: false, error: 'that action was already handled', code: pending.status, requestId }, { status: 409 });
  }

  // Verify the conversation belongs to this caller (defence-in-depth beyond
  // account_id equality above) + get its property scope for the tool context.
  const convo = await loadConversation(pending.conversationId, userCtx.accountId);
  if (!convo || convo.propertyId !== body.pid) {
    return Response.json({ ok: false, error: 'that action was not found', requestId }, { status: 404 });
  }

  // ── Reserve cost budget for the possible model resume ─────────────────
  const reservation = await reserveCostBudget({ userId: userCtx.accountId, propertyId: body.pid });
  if (!reservation.ok) {
    return Response.json({ ok: false, error: reservation.message, code: reservation.reason, requestId }, { status: 429 });
  }
  const reservationId = reservation.reservationId;

  // ── Claim the row (single-use) ────────────────────────────────────────
  const claimed = await claimPendingAction(pending.id, body.decision === 'approve' ? 'approved' : 'denied');
  if (!claimed) {
    await cancelCostReservation(reservationId);
    return Response.json({ ok: false, error: 'that action was already handled', code: 'race', requestId }, { status: 409 });
  }

  const toolCtx: ToolContext = {
    user: userCtx,
    propertyId: body.pid,
    staffId,
    requestId,
    surface: 'chat',
    conversationId: pending.conversationId,
  };

  // ── Execute (approve) or record decline (deny) ────────────────────────
  let actionOk = false;
  let actionError: string | null = null;
  // The content that becomes this tool_use's tool_result on resume.
  let toolResultForModel: unknown;
  let toolResultIsError = false;
  const addonNotes: string[] = [];
  const addonErrors: string[] = [];

  if (body.decision === 'deny') {
    await finalizePendingAction({ id: pending.id, status: 'failed', error: 'declined by user' });
    toolResultForModel = 'The user declined this action.';
    toolResultIsError = true;
  } else {
    // Approve — validate adjustedArgs (if any) against the tool's schema.
    let effectiveArgs = pending.toolArgs;
    if (body.adjustedArgs && typeof body.adjustedArgs === 'object') {
      const tool = getTool(pending.toolName);
      if (!tool) {
        actionError = 'That tool is no longer available.';
      } else {
        // Merge edits over the original args, then validate the merged object.
        const merged = { ...pending.toolArgs, ...body.adjustedArgs };
        const v = validateToolArgs(tool, merged);
        if (!v.ok) {
          actionError = v.error;
        } else {
          // Overlay the VALIDATED (schema-clean) args back onto the ORIGINAL
          // proposal so any originally-proposed arg the tool doesn't declare in
          // its inputSchema.properties survives the edit — otherwise
          // approve-with-edit would silently execute with fewer args than
          // approve-as-is (code-review finding). validateToolArgs already
          // dropped unknown keys the CLIENT tried to smuggle in adjustedArgs;
          // this merge only re-adds keys that were in the model's own proposal.
          effectiveArgs = { ...pending.toolArgs, ...v.args };
        }
      }
    }

    if (actionError) {
      // A bad edit doesn't consume the action — but we've already claimed it
      // 'approved'. Roll it back to failed with the validation error so the
      // model sees a clean tool_result and can re-propose.
      await finalizePendingAction({ id: pending.id, status: 'failed', error: actionError });
      toolResultForModel = actionError;
      toolResultIsError = true;
    } else {
      const res = await executeTool(pending.toolName, effectiveArgs, toolCtx);
      actionOk = res.ok;
      actionError = res.ok ? null : (res.error ?? 'Tool failed without a message');
      toolResultForModel = res.ok ? (res.data ?? null) : actionError;
      toolResultIsError = !res.ok;
      await finalizePendingAction({
        id: pending.id,
        status: res.ok ? 'executed' : 'failed',
        result: res.ok ? res.data ?? null : null,
        error: res.ok ? null : actionError,
      });

      // ── Run selected add-ons (deterministic; failures never roll back the
      // primary action) ──
      if (res.ok && Array.isArray(body.addons) && body.addons.length > 0) {
        for (const addonId of body.addons) {
          const addon = findAddon(pending.toolName, addonId);
          if (!addon) continue;
          try {
            const out = await addon.run({
              propertyId: body.pid,
              callerStaffId: staffId,
              args: effectiveArgs,
              primaryResult: res.data ?? null,
              role: userCtx.role,
            });
            addonNotes.push(out.note);
          } catch (err) {
            log.error('[agent/resolve-action] add-on failed', { requestId, addonId, err });
            addonErrors.push(addonId);
          }
        }
      }
    }
  }

  // ── Persist the mutation's tool_result so the assistant tool_use has a
  // matching result on replay/resume. ──
  try {
    await recordToolResult(pending.conversationId, pending.toolCallId, toolResultForModel ?? null, toolResultIsError);
  } catch (err) {
    log.error('[agent/resolve-action] failed to persist tool result', { requestId, err });
    await cancelCostReservation(reservationId);
    return Response.json({ ok: false, error: 'could not save the action result', requestId }, { status: 500 });
  }

  // ── Are all sibling actions of this assistant turn resolved? ──────────
  // Lazily expire any still-pending sibling whose TTL has passed BEFORE the
  // resolved-check — otherwise a sibling the user simply ignored would sit in
  // 'pending' forever (expireIfStale is per-request; nobody resolves an ignored
  // card), so canResume would never become true and the turn would hang. After
  // this sweep every stale sibling is 'expired' (terminal), and the resume path
  // synthesizes tool_results for those before continuing.
  let siblings = await getTurnActions(pending.conversationId, pending.turnKey);
  const staleSiblings = siblings.filter((s) => s.status === 'pending' && new Date(s.expiresAt).getTime() <= Date.now());
  if (staleSiblings.length > 0) {
    await Promise.all(staleSiblings.map((s) => expireIfStale(s).catch(() => false)));
    siblings = await getTurnActions(pending.conversationId, pending.turnKey);
  }
  const canResume = allActionsResolved(siblings);

  // Build the client-facing result summary for the card confirmation.
  const summaryEn = buildActionSummary(pending.toolName, pending.toolArgs, 'en');
  const summaryEs = buildActionSummary(pending.toolName, pending.toolArgs, 'es');
  const resultSummary = {
    en: body.decision === 'deny'
      ? 'Action cancelled'
      : actionOk ? summaryEn : (actionError ?? 'Action failed'),
    es: body.decision === 'deny'
      ? 'Accion cancelada'
      : actionOk ? summaryEs : (actionError ?? 'La accion fallo'),
  };

  // ── Stream the response (action_result, then the model's follow-up) ──
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch { /* client disconnected */ }
      };

      send({ type: 'conversation_id', id: pending.conversationId });
      send({
        type: 'action_result',
        pendingActionId: pending.id,
        toolName: pending.toolName,
        ok: body.decision === 'deny' ? true : actionOk,
        denied: body.decision === 'deny',
        resultSummary,
        error: toolResultIsError && body.decision !== 'deny' ? { en: actionError, es: actionError } : undefined,
        addonNotes,
        addonErrors,
      });

      const runnerCtx = {
        conversationId: pending.conversationId,
        requestId,
        promptVersion: 'resume',
        send,
      };
      // Route-owned so the finally block drains dangling tool_use rows even if
      // runAgentStream throws mid-loop.
      const pendingToolCallIds = new Set<string>();
      let result: Awaited<ReturnType<typeof runAgentStream>> | null = null;

      try {
        if (!canResume) {
          // Other sibling actions in this turn are still pending — the model
          // can't continue until they're all resolved. Just confirm this
          // card; the client keeps showing the remaining cards.
          await cancelCostReservation(reservationId);
          try { controller.close(); } catch { /* noop */ }
          return;
        }

        // ── Single-flight resume claim (code-review finding: concurrency) ──
        // Two sibling cards approved at the same instant would each read
        // canResume=true and BOTH resume (double-bill + racing writes), or —
        // with the opposite interleaving — both see a not-yet-committed sibling
        // and NEITHER resumes (turn hangs). claimTurnResume stamps every row of
        // the turn in one atomic UPDATE; only the winner gets rows back.
        const claimedRows = await claimTurnResume(pending.conversationId, pending.turnKey);
        if (!claimedRows) {
          // Another resolver already claimed the resume — back off cleanly.
          await cancelCostReservation(reservationId);
          try { controller.close(); } catch { /* noop */ }
          return;
        }

        // ── Synthesize tool_results for EXPIRED siblings (code-review finding) ──
        // An 'expired' sibling is terminal (allActionsResolved) but the route
        // never wrote it a tool_result (unlike executed/failed/denied). Without
        // one, the replayed assistant turn carries a dangling tool_use and
        // Anthropic rejects it. Persist a synthetic "expired" result per
        // expired sibling BEFORE loading history. Idempotent via the
        // (conversation_id, tool_call_id) unique index.
        for (const stale of expiredWithoutResult(claimedRows)) {
          await recordToolResult(
            pending.conversationId,
            stale.toolCallId,
            'This action expired before the user approved it.',
            true,
          ).catch((err) => {
            log.error('[agent/resolve-action] failed to persist expired-sibling result', { requestId, err });
          });
        }

        // Rebuild the turn's context and resume the model from the now-complete
        // tool_results. RELOAD history fresh here — the `convo` loaded above for
        // the ownership check predates the recordToolResult write, so its
        // messages would be missing the just-persisted tool_result and the
        // resumed request would have a dangling tool_use.
        const freshConvo = await loadConversation(pending.conversationId, userCtx.accountId);
        const history: AgentMessage[] = freshConvo?.messages ?? convo.messages;
        const [snapshot, memoryBlock] = await Promise.all([
          buildHotelSnapshot(body.pid, userCtx.role, staffId),
          retrieveMemoryForTurn(body.pid, userCtx.accountId),
        ]);
        const systemPrompt = await buildSystemPrompt(userCtx.role, snapshot, pending.conversationId, undefined, memoryBlock);
        runnerCtx.promptVersion = systemPrompt.versionLabel;
        const tools = getToolsForRole(userCtx.role, 'chat');

        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage: null, // RESUME — no new user turn; history ends with tool_results
          tools,
          approvalMode: true,
          abortSignal: req.signal,
          toolContext: toolCtx,
        });

        result = await runAgentStream(iter, runnerCtx, {
          pendingToolCallIds,
          // If the follow-up proposes MORE mutations, gate them too (one at a
          // time). Same handler shape as the command route.
          onPendingApproval: async (ev) => {
            const [row] = await createPendingActions({
              propertyId: body.pid,
              conversationId: pending.conversationId,
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

        await finishAgentStream(result, runnerCtx);
      } catch (err) {
        log.error('[agent/resolve-action] resume stream threw', { requestId, reservationId, err });
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        await drainDanglingToolCalls(pendingToolCallIds, runnerCtx);

        const finalUsage = result?.finalUsage ?? result?.lastTurnUsage ?? null;
        if (finalUsage) {
          try {
            await finalizeCostReservation({
              reservationId,
              conversationId: pending.conversationId,
              actualUsd: finalUsage.costUsd,
              model: finalUsage.model,
              modelId: finalUsage.modelId,
              tokensIn: finalUsage.inputTokens,
              tokensOut: finalUsage.outputTokens,
              cachedInputTokens: finalUsage.cachedInputTokens,
              userId: userCtx.accountId,
              propertyId: body.pid,
            });
          } catch (finalizeErr) {
            log.error('[agent/resolve-action] finalize failed; cancelling', { requestId, reservationId, finalizeErr });
            await cancelCostReservation(reservationId).catch(() => undefined);
          }
        } else {
          await cancelCostReservation(reservationId);
        }

        try { controller.close(); } catch { /* noop */ }
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
