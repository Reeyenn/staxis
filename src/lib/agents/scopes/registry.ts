// ─── Agent scope registry ───────────────────────────────────────────────────
// Read-domains an agent may SEE. Every reader uses supabaseAdmin (service-role)
// — the engine runs from a cron with NO user JWT, so the anon db/* helpers
// would hit RLS and silently return []. (The repo's #1 bug class, pre-empted.)

import type { AgentScopeDef, AgentScopeMeta, ScopeKey } from '@/lib/agents/types';

const registry = new Map<ScopeKey, AgentScopeDef<unknown>>();

export function registerScope<T>(def: AgentScopeDef<T>): void {
  registry.set(def.key, def as unknown as AgentScopeDef<unknown>);
}

export function getScope(key: ScopeKey): AgentScopeDef<unknown> | undefined {
  return registry.get(key);
}

export function listScopes(): AgentScopeDef<unknown>[] {
  return Array.from(registry.values());
}

export function listScopeMeta(): AgentScopeMeta[] {
  return listScopes().map((s) => ({ key: s.key, label: s.label }));
}
