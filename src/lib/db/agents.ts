// ─── Agent Builder data access (service-role) ───────────────────────────────
// All reads/writes to agents / agent_runs / agent_actions. These tables are
// deny-all RLS, so EVERYTHING goes through supabaseAdmin here. Re-exported via
// src/lib/db.ts. The engine consumes the AgentRepo interface (injectable for
// tests); routes use agentRepo directly.

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { migrateConfig } from '@/lib/agents/config-validate';
import type {
  Agent,
  AgentConfig,
  AgentRun,
  AgentActionStep,
  AgentRunReceipt,
  AgentApprovalQueueItem,
  AgentStatus,
  RunMode,
  RunStatus,
  TriggerSource,
  ActionStatus,
} from '@/lib/agents/types';

type Row = Record<string, unknown>;

/** Resolve accounts.id from the auth user id (data_user_id). Used to attribute
 *  an agent's creator (and thus its background AI spend). */
export async function resolveAccountId(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('accounts').select('id').eq('data_user_id', userId).maybeSingle();
  return ((data as { id?: string } | null)?.id) ?? null;
}

// ── mappers ─────────────────────────────────────────────────────────────────

function mapAgent(r: Row): Agent {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    name: String(r.name ?? ''),
    description: (r.description as string | null) ?? null,
    templateKey: (r.template_key as string | null) ?? null,
    config: migrateConfig(r.config),
    status: (r.status as AgentStatus) ?? 'draft',
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastRunLocalDate: (r.last_run_local_date as string | null) ?? null,
  };
}

function mapRun(r: Row): AgentRun {
  const embedded = r.agents as { name?: string } | null | undefined;
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    agentName: embedded?.name ?? '',
    propertyId: String(r.property_id),
    triggerSource: r.trigger_source as TriggerSource,
    triggeredBy: (r.triggered_by as string | null) ?? null,
    mode: r.mode as RunMode,
    status: r.status as RunStatus,
    asOfDate: (r.as_of_date as string | null) ?? null,
    runLocalDate: String(r.run_local_date ?? ''),
    inputsSnapshot: r.inputs_snapshot ?? {},
    summary: (r.summary as string | null) ?? null,
    summaryKey: (r.summary_key as string | null) ?? null,
    summaryParams: (r.summary_params as Record<string, unknown>) ?? {},
    approximations: Array.isArray(r.approximations) ? (r.approximations as string[]) : [],
    error: (r.error as string | null) ?? null,
    startedAt: String(r.started_at ?? ''),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function mapStep(r: Row): AgentActionStep {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    agentId: String(r.agent_id),
    propertyId: String(r.property_id),
    actionKey: String(r.action_key),
    payload: r.payload ?? {},
    status: r.status as ActionStatus,
    result: r.result ?? null,
    describeKey: (r.describe_key as string | null) ?? null,
    describeParams: (r.describe_params as Record<string, unknown>) ?? {},
    describeEn: (r.describe_en as string | null) ?? '',
    describeEs: (r.describe_es as string | null) ?? '',
    spendsMoney: r.spends_money === true,
    contactsGuest: r.contacts_guest === true,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
  };
}

// ── input shapes ────────────────────────────────────────────────────────────

export interface CreateAgentInput {
  propertyId: string;
  name: string;
  description?: string | null;
  templateKey?: string | null;
  config: AgentConfig;
  createdBy: string | null;
}
export interface UpdateAgentPatch {
  name?: string;
  description?: string | null;
  config?: AgentConfig;
  status?: AgentStatus;
}
export interface InsertRunInput {
  agentId: string;
  propertyId: string;
  triggerSource: TriggerSource;
  mode: RunMode;
  asOfDate: string | null;
  runLocalDate: string;
  triggeredBy: string | null;
  eventId: string | null;
  inputsSnapshot: unknown;
}
export interface InsertStepInput {
  runId: string;
  agentId: string;
  propertyId: string;
  actionKey: string;
  payload: unknown;
  status: ActionStatus;
  result?: unknown;
  describeKey?: string | null;
  describeParams?: Record<string, unknown>;
  describeEn?: string;
  describeEs?: string;
  spendsMoney: boolean;
  contactsGuest: boolean;
  execIdempotencyKey?: string | null;
}
export interface FinalizeRunPatch {
  status: RunStatus;
  summary: string;
  summaryKey: string | null;
  summaryParams: Record<string, unknown>;
  approximations: string[];
  error: string | null;
  inputsSnapshot?: unknown;
}

export type InsertRunResult =
  | { ok: true; runId: string }
  | { ok: false; conflict: boolean; error?: string };

// ── repository interface (injectable into the engine) ───────────────────────

export interface AgentRepo {
  createAgent(input: CreateAgentInput): Promise<Agent>;
  getAgent(id: string): Promise<Agent | null>;
  listAgents(propertyId: string): Promise<Agent[]>;
  updateAgent(id: string, patch: UpdateAgentPatch): Promise<Agent | null>;
  listActiveScheduleAgents(): Promise<Agent[]>;
  listActiveEventAgents(propertyId: string, eventName: string): Promise<Agent[]>;

  insertRun(input: InsertRunInput): Promise<InsertRunResult>;
  finalizeRun(runId: string, patch: FinalizeRunPatch): Promise<void>;
  rollupRunStatus(runId: string): Promise<RunStatus>;
  markAgentRan(agentId: string, localDate: string): Promise<void>;
  runStatusesForAgentOnDate(agentId: string, localDate: string): Promise<RunStatus[]>;

  insertStep(input: InsertStepInput): Promise<AgentActionStep>;
  getStepWithRun(stepId: string): Promise<{ step: AgentActionStep; run: AgentRun } | null>;
  casApproveStep(stepId: string, decidedBy: string | null): Promise<AgentActionStep | null>;
  markStepExecuted(stepId: string, result: unknown): Promise<void>;
  casRejectStep(stepId: string, decidedBy: string | null): Promise<AgentActionStep | null>;

  getRunWithSteps(runId: string): Promise<AgentRunReceipt | null>;
  listRunsForAgent(agentId: string, limit: number): Promise<AgentRun[]>;
  listApprovalQueue(propertyId: string): Promise<AgentApprovalQueueItem[]>;

  reapStaleRuns(olderThanIso: string): Promise<number>;
  purgeOldSnapshots(olderThanIso: string): Promise<number>;
  purgeOldActionPii(olderThanIso: string): Promise<number>;
}

// ── implementation ──────────────────────────────────────────────────────────

export const agentRepo: AgentRepo = {
  async createAgent(input) {
    const { data, error } = await supabaseAdmin
      .from('agents')
      .insert({
        property_id: input.propertyId,
        name: input.name,
        description: input.description ?? null,
        template_key: input.templateKey ?? null,
        config: input.config,
        status: 'draft',
        created_by: input.createdBy,
      })
      .select('*')
      .single();
    if (error) throw new Error(`createAgent: ${error.message}`);
    return mapAgent(data as Row);
  },

  async getAgent(id) {
    const { data, error } = await supabaseAdmin.from('agents').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`getAgent: ${error.message}`);
    return data ? mapAgent(data as Row) : null;
  },

  async listAgents(propertyId) {
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`listAgents: ${error.message}`);
    return (data ?? []).map((r) => mapAgent(r as Row));
  },

  async updateAgent(id, patch) {
    const upd: Row = {};
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.config !== undefined) upd.config = patch.config;
    if (patch.status !== undefined) upd.status = patch.status;
    if (Object.keys(upd).length === 0) return this.getAgent(id);
    const { data, error } = await supabaseAdmin.from('agents').update(upd).eq('id', id).select('*').maybeSingle();
    if (error) throw new Error(`updateAgent: ${error.message}`);
    return data ? mapAgent(data as Row) : null;
  },

  async listActiveScheduleAgents() {
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('status', 'active')
      .eq('config->trigger->>type', 'schedule');
    if (error) throw new Error(`listActiveScheduleAgents: ${error.message}`);
    return (data ?? []).map((r) => mapAgent(r as Row));
  },

  async listActiveEventAgents(propertyId, eventName) {
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('property_id', propertyId)
      .eq('status', 'active')
      .eq('config->trigger->>type', 'event')
      .eq('config->trigger->>eventName', eventName);
    if (error) throw new Error(`listActiveEventAgents: ${error.message}`);
    return (data ?? []).map((r) => mapAgent(r as Row));
  },

  async insertRun(input) {
    const { data, error } = await supabaseAdmin
      .from('agent_runs')
      .insert({
        agent_id: input.agentId,
        property_id: input.propertyId,
        trigger_source: input.triggerSource,
        mode: input.mode,
        status: 'running',
        as_of_date: input.asOfDate,
        run_local_date: input.runLocalDate,
        triggered_by: input.triggeredBy,
        event_id: input.eventId,
        inputs_snapshot: input.inputsSnapshot ?? {},
      })
      .select('id')
      .single();
    if (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code === '23505') return { ok: false, conflict: true };
      return { ok: false, conflict: false, error: error.message };
    }
    return { ok: true, runId: String((data as Row).id) };
  },

  async finalizeRun(runId, patch) {
    const upd: Row = {
      status: patch.status,
      summary: patch.summary,
      summary_key: patch.summaryKey,
      summary_params: patch.summaryParams,
      approximations: patch.approximations,
      error: patch.error,
      finished_at: new Date().toISOString(),
    };
    if (patch.inputsSnapshot !== undefined) upd.inputs_snapshot = patch.inputsSnapshot;
    const { error } = await supabaseAdmin.from('agent_runs').update(upd).eq('id', runId);
    if (error) throw new Error(`finalizeRun: ${error.message}`);
  },

  async rollupRunStatus(runId) {
    // Open steps gate the run. 'approved' is normally transient (immediately
    // moved to 'executed'), but counting it as open means a step orphaned in
    // 'approved' (e.g. a markStepExecuted that failed after the side effect
    // ran) keeps the run VISIBLE in the queue instead of rolling up to a
    // silent success with a missing receipt.
    const { count: open, error: pErr } = await supabaseAdmin
      .from('agent_actions')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', runId)
      .in('status', ['pending_approval', 'approved']);
    if (pErr) throw new Error(`rollupRunStatus(open): ${pErr.message}`);

    let status: RunStatus;
    if ((open ?? 0) > 0) {
      status = 'awaiting_approval';
    } else {
      const { data, error } = await supabaseAdmin
        .from('agent_actions')
        .select('result')
        .eq('run_id', runId)
        .eq('status', 'executed');
      if (error) throw new Error(`rollupRunStatus(executed): ${error.message}`);
      const anyFailed = (data ?? []).some((r) => {
        const res = (r as Row).result as { ok?: boolean } | null;
        return !!res && res.ok === false;
      });
      status = anyFailed ? 'failed' : 'success';
    }
    const { error: uErr } = await supabaseAdmin
      .from('agent_runs')
      .update({ status, finished_at: new Date().toISOString() })
      .eq('id', runId);
    if (uErr) throw new Error(`rollupRunStatus(update): ${uErr.message}`);
    return status;
  },

  async markAgentRan(agentId, localDate) {
    const { error } = await supabaseAdmin
      .from('agents')
      .update({ last_run_at: new Date().toISOString(), last_run_local_date: localDate })
      .eq('id', agentId);
    if (error) throw new Error(`markAgentRan: ${error.message}`);
  },

  async runStatusesForAgentOnDate(agentId, localDate) {
    const { data, error } = await supabaseAdmin
      .from('agent_runs')
      .select('status')
      .eq('agent_id', agentId)
      .eq('run_local_date', localDate)
      .eq('mode', 'live')
      .eq('trigger_source', 'scheduled');
    if (error) throw new Error(`runStatusesForAgentOnDate: ${error.message}`);
    return (data ?? []).map((r) => (r as Row).status as RunStatus);
  },

  async insertStep(input) {
    const { data, error } = await supabaseAdmin
      .from('agent_actions')
      .insert({
        run_id: input.runId,
        agent_id: input.agentId,
        property_id: input.propertyId,
        action_key: input.actionKey,
        payload: input.payload ?? {},
        status: input.status,
        result: input.result ?? null,
        describe_key: input.describeKey ?? null,
        describe_params: input.describeParams ?? {},
        describe_en: input.describeEn ?? '',
        describe_es: input.describeEs ?? '',
        spends_money: input.spendsMoney,
        contacts_guest: input.contactsGuest,
        exec_idempotency_key: input.execIdempotencyKey ?? null,
      })
      .select('*')
      .single();
    if (error) throw new Error(`insertStep: ${error.message}`);
    return mapStep(data as Row);
  },

  async getStepWithRun(stepId) {
    // Two robust 1-level queries (avoids a fragile 2-level PostgREST embed).
    const { data: stepRow, error: sErr } = await supabaseAdmin
      .from('agent_actions')
      .select('*')
      .eq('id', stepId)
      .maybeSingle();
    if (sErr) throw new Error(`getStepWithRun(step): ${sErr.message}`);
    if (!stepRow) return null;
    const { data: runRow, error: rErr } = await supabaseAdmin
      .from('agent_runs')
      .select('*, agents(name)')
      .eq('id', (stepRow as Row).run_id)
      .maybeSingle();
    if (rErr) throw new Error(`getStepWithRun(run): ${rErr.message}`);
    if (!runRow) return null;
    return { step: mapStep(stepRow as Row), run: mapRun(runRow as Row) };
  },

  async casApproveStep(stepId, decidedBy) {
    const { data, error } = await supabaseAdmin
      .from('agent_actions')
      .update({ status: 'approved', decided_by: decidedBy, decided_at: new Date().toISOString() })
      .eq('id', stepId)
      .eq('status', 'pending_approval')
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`casApproveStep: ${error.message}`);
    return data ? mapStep(data as Row) : null;
  },

  async markStepExecuted(stepId, result) {
    const { error } = await supabaseAdmin
      .from('agent_actions')
      .update({ status: 'executed', result })
      .eq('id', stepId)
      .eq('status', 'approved');
    if (error) throw new Error(`markStepExecuted: ${error.message}`);
  },

  async casRejectStep(stepId, decidedBy) {
    const { data, error } = await supabaseAdmin
      .from('agent_actions')
      .update({ status: 'rejected', decided_by: decidedBy, decided_at: new Date().toISOString() })
      .eq('id', stepId)
      .eq('status', 'pending_approval')
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`casRejectStep: ${error.message}`);
    return data ? mapStep(data as Row) : null;
  },

  async getRunWithSteps(runId) {
    const { data: runRow, error: rErr } = await supabaseAdmin
      .from('agent_runs')
      .select('*, agents(name)')
      .eq('id', runId)
      .maybeSingle();
    if (rErr) throw new Error(`getRunWithSteps(run): ${rErr.message}`);
    if (!runRow) return null;
    const { data: stepRows, error: sErr } = await supabaseAdmin
      .from('agent_actions')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: true });
    if (sErr) throw new Error(`getRunWithSteps(steps): ${sErr.message}`);
    return { run: mapRun(runRow as Row), steps: (stepRows ?? []).map((r) => mapStep(r as Row)) };
  },

  async listRunsForAgent(agentId, limit) {
    const { data, error } = await supabaseAdmin
      .from('agent_runs')
      .select('*, agents(name)')
      .eq('agent_id', agentId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listRunsForAgent: ${error.message}`);
    return (data ?? []).map((r) => mapRun(r as Row));
  },

  async listApprovalQueue(propertyId) {
    const { data: runRows, error } = await supabaseAdmin
      .from('agent_runs')
      .select('*, agents(name)')
      .eq('property_id', propertyId)
      .eq('status', 'awaiting_approval')
      .order('started_at', { ascending: false });
    if (error) throw new Error(`listApprovalQueue: ${error.message}`);
    const runs = (runRows ?? []).map((r) => mapRun(r as Row));
    const out: AgentApprovalQueueItem[] = [];
    for (const run of runs) {
      const { data: pending, error: pErr } = await supabaseAdmin
        .from('agent_actions')
        .select('*')
        .eq('run_id', run.id)
        .eq('status', 'pending_approval')
        .order('created_at', { ascending: true });
      if (pErr) throw new Error(`listApprovalQueue(steps): ${pErr.message}`);
      out.push({ run, pendingSteps: (pending ?? []).map((r) => mapStep(r as Row)) });
    }
    return out;
  },

  async reapStaleRuns(olderThanIso) {
    const { data, error } = await supabaseAdmin
      .from('agent_runs')
      .update({ status: 'failed', error: 'stranded (reaper)', finished_at: new Date().toISOString() })
      .eq('status', 'running')
      .lt('started_at', olderThanIso)
      .select('id');
    if (error) throw new Error(`reapStaleRuns: ${error.message}`);
    return (data ?? []).length;
  },

  async purgeOldSnapshots(olderThanIso) {
    const { data, error } = await supabaseAdmin
      .from('agent_runs')
      .update({ inputs_snapshot: {} })
      .lt('started_at', olderThanIso)
      .neq('inputs_snapshot', '{}')
      .select('id');
    if (error) throw new Error(`purgeOldSnapshots: ${error.message}`);
    return (data ?? []).length;
  },

  async purgeOldActionPii(olderThanIso) {
    // Redact guest-naming fields on old run steps (the receipt's describe text
    // and the raw payload). Matches the 90-day retention posture documented in
    // migration 0264. Guarded on describe_en so already-purged rows are skipped.
    const { data, error } = await supabaseAdmin
      .from('agent_actions')
      .update({ payload: {}, describe_en: '', describe_es: '' })
      .lt('created_at', olderThanIso)
      .neq('describe_en', '')
      .select('id');
    if (error) throw new Error(`purgeOldActionPii: ${error.message}`);
    return (data ?? []).length;
  },
};
