// ─── Shared agent-stream runner ────────────────────────────────────────────
//
// The event→persistence→SSE loop that BOTH /api/agent/command (a fresh user
// turn) and /api/agent/command/resolve-action (resuming after an approval
// decision) run. Extracting it keeps the two routes in lock-step: assistant
// turns and tool results persist in the exact order Anthropic needs on replay,
// dangling tool_use blocks get synthetic results, and the cost reservation is
// finalized against real spend.
//
// The caller owns the ReadableStream controller and the streamAgent iterator;
// this module owns what to DO with each event. The approval gate adds one new
// event — `tool_call_pending_approval` — which the caller handles via the
// `onPendingApproval` callback (persisting a pending row + emitting the card).

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AgentEvent, UsageReport } from '@/lib/agent/llm';
import type { AiCostFeature } from '@/lib/ai/types';
import {
  recordAssistantTurn,
  recordToolResult,
  recordSyntheticAbortToolResult,
} from '@/lib/agent/memory';
import { createPendingActions, sweepConversationPending } from '@/lib/agent/pending-actions';
import { recordDecisionProposal, recordAutonomousDecision } from '@/lib/agent/decisions';
import { recordAgentJournalEntry, journalActedLine } from '@/lib/agent/journal';
import { isMutationTool } from '@/lib/agent/tools';
import type { HotelSnapshot } from '@/lib/agent/context';
import { buildActionSummary, addonDescriptorsForCard } from '@/lib/agent/approval';
import {
  finalizeCostReservation,
  cancelCostReservation,
} from '@/lib/agent/cost-controls';
import { handleToolCallFinished } from './_tool-result-handler';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import { canViewFinancials, type AppRole } from '@/lib/roles';
import { can } from '@/lib/capabilities/can';
import { loadOverridesForPropertyFresh } from '@/lib/capabilities/server';
import {
  AGENT_TOOL_CAPABILITY_KEYS,
  type AgentSurface,
  type AgentToolCapabilitySnapshot,
} from '@/lib/agent/tools';

// ─── Shared user-context loader ────────────────────────────────────────────
// Both /api/agent/command and .../resolve-action need the SAME account row +
// role + staff.id + department for a (authUserId, propertyId) pair. Kept here so
// the two routes can't drift on which columns they read or how staffId is
// resolved. Returns a discriminated result the caller turns into the right HTTP
// error.

export interface AgentUserCtx {
  uid: string;
  accountId: string;
  username: string;
  displayName: string;
  /**
   * The caller's role AT THIS HOTEL — the spine's `effectiveRole`, not the
   * global `accounts.role`.
   *
   * These are different words for a dual-hat person, and the difference is the
   * whole point of the company spine: Maria can be the GM at Beaumont and wear
   * a maintenance hat at Lufkin. Reading `accounts.role` here handed her the
   * GM's prompt and the GM's tool catalog at BOTH, which is the same
   * capacity-vs-reach hole `managerManagesHotel` was rewritten to close — the
   * door was already spine-aware (`userHasPropertyAccess` falls through to
   * hats), but the job on the other side of it was not.
   */
  role: AppRole;
  propertyAccess: string[];
  hotelMutationAllowed: boolean;
  /** Read-only Financials entitlement at this hotel. Kept separate from role:
   *  a company finance hat remains operationally front_desk. */
  seesFinancials: boolean;
  capabilitySnapshot: AgentToolCapabilitySnapshot;
  dept: string | null;
}

export type LoadUserCtxResult =
  | {
    ok: true;
    userCtx: AgentUserCtx;
    staffId: string | null;
    /**
     * The organization this person holds a COMPANY-SCOPE hat in, else null.
     *
     * The spine's `effectiveRole` is already resolved below to pick the hat;
     * this surfaces the company half of that answer instead of throwing it
     * away, so the awareness block can count a VP's own queue without a second
     * round trip through `resolveCompanyForProperty`.
     *
     * NARROW ON PURPOSE — `scope === 'company'` only. A property-scope hat
     * covering four hotels is NOT a company job, and Wall A in
     * `companyScopeFor` draws the line in exactly the same place. Reading it
     * any wider here would hand a multi-hotel GM a company queue the rest of
     * the product would refuse them.
     */
    companyOrganizationId: string | null;
  }
  | { ok: false; reason: 'account_not_found' };

/**
 * Load the caller's account + the hat they wear at this hotel + their staff.id
 * and department there. staffId is resolved for EVERY role (the comms tools
 * post as the caller). Returns account_not_found when there's no accounts row
 * for the auth user — the caller maps that to a 404.
 */
export async function loadAgentUserCtx(
  authUserId: string,
  propertyId: string,
): Promise<LoadUserCtxResult> {
  const { data: account, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, data_user_id, active')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (accountErr || !account || account.active !== true) {
    return { ok: false, reason: 'account_not_found' };
  }

  const accountId = account.id as string;
  const authority = await listAuthoritativePropertyAccess(accountId);
  if (!authority) return { ok: false, reason: 'account_not_found' };
  const standing = authoritativeStandingForProperty(authority, propertyId);
  if (!standing) return { ok: false, reason: 'account_not_found' };

  // Awareness may read the organization queue only for a genuine company-scope
  // membership hat. Property/portfolio grants and ambiguous multi-company
  // provenance deliberately produce no organization context.
  const companyOrganizationIds = [...new Set(
    standing.entitlements
      .filter((entitlement) => (
        entitlement.kind === 'membership_hat'
        && entitlement.scopeType === 'company'
        && entitlement.organizationId !== null
      ))
      .map((entitlement) => entitlement.organizationId as string),
  )];
  const companyOrganizationId = companyOrganizationIds.length === 1
    ? companyOrganizationIds[0]
    : null;

  // Capture the capability floor before the model sees its catalog. A store
  // outage removes capability-gated tools but does not take down ordinary hotel
  // chat. executeTool intersects this snapshot with a separate uncached read.
  let overrides: Awaited<ReturnType<typeof loadOverridesForPropertyFresh>> | undefined;
  let overridesAvailable = standing.operationalRole === 'admin';
  if (standing.operationalRole !== 'admin') {
    try {
      overrides = await loadOverridesForPropertyFresh(propertyId);
      overridesAvailable = true;
    } catch {
      overridesAvailable = false;
    }
  }
  const capabilitySnapshot: Partial<Record<
    (typeof AGENT_TOOL_CAPABILITY_KEYS)[number],
    boolean
  >> = {};
  for (const capability of AGENT_TOOL_CAPABILITY_KEYS) {
    const explicitFinanceRead = capability === 'view_financials'
      && standing.seesFinancials
      && !canViewFinancials(standing.operationalRole);
    capabilitySnapshot[capability] = explicitFinanceRead
      || (overridesAvailable && can(
        { role: standing.operationalRole },
        capability,
        overrides,
      ));
  }

  const userCtx: AgentUserCtx = {
    uid: account.data_user_id as string,
    accountId,
    username: account.username as string,
    displayName: (account.display_name as string) ?? (account.username as string),
    role: standing.operationalRole,
    // The tool layer receives the exact same authority projection as the
    // route. It is never an additive union with accounts.property_access.
    propertyAccess: authority.all ? ['*'] : authority.propertyIds,
    hotelMutationAllowed: standing.hotelMutationAllowed,
    seesFinancials: standing.seesFinancials,
    capabilitySnapshot,
    dept: null,
  };

  const { data: staffRow } = await supabaseAdmin
    .from('staff')
    .select('id, department')
    .eq('auth_user_id', userCtx.uid)
    .eq('property_id', propertyId)
    .maybeSingle();
  const staffId = (staffRow?.id as string) ?? null;
  userCtx.dept = (staffRow?.department as string | null) ?? null;

  return { ok: true, userCtx, staffId, companyOrganizationId };
}

export interface StreamRunnerContext {
  conversationId: string;
  requestId: string;
  promptVersion: string;
  /** Emit an SSE event to the client (already JSON-serializes + frames). */
  send: (obj: unknown) => void;
}

export interface StreamRunnerResult {
  finalUsage: UsageReport | null;
  lastDoneText: string;
  /** tool_call ids proposed this turn whose result never landed (for cleanup). */
  pendingToolCallIds: Set<string>;
  /** True when the turn ended by proposing approval cards (no `done`). The
   *  caller must NOT emit a synthetic `done` — the browser is waiting on the
   *  card decision, not a completed reply. */
  endedWithPendingApproval: boolean;
  /** The most recent assistant_turn usage. When the turn ends by proposing
   *  cards there is no `done`/finalUsage — but the model DID spend tokens
   *  producing the proposal, so the caller finalizes the cost reservation
   *  against this instead of cancelling and losing the spend. */
  lastTurnUsage: UsageReport | null;
}

/**
 * Callback invoked for each `tool_call_pending_approval` event. Persists the
 * pending row(s) and emits the card SSE event. Returns nothing — the runner
 * just registers the tool_call id as "resolved elsewhere" (not a dangling
 * tool_use to synthesize an abort result for, since resume will feed its
 * result).
 */
export type PendingApprovalHandler = (ev: Extract<AgentEvent, { type: 'tool_call_pending_approval' }>) => Promise<void>;

/**
 * The state the model was looking at this turn, plus who it was working for.
 *
 * Held by the route (buildHotelSnapshot's output is otherwise stringified into
 * the prompt and thrown away), passed down so BOTH halves of the record can be
 * written from the one place that sees every tool call: the decision corpus row
 * and the journal line. Optional so a caller with no snapshot records nothing
 * rather than recording a fabricated one.
 */
export interface StreamCorpusContext {
  propertyId: string;
  snapshot: HotelSnapshot;
  accountId: string;
  actorRole: string | null;
  promptVersion: string | null;
  /**
   * Where this turn is happening. Carried rather than assumed: the "@Staxis"
   * thread assistant runs this same runner on the 'messages' surface, and a
   * literal here would have recorded its acts as though they happened in the
   * chat bar. `decisionCorpusSurfaceOf` decides what the corpus column can
   * store; the journal line has no surface and is written either way.
   */
  surface: AgentSurface;
}

/**
 * Record a tool that ran WITHOUT a card in front of it.
 *
 * ONLY MUTATIONS, and that narrowing is the whole design of it. In chat the
 * approval gate holds every mutation except the confirm-in-chat family, whose
 * gate is a human sentence rather than a card, so what reaches here is exactly
 * the set of acts that changed the hotel with nobody tapping anything. A read
 * is not an act: it changed nothing, the conversation already holds what it
 * returned, and one 2-4 KB state snapshot per lookup would put the same
 * snapshot on disk five times a turn to answer a question nobody asks.
 *
 * Two writes, both fail-soft, neither on the critical path of the reply:
 *   • agent_decisions with actor_kind='ai_autonomous' — the state it was
 *     looking at, which is the only thing that makes "why did you do that"
 *     answerable later. That actor kind had been declared since 0350 and never
 *     once written.
 *   • activity_log — the plain-English line, in the hotel's own timeline.
 */
async function recordAutonomousToolCall(
  corpus: StreamCorpusContext,
  conversationId: string,
  event: Extract<AgentEvent, { type: 'tool_call_finished' }>,
): Promise<void> {
  if (!isMutationTool(event.call.name)) return;
  const ok = event.isError !== true;
  await recordAutonomousDecision({
    propertyId: corpus.propertyId,
    snapshot: corpus.snapshot,
    surface: corpus.surface,
    actorAccountId: corpus.accountId,
    actorRole: corpus.actorRole,
    conversationId,
    toolName: event.call.name,
    proposedArgs: event.call.args ?? {},
    promptVersion: corpus.promptVersion,
    result: ok ? event.result ?? null : null,
    error: ok ? null : String(event.result ?? 'the tool failed without a message'),
  });
  await recordAgentJournalEntry({
    propertyId: corpus.propertyId,
    eventType: 'agent_acted',
    description: journalActedLine({
      summary: buildActionSummary(event.call.name, event.call.args ?? {}, 'en'),
      ok,
    }),
    actorAccountId: corpus.accountId,
    actorRole: corpus.actorRole,
    targetType: 'tool',
    targetId: event.call.name,
    metadata: { toolName: event.call.name, ok },
  });
}

/**
 * Drive a streamAgent iterator: forward client-facing events, persist assistant
 * turns + tool results in Anthropic-replay order, and collect the final usage.
 *
 * Mirrors the original inline loop in route.ts (Codex fixes #2/#3/#4). The one
 * addition is the approval branch.
 */
export async function runAgentStream(
  iter: AsyncGenerator<AgentEvent>,
  ctx: StreamRunnerContext,
  opts: {
    onPendingApproval?: PendingApprovalHandler;
    /**
     * Route-owned set of in-flight tool_call ids. Pass one so the route's
     * finally block can drain dangling tool_use rows EVEN IF runAgentStream
     * throws mid-loop (before it returns its result). Without this, a throw
     * after assistant_turn persists would strand tool_use blocks and break the
     * next replay. Defaults to a fresh internal set for callers that don't
     * need the safety net.
     */
    pendingToolCallIds?: Set<string>;
    /**
     * What the model was looking at this turn. Present, the runner records
     * every ungated mutation it sees; absent, it records nothing rather than
     * inventing a snapshot. See recordAutonomousToolCall.
     */
    corpus?: StreamCorpusContext;
  } = {},
): Promise<StreamRunnerResult> {
  let finalUsage: UsageReport | null = null;
  let lastDoneText = '';
  let endedWithPendingApproval = false;
  let lastTurnUsage: UsageReport | null = null;
  const pendingToolCallIds = opts.pendingToolCallIds ?? new Set<string>();

  for await (const event of iter) {
    if (event.type === 'assistant_turn') {
      lastTurnUsage = event.usage;
      // Fix #2: throw on failure (recordAssistantTurn uses an atomic RPC).
      // The caller's try/catch cancels the reservation and aborts if this
      // throws — we do NOT continue into tool execution with the assistant
      // tool_use blocks not safely on disk.
      await recordAssistantTurn(
        ctx.conversationId,
        event.text,
        event.toolCalls.length ? event.toolCalls : undefined,
        {
          tokensIn: event.usage.inputTokens,
          tokensOut: event.usage.outputTokens,
          modelUsed: event.usage.model,
          modelId: event.usage.modelId,
          costUsd: event.usage.costUsd,
          promptVersion: ctx.promptVersion,
        },
      );
      for (const call of event.toolCalls) {
        pendingToolCallIds.add(call.id);
      }
    } else if (event.type === 'tool_call_finished') {
      const { shouldBreak } = await handleToolCallFinished({
        conversationId: ctx.conversationId,
        event,
        pendingToolCallIds,
        recordToolResult,
        send: ctx.send,
        onPersistenceFailure: (err) => {
          log.error('[agent/stream-runner] failed to persist tool result; aborting stream', {
            requestId: ctx.requestId, conversationId: ctx.conversationId, callId: event.call.id, err,
          });
        },
      });
      if (shouldBreak) break;
      // The act is on disk; now record that it happened. AFTER the tool result
      // is persisted and never in front of it: the reply is worth more than the
      // record of the reply, and both writes below swallow their own failures.
      if (opts.corpus) {
        await recordAutonomousToolCall(opts.corpus, ctx.conversationId, event);
      }
    } else if (event.type === 'tool_call_pending_approval') {
      // The mutation is NOT executed. Persist a pending row + emit the card.
      // The tool_call id is deliberately removed from pendingToolCallIds: its
      // tool_result comes from the approval decision (resume), not from a
      // synthetic abort row on stream end.
      endedWithPendingApproval = true;
      pendingToolCallIds.delete(event.call.id);
      if (opts.onPendingApproval) {
        try {
          await opts.onPendingApproval(event);
        } catch (err) {
          log.error('[agent/stream-runner] failed to persist pending approval', {
            requestId: ctx.requestId, conversationId: ctx.conversationId, callId: event.call.id, err,
          });
          ctx.send({ type: 'error', message: 'Could not stage that action for approval. Please try again.' });
        }
      }
    } else if (event.type === 'done') {
      finalUsage = event.usage;
      lastDoneText = event.finalText;
    } else if (event.type === 'error') {
      // error events may carry accumulated usage — promote so the caller
      // FINALIZES the reservation. Strip usage from the client-bound event.
      if (event.usage) finalUsage = event.usage;
      ctx.send({ type: 'error', message: event.message });
    } else {
      ctx.send(event);
    }
  }

  return { finalUsage, lastDoneText, pendingToolCallIds, endedWithPendingApproval, lastTurnUsage };
}

/**
 * Persist the final assistant text turn (if any) and emit the held `done`
 * event. Shared tail of both routes. Skipped when the turn ended by proposing
 * approval cards (there is no completed reply to persist/announce yet).
 */
export async function finishAgentStream(
  res: StreamRunnerResult,
  ctx: StreamRunnerContext,
): Promise<void> {
  if (res.endedWithPendingApproval) return;
  if (res.lastDoneText) {
    await recordAssistantTurn(
      ctx.conversationId,
      res.lastDoneText,
      undefined,
      {
        tokensIn: res.finalUsage?.inputTokens ?? 0,
        tokensOut: res.finalUsage?.outputTokens ?? 0,
        modelUsed: res.finalUsage?.model ?? 'sonnet',
        modelId: res.finalUsage?.modelId ?? null,
        costUsd: res.finalUsage?.costUsd ?? 0,
        promptVersion: ctx.promptVersion,
      },
    );
  }
  if (res.finalUsage) {
    ctx.send({ type: 'done', usage: res.finalUsage, finalText: res.lastDoneText });
  }
}

/**
 * Synthesize error tool_result rows for any tool_use that never got a result
 * before the stream ended, so the next replay stays valid. Idempotent (ON
 * CONFLICT DO NOTHING). Shared finally-block cleanup.
 */
export async function drainDanglingToolCalls(
  pendingToolCallIds: Set<string>,
  ctx: StreamRunnerContext,
): Promise<void> {
  if (pendingToolCallIds.size === 0) return;
  await Promise.allSettled(
    Array.from(pendingToolCallIds).map((toolCallId) =>
      recordSyntheticAbortToolResult(ctx.conversationId, toolCallId, {
        ok: false,
        error: 'aborted — tool result was not captured before the stream ended',
      }).catch((err) => {
        log.error('[agent/stream-runner] failed to insert synthetic abort result', {
          requestId: ctx.requestId, conversationId: ctx.conversationId, err,
        });
      }),
    ),
  );
}

/**
 * Sweep any still-pending approval cards of a conversation to 'expired' so
 * proposals the user walked away from can't be approved later, and persist a
 * synthetic tool_result per swept tool_call_id so the abandoned assistant turn's
 * tool_use blocks don't dangle on replay (idempotent via the (conversation_id,
 * tool_call_id) unique index).
 *
 * MUST run BEFORE the new user turn is recorded — the synthetic tool_result has
 * to land immediately after its assistant tool_use (Anthropic adjacency), i.e.
 * before the new user message row exists. Returns the swept pending-action ids so
 * the caller can emit a `pending_actions_superseded` SSE event once the stream is
 * open (the browser drops the displayed cards). Best-effort: a failure here only
 * leaves stale cards, so we log and return [] rather than abort the new turn.
 */
export async function sweepSupersededPending(
  conversationId: string,
  requestId: string,
): Promise<string[]> {
  let swept;
  try {
    swept = await sweepConversationPending(conversationId);
  } catch (err) {
    log.error('[agent/stream-runner] failed to sweep superseded pending actions', {
      requestId, conversationId, err,
    });
    return [];
  }
  if (swept.length === 0) return [];
  await Promise.allSettled(
    swept.map((row) =>
      recordSyntheticAbortToolResult(
        conversationId,
        row.toolCallId,
        { ok: false, error: 'superseded — the user moved on without deciding' },
      ).catch((err) => {
        log.error('[agent/stream-runner] failed to persist superseded tool result', {
          requestId, conversationId, callId: row.toolCallId, err,
        });
      }),
    ),
  );
  return swept.map((r) => r.id);
}

/**
 * Build the `onPendingApproval` handler both routes pass to runAgentStream:
 * persist one pending row per proposed mutation, then stream the card SSE event
 * (summary + add-ons in both languages). Extracted so the two near-verbatim
 * copies can't drift. Returns null (skips the card) if the row couldn't be
 * created — runAgentStream's own catch already surfaces a client error.
 */
export function makePendingApprovalHandler(opts: {
  propertyId: string;
  conversationId: string;
  accountId: string;
  send: (obj: unknown) => void;
  /** Decision-corpus context (migration 0350). Omitted by callers that have no
   *  snapshot to record; the corpus write is skipped rather than faked. */
  corpus?: {
    snapshot: HotelSnapshot;
    actorRole: string | null;
    promptVersion: string | null;
    /** See StreamCorpusContext.surface — carried, never assumed. */
    surface: AgentSurface;
  };
}): PendingApprovalHandler {
  return async (ev) => {
    const [row] = await createPendingActions({
      propertyId: opts.propertyId,
      conversationId: opts.conversationId,
      accountId: opts.accountId,
      turnKey: ev.turnKey,
      actions: [{ toolCallId: ev.call.id, toolName: ev.call.name, toolArgs: ev.call.args, tier: ev.tier }],
    });
    if (!row) return;

    // Record what the hotel looked like at the moment the AI proposed this.
    // This is the ONLY place that state is still in hand — buildHotelSnapshot's
    // output is otherwise stringified into the prompt and discarded, making
    // "what did the AI see" unreconstructable forever. Fail-soft: a corpus
    // write must never cost the user their action card.
    if (opts.corpus) {
      await recordDecisionProposal({
        propertyId: opts.propertyId,
        snapshot: opts.corpus.snapshot,
        surface: opts.corpus.surface,
        actorKind: 'ai_proposed',
        actorAccountId: opts.accountId,
        actorRole: opts.corpus.actorRole,
        conversationId: opts.conversationId,
        pendingActionId: row.id,
        toolName: ev.call.name,
        proposedArgs: ev.call.args,
        promptVersion: opts.corpus.promptVersion,
      });
    }
    opts.send({
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
  };
}

/**
 * The cost-reservation reconciliation tail both routes run in their stream's
 * finally block. Finalizes against real spend when we have a usage report;
 * cancels the hold otherwise. The finalize→cancel-on-failure ladder (with its
 * audit-row semantics) MUST stay identical across both routes, so it lives here
 * once. Codex fix H1 lineage.
 */
export async function reconcileCostReservation(opts: {
  reservationId: string;
  conversationId: string;
  finalUsage: UsageReport | null;
  userId: string;
  propertyId: string;
  requestId: string;
  /** Which chat this turn was. Passed in rather than assumed: the same runner
   *  serves the hotel chat, the resume-after-approval route and the portfolio
   *  chat, and those are two different jobs on the bill (0374). */
  feature: AiCostFeature;
}): Promise<void> {
  const { reservationId, conversationId, finalUsage, userId, propertyId, requestId, feature } = opts;
  if (finalUsage) {
    try {
      await finalizeCostReservation({
        reservationId,
        conversationId,
        actualUsd: finalUsage.costUsd,
        model: finalUsage.model,
        modelId: finalUsage.modelId,
        tokensIn: finalUsage.inputTokens,
        tokensOut: finalUsage.outputTokens,
        cachedInputTokens: finalUsage.cachedInputTokens,
        userId,
        propertyId,
        feature,
      });
    } catch (finalizeErr) {
      log.error('[agent/stream-runner] finalize failed after retries; cancelling to release budget hold (audit row written)', {
        requestId, conversationId, reservationId, finalizeErr,
      });
      await cancelCostReservation(reservationId).catch((cancelErr) => {
        log.error('[agent/stream-runner] cancel also failed; reservation will be stranded', {
          requestId, conversationId, reservationId, cancelErr,
        });
      });
    }
  } else {
    await cancelCostReservation(reservationId);
  }
}
