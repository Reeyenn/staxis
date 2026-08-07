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
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';

import {
  ASK_STAXIS_EXECUTION_BUDGET_MS,
  ASK_STAXIS_FALLBACK_RESERVE_MS,
  resolveAskStaxisExecutionPlan,
  streamAgent,
  type AgentMessage,
} from '@/lib/agent/llm';
import { scaleAiReservationUsd, type AiExecutionPlan } from '@/lib/ai/runtime';
import { anthropicTierTokenRates } from '@/lib/ai/feature-registry';
import { executeTool, getTool, getToolsForRole, type ToolContext } from '@/lib/agent/tools';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { getEnabledSectionsFresh, requireSectionEnabled } from '@/lib/sections/server';
import { isSectionEnabled } from '@/lib/sections/registry';
import { buildHotelSnapshot } from '@/lib/agent/context';
import { buildAwareness, formatAwarenessForPrompt } from '@/lib/agent/awareness';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { retrieveMemoryForTurn } from '@/lib/agent/memory-context';
import { loadConversation, recordToolResult } from '@/lib/agent/memory';
import {
  reserveCostBudget,
  cancelCostReservation,
  COST_LIMITS,
} from '@/lib/agent/cost-controls';
import {
  getPendingAction,
  claimPendingAction,
  finalizePendingAction,
  expireIfStale,
  getTurnActions,
  allActionsResolved,
  claimTurnResume,
  releaseTurnResume,
  expiredWithoutResult,
} from '@/lib/agent/pending-actions';
import { buildActionSummary, findAddon } from '@/lib/agent/approval';
import { validateToolArgs } from '@/lib/agent/validate-tool-args';
import { recordDecisionResolution, actorKindForDecision } from '@/lib/agent/decisions';
import { recordAgentJournalEntry, journalResolutionLine } from '@/lib/agent/journal';
// Side-effect import — registers all tools against the catalog.
import '@/lib/agent/tools/index';

import {
  runAgentStream,
  finishAgentStream,
  drainDanglingToolCalls,
  loadAgentUserCtx,
  makePendingApprovalHandler,
  reconcileCostReservation,
} from '../_stream-runner';

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

/**
 * Rebuild the complete hotel-chat authority at a delayed lifecycle boundary.
 * This deliberately does not accept a prior ToolContext: current membership,
 * current per-hotel role/capacity, and current section state all come from new
 * reads. A null result means stop before the next read or write.
 */
async function reauthorizeAgentScope(input: {
  authUserId: string;
  propertyId: string;
  expectedAccountId: string;
  /** Present for an add-on that would perform another hotel mutation. */
  mutationToolName?: string;
}) {
  const fresh = await loadAgentUserCtx(input.authUserId, input.propertyId);
  if (!fresh.ok
    || fresh.userCtx.accountId !== input.expectedAccountId
    || !chatIsMountedForRole(fresh.userCtx.role)) {
    return null;
  }

  let freshSections: Awaited<ReturnType<typeof getEnabledSectionsFresh>>;
  try {
    freshSections = await getEnabledSectionsFresh(input.propertyId);
  } catch {
    return null;
  }
  if (!isSectionEnabled(freshSections, 'staxis')) return null;

  if (input.mutationToolName) {
    const mutationTool = getTool(input.mutationToolName);
    const offeredNow = mutationTool
      ? getToolsForRole(
        fresh.userCtx.role,
        'chat',
        freshSections,
        fresh.userCtx,
      )
        .some((tool) => tool.name === mutationTool.name)
      : false;
    if (!mutationTool?.mutates
      || fresh.userCtx.hotelMutationAllowed !== true
      || !offeredNow) {
      return null;
    }
  }

  return {
    userCtx: fresh.userCtx,
    staffId: fresh.staffId,
    enabledSections: freshSections,
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const executionDeadlineAt = Date.now() + ASK_STAXIS_EXECUTION_BUDGET_MS;

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
  const sectionGate = await requireSectionEnabled(req, body.pid, 'staxis');
  if (!sectionGate.ok) return sectionGate.response;

  // ── Load account row + role + staff.id + department (shared with command) ─
  const ctxLoad = await loadAgentUserCtx(auth.userId, body.pid);
  if (!ctxLoad.ok) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  let { userCtx, staffId } = ctxLoad;
  // Same value the live chat turn reads from the same loader. Only the
  // company-queue feed of the awareness block uses it, and it is null for a
  // hotel-only person.
  const { companyOrganizationId } = ctxLoad;

  // WHO LENSES: same door as /api/agent/command. A hat with no chat cannot
  // resolve an approval card either — including one minted before the lens
  // existed, which is exactly the case a route-level check has to cover.
  if (!chatIsMountedForRole(userCtx.role)) {
    return Response.json(
      { ok: false, error: 'Ask Staxis is not part of this role at this hotel.', code: 'chat_not_mounted', requestId },
      { status: 403 },
    );
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
    return Response.json({ ok: false, error: 'that action expired. Ask again to redo it', code: 'expired', requestId }, { status: 409 });
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

  // ── Validate adjustedArgs BEFORE claiming the row (code-review finding) ──
  // An invalid edit must NOT consume the card. We validate FIRST and, on
  // failure, return 400 with the field error while leaving the row 'pending'
  // so the card stays up and the user can fix the edit. Only once the args are
  // known-good do we reserve budget + claim the row.
  //
  // effectiveArgs starts as the original proposal and is refined by any edit.
  let effectiveArgs: Record<string, unknown> = pending.toolArgs;
  if (body.decision === 'approve' && body.adjustedArgs && typeof body.adjustedArgs === 'object') {
    const tool = getTool(pending.toolName);
    if (!tool) {
      return Response.json({ ok: false, error: 'That tool is no longer available.', code: 'invalid_edit', requestId }, { status: 400 });
    }
    // Merge edits over the original args, then validate the merged object.
    const merged = { ...pending.toolArgs, ...(body.adjustedArgs as Record<string, unknown>) };
    const v = validateToolArgs(tool, merged);
    if (!v.ok) {
      // Card stays up (row untouched). Client surfaces v.error inline on Adjust.
      return Response.json({ ok: false, error: v.error, code: 'invalid_edit', requestId }, { status: 400 });
    }
    // Overlay the VALIDATED (schema-clean) args back onto the ORIGINAL proposal
    // so any originally-proposed arg the tool doesn't declare in its
    // inputSchema.properties survives the edit. validateToolArgs already dropped
    // unknown keys the CLIENT tried to smuggle in; this merge re-adds keys that
    // were in the model's own proposal.
    //
    // Adjust-clears-field semantics (code-review finding): an edit that
    // EXPLICITLY sets an OPTIONAL field to empty/null means "clear it".
    // validateToolArgs drops empty/null values, so without this the original
    // would be re-overlaid and the clear silently ignored. Detect optional keys
    // the user explicitly emptied and DELETE them from effectiveArgs. Required
    // fields already fail validation above with a clear message, so any key that
    // survived to here and was emptied is safe to drop.
    const required = new Set(tool.inputSchema.required ?? []);
    const cleared = new Set<string>();
    for (const [k, val] of Object.entries(body.adjustedArgs as Record<string, unknown>)) {
      if (required.has(k)) continue;
      const isEmpty = val === null || val === undefined || (typeof val === 'string' && val.trim() === '');
      if (isEmpty && k in (tool.inputSchema.properties ?? {})) cleared.add(k);
    }
    effectiveArgs = { ...pending.toolArgs, ...v.args };
    for (const k of cleared) delete effectiveArgs[k];
  }

  // ── Reserve cost budget for the possible model resume ─────────────────
  let estimatedUsd: number;
  let executionPlan: AiExecutionPlan;
  try {
    executionPlan = await resolveAskStaxisExecutionPlan();
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
    propertyId: body.pid,
    estimatedUsd,
  });
  if (!reservation.ok) {
    return Response.json({ ok: false, error: reservation.message, code: reservation.reason, requestId }, { status: 429 });
  }
  const reservationId = reservation.reservationId;

  // Delayed approvals are a new authorization event. Re-resolve immediately
  // before the single-use claim; the role/property array captured when the
  // card was proposed (or at the top of this request) is not commit authority.
  if (body.decision === 'approve') {
    const preClaimCtx = await loadAgentUserCtx(auth.userId, body.pid);
    if (!preClaimCtx.ok
      || preClaimCtx.userCtx.accountId !== userCtx.accountId
      || !chatIsMountedForRole(preClaimCtx.userCtx.role)) {
      await cancelCostReservation(reservationId);
      return Response.json({
        ok: false,
        error: 'Your access changed. Ask again from a hotel you can currently manage.',
        code: 'authorization_changed',
        requestId,
      }, { status: 403 });
    }
  }

  // ── Claim the row (single-use) ────────────────────────────────────────
  const claimed = await claimPendingAction(pending.id, body.decision === 'approve' ? 'approved' : 'denied');
  if (!claimed) {
    await cancelCostReservation(reservationId);
    return Response.json({ ok: false, error: 'that action was already handled', code: 'race', requestId }, { status: 409 });
  }

  // Re-resolve a second time AFTER the claim and immediately before the hotel
  // mutation. If revocation/transfer won the race between the pre-claim check
  // and claim, terminalize the card as failed and persist a matching tool
  // result; never leave an approved-but-unexecuted row that corrupts replay.
  let enabledSections = sectionGate.enabledSections;
  if (body.decision === 'approve') {
    const commitCtx = await loadAgentUserCtx(auth.userId, body.pid);
    let authorizationFailure: string | null = null;
    if (!commitCtx.ok
      || commitCtx.userCtx.accountId !== userCtx.accountId
      || !chatIsMountedForRole(commitCtx.userCtx.role)) {
      authorizationFailure = 'Authorization changed before the approved action could run.';
    } else {
      userCtx = commitCtx.userCtx;
      staffId = commitCtx.staffId;
      try {
        enabledSections = await getEnabledSectionsFresh(body.pid);
        if (!isSectionEnabled(enabledSections, 'staxis')) {
          authorizationFailure = 'Ask Staxis was disabled before the approved action could run.';
        }
      } catch {
        authorizationFailure = 'Current section authorization could not be verified.';
      }
    }
    if (authorizationFailure) {
      const decisionMs = Math.max(0, Date.now() - new Date(pending.createdAt).getTime());
      await finalizePendingAction({
        id: pending.id,
        status: 'failed',
        error: authorizationFailure,
        executedArgs: effectiveArgs,
        decisionMs,
      }).catch((error) => {
        log.error('[agent/resolve-action] failed to terminalize revoked approval', {
          requestId,
          pendingActionId: pending.id,
          error,
        });
      });
      await recordToolResult(
        pending.conversationId,
        pending.toolCallId,
        authorizationFailure,
        true,
      ).catch((error) => {
        log.error('[agent/resolve-action] failed to persist revoked approval result', {
          requestId,
          pendingActionId: pending.id,
          error,
        });
      });
      await cancelCostReservation(reservationId);
      return Response.json({
        ok: false,
        error: 'Your access changed before this action ran. Nothing was changed.',
        code: 'authorization_changed',
        requestId,
      }, { status: 409 });
    }
  }

  // The fresh map is fed into both executeTool and the resume catalog. Tool
  // role, lens, exact property reach and per-hotel capability are all checked
  // again by executeTool against the fresh user context below.
  const toolCtx: ToolContext = {
    user: userCtx,
    propertyId: body.pid,
    staffId,
    requestId,
    surface: 'chat',
    conversationId: pending.conversationId,
    enabledSections,
  };

  // ── Execute (approve) or record decline (deny) ────────────────────────
  let actionOk = false;
  let actionError: string | null = null;
  // The content that becomes this tool_use's tool_result on resume.
  let toolResultForModel: unknown;
  let toolResultIsError = false;
  const addonNotes: string[] = [];
  const addonErrors: string[] = [];

  // How long the card sat before the human decided. Free at write time and a
  // real signal — a 40-second pause on a one-tap action means the proposal was
  // not obviously right. Migration 0350.
  const decisionMs = Math.max(0, Date.now() - new Date(pending.createdAt).getTime());

  if (body.decision === 'deny') {
    // Deny is a TERMINAL 'denied' status — not 'failed'. A denial is a
    // first-class, queryable outcome (allActionsResolved treats 'denied' as
    // terminal; the DB CHECK allows it). Overwriting to 'failed' with a generic
    // error made denials indistinguishable from real execution failures.
    await finalizePendingAction({
      id: pending.id,
      status: 'denied',
      error: 'declined by user',
      executedArgs: null,
      decisionMs,
    });
    await recordDecisionResolution({
      propertyId: body.pid,
      pendingActionId: pending.id,
      actorKind: 'human_denied',
      actorAccountId: userCtx.accountId,
      executedArgs: null,
      decisionMs,
      error: 'declined by user',
    });
    // The hotel's own timeline learns that the companion asked and was told no.
    // A No is as much a fact about the day as a Yes, and it is the half that
    // used to leave no trace anywhere a manager could read.
    await recordAgentJournalEntry({
      propertyId: body.pid,
      eventType: 'agent_action_declined',
      description: journalResolutionLine({
        summary: buildActionSummary(pending.toolName, pending.toolArgs, 'en'),
        outcome: 'declined',
      }),
      actorAccountId: userCtx.accountId,
      actorRole: userCtx.role,
      targetType: 'tool',
      targetId: pending.toolName,
      metadata: { toolName: pending.toolName, pendingActionId: pending.id, decisionMs },
    });
    toolResultForModel = 'The user declined this action.';
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
      executedArgs: effectiveArgs,
      decisionMs,
    });
    // The corpus row learns what actually ran. args_diff (proposal vs executed
    // — the human-correction signal) is computed by a DB trigger, so no call
    // site can forget it.
    const approvedKind = actorKindForDecision('approve', pending.toolArgs, effectiveArgs);
    await recordDecisionResolution({
      propertyId: body.pid,
      pendingActionId: pending.id,
      actorKind: approvedKind,
      actorAccountId: userCtx.accountId,
      executedArgs: effectiveArgs,
      decisionMs,
      result: res.ok ? res.data ?? null : null,
      error: res.ok ? null : actionError,
    });
    // The same moment in plain English. The summary is built from the args that
    // ACTUALLY RAN, so an edited approval reads as what happened rather than as
    // what was first proposed.
    await recordAgentJournalEntry({
      propertyId: body.pid,
      eventType: res.ok
        ? (approvedKind === 'human_edited' ? 'agent_action_edited' : 'agent_action_approved')
        : 'agent_action_approved',
      description: journalResolutionLine({
        summary: buildActionSummary(pending.toolName, effectiveArgs, 'en'),
        outcome: res.ok ? (approvedKind === 'human_edited' ? 'edited' : 'approved') : 'failed',
      }),
      actorAccountId: userCtx.accountId,
      actorRole: userCtx.role,
      targetType: 'tool',
      targetId: pending.toolName,
      metadata: {
        toolName: pending.toolName,
        pendingActionId: pending.id,
        decisionMs,
        ok: res.ok,
      },
    });

    // ── Run selected add-ons (deterministic; failures never roll back the
    // primary action) ──
    if (res.ok && Array.isArray(body.addons) && body.addons.length > 0) {
      for (const addonId of body.addons) {
        const addon = findAddon(pending.toolName, addonId);
        if (!addon) continue;
        // Each add-on is a distinct write after the primary action. A transfer,
        // revocation, role downgrade, or section toggle that landed while the
        // primary handler ran must stop the add-on rather than inheriting the
        // primary handler's now-stale ToolContext.
        const addonAuthority = await reauthorizeAgentScope({
          authUserId: auth.userId,
          propertyId: body.pid,
          expectedAccountId: userCtx.accountId,
          mutationToolName: pending.toolName,
        });
        if (!addonAuthority) {
          log.warn('[agent/resolve-action] add-on refused after authority changed', {
            requestId,
            pendingActionId: pending.id,
            addonId,
          });
          addonErrors.push(addonId);
          continue;
        }
        userCtx = addonAuthority.userCtx;
        staffId = addonAuthority.staffId;
        enabledSections = addonAuthority.enabledSections;
        toolCtx.user = userCtx;
        toolCtx.staffId = staffId;
        toolCtx.enabledSections = enabledSections;
        // Add-ons create attributed work (a to-do "from" the caller). With no
        // caller staff identity we'd write an anonymous row — skip with a note
        // instead, mirroring the tools' own null-staffId refusal (item 8).
        if (!staffId) {
          addonErrors.push(addonId);
          continue;
        }
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

  // Build the client-facing result summary for the card confirmation. Use the
  // EDITED args (effectiveArgs) so the confirmation reflects what actually ran,
  // not the model's original proposal (code-review finding).
  const summaryEn = buildActionSummary(pending.toolName, effectiveArgs, 'en');
  const summaryEs = buildActionSummary(pending.toolName, effectiveArgs, 'es');
  const resultSummary = {
    en: body.decision === 'deny'
      ? 'Action cancelled'
      : actionOk ? summaryEn : (actionError ?? 'Action failed'),
    es: body.decision === 'deny'
      ? 'Acción cancelada'
      : actionOk ? summaryEs : (actionError ?? 'La acción falló'),
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
      // Set true once THIS request wins claimTurnResume. If the resume stream
      // then throws, the catch below best-effort clears resume_claimed_at so a
      // later resolve can claim again — otherwise the turn is permanently stuck
      // (nothing ever un-stamps the claim). Resume-crash recovery (item 5).
      let resumeClaimed = false;

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
        resumeClaimed = true;

        // The primary action is already terminal, but the resumed model would
        // read conversation history, hotel state and memory. Treat that as a
        // new authorization event after winning the resume claim. On failure,
        // release the claim for an authorized future resolver and emit no hotel
        // data or provider request from this stale approval request.
        const resumeAuthority = await reauthorizeAgentScope({
          authUserId: auth.userId,
          propertyId: body.pid,
          expectedAccountId: userCtx.accountId,
        });
        if (!resumeAuthority) {
          send({
            type: 'error',
            code: 'authorization_changed',
            message: 'The action result was saved, but your current hotel access could not be verified for the follow-up.',
          });
          await releaseTurnResume(pending.conversationId, pending.turnKey).catch((relErr) => {
            log.error('[agent/resolve-action] failed to release revoked resume claim', {
              requestId,
              relErr,
            });
          });
          resumeClaimed = false;
          await cancelCostReservation(reservationId);
          try { controller.close(); } catch { /* noop */ }
          return;
        }
        userCtx = resumeAuthority.userCtx;
        staffId = resumeAuthority.staffId;
        enabledSections = resumeAuthority.enabledSections;
        toolCtx.user = userCtx;
        toolCtx.staffId = staffId;
        toolCtx.enabledSections = enabledSections;

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
        if (!freshConvo || freshConvo.propertyId !== body.pid) {
          throw new Error('The conversation scope could not be re-verified for the follow-up.');
        }
        const history: AgentMessage[] = freshConvo.messages;
        const [snapshot, memoryBlock] = await Promise.all([
          buildHotelSnapshot(body.pid, userCtx.role, staffId),
          retrieveMemoryForTurn(body.pid, userCtx.accountId),
        ]);
        // ── The "right now" block, which this turn used to be missing ──────
        //
        // Until 2026-08-01 the resume turn built no awareness block at all. Not
        // by decision: `buildSystemPrompt` took eight positional arguments whose
        // seventh was `string | AgentPromptAuthorization`, this call site passed
        // authorization there, and the awareness slot simply went unfilled. Both
        // call sites type-checked, so nothing ever said a word.
        //
        // The turn it silently degraded is the worst one to degrade. This runs
        // immediately after a manager taps Approve, so "what this person has
        // done today" — which now includes the thing they just approved — and
        // "what is still waiting on them" are the most relevant facts in the
        // conversation, and the follow-up was written without either.
        //
        // Built AFTER the snapshot for the same reason as the live turn: it
        // reuses the snapshot's timezone and PMS-freshness gate. Never throws.
        // No `pathname` here — a card is resolved from wherever the chat is
        // open and the client does not send it, so the screen line is omitted
        // rather than guessed.
        const awareness = await buildAwareness({
          propertyId: body.pid,
          role: userCtx.role,
          accountId: userCtx.accountId,
          authUserId: auth.userId,
          organizationId: companyOrganizationId,
          snapshot,
        });
        const systemPrompt = await buildSystemPrompt({
          role: userCtx.role,
          snapshot,
          conversationId: pending.conversationId,
          memoryBlock,
          awarenessBlock: formatAwarenessForPrompt(awareness),
          authorization: userCtx,
        });
        runnerCtx.promptVersion = systemPrompt.versionLabel;
        const tools = getToolsForRole(
          userCtx.role,
          'chat',
          enabledSections,
          userCtx,
        );

        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage: null, // RESUME — no new user turn; history ends with tool_results
          tools,
          approvalMode: true,
          featureKey: 'agent.ask_staxis',
          executionPlan,
          deadlineAt: executionDeadlineAt,
          fallbackReserveMs: ASK_STAXIS_FALLBACK_RESERVE_MS,
          abortSignal: req.signal,
          toolContext: toolCtx,
        });

        result = await runAgentStream(iter, runnerCtx, {
          pendingToolCallIds,
          // Same capture on the resume turn: a follow-up that runs an ungated
          // mutation is as autonomous as one on the first turn.
          corpus: {
            propertyId: body.pid,
            snapshot,
            accountId: userCtx.accountId,
            actorRole: userCtx.role,
            promptVersion: systemPrompt.versionLabel,
            surface: 'chat',
          },
          // If the follow-up proposes MORE mutations, gate them too (one at a
          // time). Shared factory — same handler both routes use.
          onPendingApproval: makePendingApprovalHandler({
            propertyId: body.pid,
            conversationId: pending.conversationId,
            accountId: userCtx.accountId,
            send,
            // Decision corpus (0350) — same capture on the resume turn, so a
            // follow-up proposal is recorded against the state it was made in.
            corpus: {
              snapshot,
              actorRole: userCtx.role,
              promptVersion: systemPrompt.versionLabel,
            },
          }),
        });

        await finishAgentStream(result, runnerCtx);
      } catch (err) {
        log.error('[agent/resolve-action] resume stream threw', { requestId, reservationId, err });
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        // Resume-crash recovery (item 5): if we had claimed the resume, release
        // the claim so a later resolve attempt on this turn can pick it up
        // again. Best-effort — a failure here only leaves the turn stuck, which
        // is the pre-fix behaviour, so we just log.
        if (resumeClaimed) {
          await releaseTurnResume(pending.conversationId, pending.turnKey).catch((relErr) => {
            log.error('[agent/resolve-action] failed to release resume claim after crash', { requestId, relErr });
          });
        }
      } finally {
        await drainDanglingToolCalls(pendingToolCallIds, runnerCtx);

        // Shared tail — same finalize→cancel ladder both routes run.
        await reconcileCostReservation({
          reservationId,
          conversationId: pending.conversationId,
          finalUsage: result?.finalUsage ?? result?.lastTurnUsage ?? null,
          userId: userCtx.accountId,
          propertyId: body.pid,
          requestId,
          feature: 'agent.ask_staxis',
        });

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
