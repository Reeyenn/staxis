// ─── Agent engine ───────────────────────────────────────────────────────────
// runAgent(agentId, input, deps?) — load config → gather allowed read-scopes
// (service-role) → run the template's PURE planner → apply each action's
// approval mode (auto executes; approve_first queues; suggest records) → write
// a run receipt with a human summary. dry_run is first-class: identical
// pipeline, NO execute() ever runs, each step is recorded as "would do X".
//
// Dependency-injected so it's unit-testable with fakes (no Supabase/Anthropic).
// The model is reached ONLY for the summary, ONLY via the reasoner chokepoint.

import 'server-only';
import '@/lib/agents/actions'; // populate the action registry
import '@/lib/agents/scopes'; // populate the scope registry
import '@/lib/agents/templates'; // populate the template registry (empty in Chat 1)

import { supabaseAdmin } from '@/lib/supabase-admin';
import { env } from '@/lib/env';
import { errToString } from '@/lib/utils';
import { captureException } from '@/lib/sentry';
import { resolveCostAccount } from '@/lib/compliance/api-helpers';
import { getAction } from '@/lib/agents/actions/registry';
import { getScope } from '@/lib/agents/scopes/registry';
import { getTemplate } from '@/lib/agents/templates/registry';
import { makeReasoner, type Reasoner } from '@/lib/agents/reasoner';
import { agentRepo, type AgentRepo } from '@/lib/db/agents';
import type {
  Agent,
  AgentActionContext,
  AgentActionDef,
  AgentActionResult,
  AgentActionStep,
  AgentScopeDef,
  AgentTemplate,
  ActionApprovalMode,
  ProposedAction,
  RunAgentInput,
  RunAgentOutcome,
  RunStatus,
  ScheduleTriggerConfig,
  ScopeKey,
} from '@/lib/agents/types';

const MAX_SNAPSHOT_BYTES = 200_000; // stay under the 256KB DB CHECK with headroom
const STALE_RUN_MINUTES = 10;

export interface AgentEngineDeps {
  repo: AgentRepo;
  getAction: (key: string) => AgentActionDef<unknown> | undefined;
  getScope: (key: ScopeKey) => AgentScopeDef<unknown> | undefined;
  getTemplate: (key: string | null | undefined) => AgentTemplate | undefined;
  makeReasoner: (opts: { propertyId: string; costAccountId: string | null; requestId: string }) => Reasoner;
  resolveCostAccount: (pid: string) => Promise<string | null>;
  propertyTimezone: (pid: string) => Promise<string | null>;
  now: () => number;
}

export function defaultEngineDeps(): AgentEngineDeps {
  return {
    repo: agentRepo,
    getAction,
    getScope,
    getTemplate,
    makeReasoner,
    resolveCostAccount,
    propertyTimezone: async (pid) => {
      const { data } = await supabaseAdmin.from('properties').select('timezone').eq('id', pid).maybeSingle();
      return ((data as { timezone?: string | null } | null)?.timezone) ?? null;
    },
    now: () => Date.now(),
  };
}

// ── pure helpers ────────────────────────────────────────────────────────────

export function todayInTz(tz: string | null, nowMs: number): string {
  const zone = tz && tz.trim().length > 0 ? tz : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  }
}

/** A property MUST have a valid IANA timezone for automated runs — otherwise
 *  todayInTz falls back to UTC and near local midnight computes the wrong
 *  business_date (the exact guard run-auto-assign uses). */
export function isValidTz(tz: string | null): boolean {
  if (!tz || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localHHMM(tz: string | null, nowMs: number): string {
  const zone = tz && tz.trim().length > 0 ? tz : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(nowMs));
  } catch {
    return '00:00';
  }
}

export function localDow(tz: string | null, nowMs: number): number {
  const zone = tz && tz.trim().length > 0 ? tz : 'UTC';
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(new Date(nowMs));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  } catch {
    return new Date(nowMs).getUTCDay();
  }
}

/** Pure due-logic for the schedule tick. `runStatusesToday` are the statuses of
 *  this agent's live scheduled runs for the local day. */
export function isAgentDue(
  trigger: ScheduleTriggerConfig,
  runStatusesToday: RunStatus[],
  hhmm: string,
  dow: number,
  maxFailedRetries = 3,
): boolean {
  if (trigger.daysOfWeek && !trigger.daysOfWeek.includes(dow)) return false;
  if (hhmm < trigger.atLocalTime) return false;
  const handled = runStatusesToday.some((s) => s === 'success' || s === 'awaiting_approval' || s === 'running');
  if (handled) return false;
  const failed = runStatusesToday.filter((s) => s === 'failed').length;
  if (failed >= maxFailedRetries) return false;
  return true;
}

/** money/guest actions can never silently AUTO: 'auto' is clamped up to
 *  approve_first when the guard is on. 'suggest' (records only) stays as-is. */
function clampMode(
  configured: ActionApprovalMode,
  def: Pick<AgentActionDef, 'spendsMoney' | 'contactsGuest'>,
  guard: boolean,
): ActionApprovalMode {
  const flagged = def.spendsMoney || def.contactsGuest;
  if (flagged && guard && configured === 'auto') return 'approve_first';
  return configured;
}

function isFailedResult(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { ok?: boolean }).ok === false;
}

function deterministicSummary(steps: AgentActionStep[], mode: string, asOfDate: string): string {
  const by: Record<string, number> = {};
  for (const s of steps) by[s.status] = (by[s.status] ?? 0) + 1;
  const parts: string[] = [];
  if (by.executed) parts.push(`${by.executed} action(s) carried out`);
  if (by.pending_approval) parts.push(`${by.pending_approval} awaiting your approval`);
  if (by.simulated) parts.push(`${by.simulated} simulated`);
  if (by.proposed) parts.push(`${by.proposed} suggested`);
  if (by.skipped) parts.push(`${by.skipped} skipped`);
  const lead = mode === 'dry_run' ? `Dry run for ${asOfDate}` : 'Run complete';
  return parts.length ? `${lead}: ${parts.join(', ')}.` : `${lead}: nothing to do.`;
}

function trimSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  try {
    // Measure UTF-8 BYTES (the DB CHECK is octet_length), not UTF-16 chars —
    // multi-byte guest names must not slip past the JS check and fail at insert.
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= MAX_SNAPSHOT_BYTES) return snapshot;
  } catch {
    /* fall through */
  }
  // Too big — keep just the event + a marker; drop the heavy scope payloads.
  return { trimmed: true, event: snapshot.event };
}

function mkRequestId(agentId: string, nowMs: number): string {
  return `agent-${agentId.slice(0, 8)}-${nowMs.toString(36)}`;
}

// ── engine entry ────────────────────────────────────────────────────────────

export async function runAgent(
  agentId: string,
  input: RunAgentInput,
  depsOverride?: AgentEngineDeps,
): Promise<RunAgentOutcome> {
  const deps = depsOverride ?? defaultEngineDeps();

  // Global kill-switch (no-deploy lever for an incident).
  if (env.AGENTS_ENABLED === 'false') {
    return { runId: '', status: 'failed', steps: [], summary: 'Agents are disabled.' };
  }

  const agent: Agent | null = await deps.repo.getAgent(agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);

  // Only active agents may run from automated triggers; manual/backtest may run
  // a draft or paused agent (for the "test on yesterday" preview).
  if ((input.triggerSource === 'scheduled' || input.triggerSource === 'event') && agent.status !== 'active') {
    return { runId: '', status: 'failed', steps: [], summary: `Agent is ${agent.status}, not active.` };
  }

  const config = agent.config;
  const nowMs = deps.now();
  const requestId = mkRequestId(agentId, nowMs);
  const tz = await deps.propertyTimezone(agent.propertyId);

  // Timezone guard: refuse automated runs for a property with no valid tz
  // rather than silently act on the wrong (UTC) day near local midnight.
  if ((input.triggerSource === 'scheduled' || input.triggerSource === 'event') && !isValidTz(tz)) {
    return { runId: '', status: 'failed', steps: [], summary: 'Skipped: property has no valid timezone.' };
  }

  const todayLocal = todayInTz(tz, nowMs);
  const asOfDate = input.mode === 'live' ? todayLocal : input.asOfDate ?? todayLocal;
  // run_local_date = the day the run REPRESENTS: today for live, the target day
  // for a backtest. (The scheduled-live idempotency index only touches live runs.)
  const runLocalDate = input.mode === 'live' ? todayLocal : asOfDate;
  const costAccountId = agent.createdBy ?? (await deps.resolveCostAccount(agent.propertyId));

  // Insert the run row. The scheduled-live unique partial index makes a second
  // tick for the same agent/local-day a no-op; a duplicate event id likewise.
  const ins = await deps.repo.insertRun({
    agentId,
    propertyId: agent.propertyId,
    triggerSource: input.triggerSource,
    mode: input.mode,
    asOfDate: input.mode === 'live' ? null : asOfDate,
    runLocalDate,
    triggeredBy: input.triggeredBy ?? null,
    eventId: input.event?.eventId ?? null,
    inputsSnapshot: {},
  });
  if (!ins.ok) {
    if (ins.conflict) {
      return { runId: '', status: 'success', steps: [], summary: 'Already handled for this period.' };
    }
    throw new Error(`insertRun failed: ${ins.error ?? 'unknown'}`);
  }
  const runId = ins.runId;

  try {
    const reason = deps.makeReasoner({ propertyId: agent.propertyId, costAccountId, requestId });
    const approximations: string[] = [];
    const template = deps.getTemplate(agent.templateKey);

    // Gather requested scopes (service-role reads).
    const effectiveScopes = Array.from(new Set<ScopeKey>([...(template?.requiredScopes ?? []), ...config.scopes]));
    const scopes: Partial<Record<ScopeKey, unknown>> = {};
    for (const key of effectiveScopes) {
      const scope = deps.getScope(key);
      if (!scope) continue;
      try {
        scopes[key] = await scope.read({ propertyId: agent.propertyId, asOfDate, mode: input.mode }, approximations);
      } catch (e) {
        scopes[key] = { error: errToString(e) };
        approximations.push(`Scope "${key}" was unavailable.`);
      }
    }

    const inputsSnapshot: Record<string, unknown> = { scopes };
    if (input.event) inputsSnapshot.event = input.event;

    // Plan (PURE — no LLM, no I/O ⇒ backtest reproducible). No template = no-op.
    const proposed: ProposedAction[] = template
      ? template.plan({ scopes, config, asOfDate, event: input.event })
      : [];

    const ctxBase: Omit<AgentActionContext, 'asOfDate'> & { asOfDate: string } = {
      propertyId: agent.propertyId,
      agentId,
      runId,
      mode: input.mode,
      asOfDate,
      costAccountId,
      requestId,
    };

    const steps: AgentActionStep[] = [];
    let idx = 0;
    for (const pa of proposed) {
      idx += 1;
      const def = deps.getAction(pa.actionKey);
      const allowed = config.actions.includes(pa.actionKey);

      if (!def || !allowed) {
        steps.push(
          await deps.repo.insertStep({
            runId, agentId, propertyId: agent.propertyId, actionKey: pa.actionKey, payload: pa.payload,
            status: 'skipped',
            result: { ok: false, error: !def ? 'unknown action' : 'action not allowed by this agent' },
            describeEn: pa.reason?.en ?? '', describeEs: pa.reason?.es ?? '',
            spendsMoney: def?.spendsMoney ?? false, contactsGuest: def?.contactsGuest ?? false,
          }),
        );
        continue;
      }

      const v = def.validate(pa.payload);
      if (v.error) {
        steps.push(
          await deps.repo.insertStep({
            runId, agentId, propertyId: agent.propertyId, actionKey: pa.actionKey, payload: pa.payload,
            status: 'skipped', result: { ok: false, error: `invalid payload: ${v.error}` },
            describeEn: pa.reason?.en ?? '', describeEs: pa.reason?.es ?? '',
            spendsMoney: def.spendsMoney, contactsGuest: def.contactsGuest,
          }),
        );
        continue;
      }

      const payload = v.value;
      const desc = def.describe(payload, ctxBase);
      const base = {
        runId, agentId, propertyId: agent.propertyId, actionKey: pa.actionKey, payload,
        describeKey: desc.key ?? null, describeParams: desc.params, describeEn: desc.en, describeEs: desc.es,
        spendsMoney: def.spendsMoney, contactsGuest: def.contactsGuest,
      };

      if (input.mode === 'dry_run') {
        steps.push(await deps.repo.insertStep({ ...base, status: 'simulated', result: { wouldDo: { en: desc.en, es: desc.es } } }));
        continue;
      }

      const configured = config.approvalRules.perAction[pa.actionKey] ?? config.approvalRules.defaultMode;
      const effective = clampMode(configured, def, config.approvalRules.moneyOrGuestRequiresApproval);

      if (effective === 'suggest') {
        steps.push(await deps.repo.insertStep({ ...base, status: 'proposed' }));
      } else if (effective === 'approve_first') {
        steps.push(await deps.repo.insertStep({ ...base, status: 'pending_approval', execIdempotencyKey: `${runId}:${idx}` }));
      } else {
        // auto — execute now. A throw becomes a soft per-step failure (recorded
        // as executed+result.ok=false), never a whole-run failure.
        let res: AgentActionResult;
        try {
          res = await def.execute(payload, ctxBase);
        } catch (e) {
          res = { ok: false, error: errToString(e) };
        }
        steps.push(await deps.repo.insertStep({ ...base, status: 'executed', result: res, execIdempotencyKey: `${runId}:${idx}` }));
      }
    }

    const anyPending = steps.some((s) => s.status === 'pending_approval');
    const anyFailed = steps.some((s) => s.status === 'executed' && isFailedResult(s.result));
    const status: RunStatus = anyPending ? 'awaiting_approval' : anyFailed ? 'failed' : 'success';

    // Summary. The LLM is LIVE-only: a backtest stays FREE and 100% reproducible
    // (deterministic text). Live falls back to the same deterministic summary if
    // there's no budget/account.
    const deterministic = deterministicSummary(steps, input.mode, asOfDate);
    let summaryText = deterministic;
    if (input.mode === 'live' && steps.length > 0) {
      if (!costAccountId) {
        approximations.push('AI summary unavailable — no billing account for this property.');
      } else {
        const prompt =
          `Agent "${agent.name}" ran for ${asOfDate}. Step log:\n` +
          steps.map((s) => `- [${s.status}] ${s.actionKey}: ${s.describeEn}`).join('\n') +
          `\nWrite a 1-2 sentence plain-English receipt of what happened. Do not invent actions.`;
        const llm = await reason(prompt);
        if (llm && llm.trim().length > 0) summaryText = llm.trim();
      }
    }

    await deps.repo.finalizeRun(runId, {
      status,
      summary: summaryText,
      summaryKey: null,
      summaryParams: { stepCount: steps.length, mode: input.mode },
      approximations,
      error: null,
      inputsSnapshot: trimSnapshot(inputsSnapshot),
    });
    if (input.mode === 'live') {
      await deps.repo.markAgentRan(agentId, runLocalDate);
    }

    return { runId, status, steps, summary: summaryText };
  } catch (e) {
    const msg = errToString(e);
    await deps.repo
      .finalizeRun(runId, {
        status: 'failed', summary: `The agent run failed: ${msg}`,
        summaryKey: null, summaryParams: {}, approximations: [], error: msg,
      })
      .catch(() => {});
    captureException(e, { subsystem: 'agent-builder', agentId, runId });
    return { runId, status: 'failed', steps: [], summary: `The agent run failed: ${msg}` };
  }
}

/** Recommended import for Chat 2/3 (unambiguous vs llm.ts's runAgent). */
export const executeAgentRun = runAgent;

/**
 * Execute a previously queued (approve_first) step after a human approves it.
 * Atomic CAS pending_approval→approved (only the winner executes), then
 * approved→executed, then recompute the run status. Idempotent.
 */
export async function executeApprovedStep(
  stepId: string,
  decidedBy: string | null,
  depsOverride?: AgentEngineDeps,
): Promise<{ ok: boolean; status?: RunStatus; error?: string }> {
  const deps = depsOverride ?? defaultEngineDeps();
  const found = await deps.repo.getStepWithRun(stepId);
  if (!found) return { ok: false, error: 'step not found' };
  const { step, run } = found;
  if (run.mode !== 'live') return { ok: false, error: 'cannot execute a step from a non-live run' };

  const won = await deps.repo.casApproveStep(stepId, decidedBy);
  if (!won) {
    // Lost the race or not pending — idempotent no-op; report current run status.
    const status = await deps.repo.rollupRunStatus(run.id);
    return { ok: true, status };
  }

  const def = deps.getAction(step.actionKey);
  let result: unknown;
  if (!def) {
    result = { ok: false, error: 'unknown action' };
  } else {
    const v = def.validate(step.payload);
    if (v.error) {
      result = { ok: false, error: `invalid payload: ${v.error}` };
    } else {
      // Approval is a "do it now" gesture — resolve the operating day at
      // EXECUTION time, not run-creation time, so a next-morning approval of an
      // evening run doesn't act on yesterday's data (e.g. assign_rooms).
      const tz = await deps.propertyTimezone(run.propertyId);
      const ctx: AgentActionContext = {
        propertyId: run.propertyId, agentId: run.agentId, runId: run.id,
        mode: 'live', asOfDate: todayInTz(tz, deps.now()),
        costAccountId: null, requestId: mkRequestId(run.agentId, deps.now()),
      };
      try {
        result = await def.execute(v.value, ctx);
      } catch (e) {
        result = { ok: false, error: errToString(e) };
      }
    }
  }
  await deps.repo.markStepExecuted(stepId, result);
  const status = await deps.repo.rollupRunStatus(run.id);
  return { ok: true, status };
}

/** Reject a queued step. */
export async function rejectStep(
  stepId: string,
  decidedBy: string | null,
  depsOverride?: AgentEngineDeps,
): Promise<{ ok: boolean; status?: RunStatus; error?: string }> {
  const deps = depsOverride ?? defaultEngineDeps();
  const found = await deps.repo.getStepWithRun(stepId);
  if (!found) return { ok: false, error: 'step not found' };
  const rejected = await deps.repo.casRejectStep(stepId, decidedBy);
  if (!rejected) {
    const status = await deps.repo.rollupRunStatus(found.run.id);
    return { ok: true, status };
  }
  const status = await deps.repo.rollupRunStatus(found.run.id);
  return { ok: true, status };
}

export const STALE_RUN_MS = STALE_RUN_MINUTES * 60 * 1000;
