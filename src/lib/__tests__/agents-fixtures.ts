// Shared fakes for the agent-engine unit tests. NOT a *.test.ts file, so the
// runner imports it but doesn't execute it directly. Everything is in-memory —
// no Supabase, no Anthropic.

import type { AgentEngineDeps } from '@/lib/agents/engine';
import type { AgentRepo } from '@/lib/db/agents';
import type {
  Agent,
  AgentActionDef,
  AgentActionStep,
  AgentConfig,
  AgentRun,
  AgentTemplate,
  ProposedAction,
  RunStatus,
  AgentApprovalRules,
  ActionApprovalMode,
} from '@/lib/agents/types';

export const FIXED_NOW = Date.parse('2026-06-04T12:00:00Z');

export function makeConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  const approvalRules: AgentApprovalRules = {
    moneyOrGuestRequiresApproval: true,
    defaultMode: 'suggest',
    perAction: {},
    ...(over.approvalRules ?? {}),
  };
  return {
    version: 1,
    trigger: { type: 'schedule', atLocalTime: '08:00' },
    scopes: [],
    actions: [],
    ...over,
    approvalRules,
  };
}

export function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    propertyId: 'prop-1',
    name: 'Test Agent',
    description: null,
    templateKey: 'test-template',
    config: makeConfig(),
    status: 'active',
    createdBy: 'acct-1',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    lastRunAt: null,
    lastRunLocalDate: null,
    ...over,
  };
}

export interface SpyAction {
  def: AgentActionDef<Record<string, unknown>>;
  calls: { execute: number; describe: number };
}

export function makeSpyAction(
  key: string,
  opts: { spendsMoney?: boolean; contactsGuest?: boolean; executeResult?: { ok: boolean; result?: unknown; error?: string } } = {},
): SpyAction {
  const calls = { execute: 0, describe: 0 };
  return {
    calls,
    def: {
      key,
      label: { en: key, es: key },
      inputSchema: { type: 'object', properties: {} },
      spendsMoney: opts.spendsMoney ?? false,
      contactsGuest: opts.contactsGuest ?? false,
      validate: (raw: unknown) => ({ value: (raw ?? {}) as Record<string, unknown> }),
      execute: async () => {
        calls.execute += 1;
        return opts.executeResult ?? { ok: true, result: { done: true } };
      },
      describe: () => {
        calls.describe += 1;
        return { params: {}, en: `would ${key}`, es: `haría ${key}` };
      },
    },
  };
}

export function makeTemplate(proposed: ProposedAction[]): AgentTemplate {
  return {
    key: 'test-template',
    defaultConfig: makeConfig(),
    requiredScopes: [],
    plan: () => proposed,
  };
}

interface Store {
  agents: Map<string, Agent>;
  runs: Map<string, AgentRun>;
  steps: AgentActionStep[];
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function makeFakeRepo(store: Store): AgentRepo {
  const notUsed = (m: string) => () => Promise.reject(new Error(`fake repo: ${m} not used in this test`));
  return {
    getAgent: async (id) => store.agents.get(id) ?? null,
    insertRun: async (input) => {
      const id = nextId('run');
      const run: AgentRun = {
        id,
        agentId: input.agentId,
        agentName: 'Test Agent',
        propertyId: input.propertyId,
        triggerSource: input.triggerSource,
        triggeredBy: input.triggeredBy,
        mode: input.mode,
        status: 'running',
        asOfDate: input.asOfDate,
        runLocalDate: input.runLocalDate,
        inputsSnapshot: input.inputsSnapshot ?? {},
        summary: null,
        summaryKey: null,
        summaryParams: {},
        approximations: [],
        error: null,
        startedAt: new Date(FIXED_NOW).toISOString(),
        finishedAt: null,
      };
      store.runs.set(id, run);
      return { ok: true, runId: id };
    },
    finalizeRun: async (runId, patch) => {
      const run = store.runs.get(runId);
      if (run) {
        run.status = patch.status;
        run.summary = patch.summary;
        run.summaryKey = patch.summaryKey;
        run.summaryParams = patch.summaryParams;
        run.approximations = patch.approximations;
        run.error = patch.error;
        run.finishedAt = new Date(FIXED_NOW).toISOString();
        if (patch.inputsSnapshot !== undefined) run.inputsSnapshot = patch.inputsSnapshot;
      }
    },
    rollupRunStatus: async (runId) => {
      const steps = store.steps.filter((s) => s.runId === runId);
      const open = steps.some((s) => s.status === 'pending_approval' || s.status === 'approved');
      let status: RunStatus;
      if (open) status = 'awaiting_approval';
      else {
        const anyFailed = steps.some(
          (s) => s.status === 'executed' && !!s.result && (s.result as { ok?: boolean }).ok === false,
        );
        status = anyFailed ? 'failed' : 'success';
      }
      const run = store.runs.get(runId);
      if (run) run.status = status;
      return status;
    },
    markAgentRan: async (agentId, localDate) => {
      const a = store.agents.get(agentId);
      if (a) {
        a.lastRunAt = new Date(FIXED_NOW).toISOString();
        a.lastRunLocalDate = localDate;
      }
    },
    insertStep: async (input) => {
      const step: AgentActionStep = {
        id: nextId('step'),
        runId: input.runId,
        agentId: input.agentId,
        propertyId: input.propertyId,
        actionKey: input.actionKey,
        payload: input.payload ?? {},
        status: input.status,
        result: input.result ?? null,
        describeKey: input.describeKey ?? null,
        describeParams: input.describeParams ?? {},
        describeEn: input.describeEn ?? '',
        describeEs: input.describeEs ?? '',
        spendsMoney: input.spendsMoney,
        contactsGuest: input.contactsGuest,
        decidedBy: null,
        decidedAt: null,
        createdAt: new Date(FIXED_NOW).toISOString(),
      };
      store.steps.push(step);
      return step;
    },
    getStepWithRun: async (stepId) => {
      const step = store.steps.find((s) => s.id === stepId);
      if (!step) return null;
      const run = store.runs.get(step.runId);
      if (!run) return null;
      return { step: { ...step }, run: { ...run } };
    },
    casApproveStep: async (stepId, decidedBy) => {
      const step = store.steps.find((s) => s.id === stepId);
      if (!step || step.status !== 'pending_approval') return null;
      step.status = 'approved';
      step.decidedBy = decidedBy;
      step.decidedAt = new Date(FIXED_NOW).toISOString();
      return { ...step };
    },
    markStepExecuted: async (stepId, result) => {
      const step = store.steps.find((s) => s.id === stepId);
      if (step && step.status === 'approved') {
        step.status = 'executed';
        step.result = result;
      }
    },
    casRejectStep: async (stepId, decidedBy) => {
      const step = store.steps.find((s) => s.id === stepId);
      if (!step || step.status !== 'pending_approval') return null;
      step.status = 'rejected';
      step.decidedBy = decidedBy;
      step.decidedAt = new Date(FIXED_NOW).toISOString();
      return { ...step };
    },
    // unused-in-tests:
    createAgent: notUsed('createAgent') as AgentRepo['createAgent'],
    listAgents: notUsed('listAgents') as AgentRepo['listAgents'],
    updateAgent: notUsed('updateAgent') as AgentRepo['updateAgent'],
    listActiveScheduleAgents: notUsed('listActiveScheduleAgents') as AgentRepo['listActiveScheduleAgents'],
    listActiveEventAgents: notUsed('listActiveEventAgents') as AgentRepo['listActiveEventAgents'],
    runStatusesForAgentOnDate: notUsed('runStatusesForAgentOnDate') as AgentRepo['runStatusesForAgentOnDate'],
    getRunWithSteps: notUsed('getRunWithSteps') as AgentRepo['getRunWithSteps'],
    listRunsForAgent: notUsed('listRunsForAgent') as AgentRepo['listRunsForAgent'],
    listApprovalQueue: notUsed('listApprovalQueue') as AgentRepo['listApprovalQueue'],
    reapStaleRuns: notUsed('reapStaleRuns') as AgentRepo['reapStaleRuns'],
    purgeOldSnapshots: notUsed('purgeOldSnapshots') as AgentRepo['purgeOldSnapshots'],
    purgeOldActionPii: notUsed('purgeOldActionPii') as AgentRepo['purgeOldActionPii'],
  };
}

export function makeDeps(opts: {
  store: Store;
  actions: AgentActionDef<Record<string, unknown>>[];
  template?: AgentTemplate;
  reason?: (prompt: string) => Promise<string | null>;
}): AgentEngineDeps {
  const actionMap = new Map(opts.actions.map((a) => [a.key, a]));
  return {
    repo: makeFakeRepo(opts.store),
    getAction: (k) => actionMap.get(k) as AgentActionDef<unknown> | undefined,
    getScope: () => undefined,
    getTemplate: () => opts.template,
    makeReasoner: () => opts.reason ?? (async () => null),
    resolveCostAccount: async () => 'acct-1',
    propertyTimezone: async () => 'America/Chicago',
    now: () => FIXED_NOW,
  };
}

export function newStore(agents: Agent[] = []): Store {
  return {
    agents: new Map(agents.map((a) => [a.id, a])),
    runs: new Map(),
    steps: [],
  };
}

export type { Store };
