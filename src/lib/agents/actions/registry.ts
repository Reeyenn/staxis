// ─── Agent action registry ─────────────────────────────────────────────────
// Map-based, populated by action modules at import time (see ./index.ts).
// Mirrors the existing agent/tools.ts pattern. The wizard (Chat 2) renders
// listActionMeta(); the engine resolves getAction(key).

import type { AgentActionDef, AgentActionMeta, ActionApprovalMode } from '@/lib/agents/types';

const registry = new Map<string, AgentActionDef<unknown>>();

export function registerAction<T>(def: AgentActionDef<T>): void {
  registry.set(def.key, def as unknown as AgentActionDef<unknown>);
}

export function getAction(key: string): AgentActionDef<unknown> | undefined {
  return registry.get(key);
}

export function listActions(): AgentActionDef<unknown>[] {
  return Array.from(registry.values());
}

/** The lowest approval mode the Safety Dial may sit at for this action. */
export function actionApprovalFloor(def: Pick<AgentActionDef, 'spendsMoney' | 'contactsGuest'>): ActionApprovalMode {
  return def.spendsMoney || def.contactsGuest ? 'approve_first' : 'suggest';
}

export function toActionMeta(def: AgentActionDef<unknown>): AgentActionMeta {
  return {
    key: def.key,
    label: def.label,
    spendsMoney: def.spendsMoney,
    contactsGuest: def.contactsGuest,
    inputSchema: def.inputSchema,
    approvalFloor: actionApprovalFloor(def),
  };
}

export function listActionMeta(): AgentActionMeta[] {
  return listActions().map(toActionMeta);
}
