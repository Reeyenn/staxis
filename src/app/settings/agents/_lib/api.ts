'use client';

// Client fetch layer for the Agent Builder. EVERY agent read/write goes through
// here via fetchWithAuth — NEVER the supabase browser client (the agent tables
// are deny-all RLS; the anon client would return an empty list silently and the
// page would render blank). This file is never imported by the pure unit tests.
//
// parse() is STATUS-FIRST: it unwraps `data` only on `res.ok && body.ok===true`.
// 401/429 and other non-envelope responses are mapped to a structured ApiError
// (429's friendly text lives in `detail`, not `error`). fetchWithAuth THROWS
// SessionEndedError on an unrecoverable session — we let it propagate so the
// in-flight /signin redirect proceeds; callers rethrow it (see isSessionEnded).

import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import type { ApiError } from './format';
import type {
  Agent, AgentRun, AgentRunReceipt, AgentApprovalQueueItem,
  AgentActionMeta, AgentScopeMeta, AgentTemplateMeta, BilingualText, AgentEventName,
  CreateAgentRequest, UpdateAgentRequest, RunNowRequest, RunAgentOutcome, RunStatus, Paginated,
} from '@/lib/agents/types';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface AgentEventMeta {
  name: AgentEventName;
  label: BilingualText;
  payloadKeys: string[];
}
export interface AgentCatalog {
  templates: AgentTemplateMeta[];
  actions: AgentActionMeta[];
  scopes: AgentScopeMeta[];
  events: AgentEventMeta[];
}

export function isSessionEnded(e: unknown): e is SessionEndedError {
  return e instanceof SessionEndedError;
}

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  // fetchWithAuth may throw SessionEndedError — intentionally NOT caught here.
  const res = await fetchWithAuth(url, init);

  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
    return { ok: false, error: { status: 429, code: 'rate_limited', serverDetail: body?.detail ?? body?.error } };
  }

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: string; code?: string; detail?: string }
    | null;

  if (res.ok && body?.ok === true) {
    return { ok: true, data: body.data as T };
  }
  return {
    ok: false,
    error: {
      status: res.status,
      code: body?.code,
      serverDetail: body?.error ?? body?.detail ?? `HTTP ${res.status}`,
    },
  };
}

export const agentsApi = {
  catalog: (pid: string) =>
    request<AgentCatalog>(`/api/agents/catalog?pid=${encodeURIComponent(pid)}`),
  list: (pid: string) =>
    request<{ agents: Agent[] }>(`/api/agents?pid=${encodeURIComponent(pid)}`),
  get: (id: string) =>
    request<{ agent: Agent }>(`/api/agents/${encodeURIComponent(id)}`),
  create: (body: CreateAgentRequest) =>
    request<{ agent: Agent }>(`/api/agents`, jsonInit('POST', body)),
  update: (id: string, body: UpdateAgentRequest) =>
    request<{ agent: Agent }>(`/api/agents/${encodeURIComponent(id)}`, jsonInit('PATCH', body)),
  run: (id: string, body: RunNowRequest) =>
    request<{ outcome: RunAgentOutcome }>(`/api/agents/${encodeURIComponent(id)}/run`, jsonInit('POST', body)),
  runs: (id: string) =>
    request<Paginated<AgentRun>>(`/api/agents/${encodeURIComponent(id)}/runs`),
  queue: (pid: string) =>
    request<{ items: AgentApprovalQueueItem[] }>(`/api/agents/runs?pid=${encodeURIComponent(pid)}&status=awaiting_approval`),
  receipt: (runId: string) =>
    request<{ receipt: AgentRunReceipt }>(`/api/agents/runs/${encodeURIComponent(runId)}`),
  approve: (runId: string, actionId: string) =>
    request<{ runStatus: RunStatus }>(`/api/agents/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/approve`, jsonInit('POST', {})),
  reject: (runId: string, actionId: string) =>
    request<{ runStatus: RunStatus }>(`/api/agents/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/reject`, jsonInit('POST', {})),
};
