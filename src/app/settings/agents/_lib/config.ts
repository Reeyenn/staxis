// Pure config <-> wizard mapping. Imports only contract types + sibling pure
// modules (safety, wizardState) so the unit test loads under react-server.
//
// Invariants enforced here (the server's config-validate does NOT enforce the
// safety floor, so the client is the guard against persisting a forbidden 'auto'):
//   • actions[] and approvalRules.perAction keys are kept in LOCKSTEP — every
//     selected action gets a perAction entry. (migrateConfig rebuilds perAction
//     from actions[] only, so an orphan/missing entry would silently drift.)
//   • every mode is CLAMPED to its action's approvalFloor (no 'auto' for
//     money/guest actions).
//   • moneyOrGuestRequiresApproval is HARDCODED true (no UI ever flips it).

import type { Agent, AgentConfig, ActionApprovalMode, TriggerConfig } from '@/lib/agents/types';
import { AGENT_CONFIG_VERSION } from '@/lib/agents/types';
import { clampMode } from './safety';
import type { WizardState } from './wizardState';

/** action key → its approvalFloor (from the catalog's AgentActionMeta). */
export type ActionFloors = Record<string, ActionApprovalMode>;

export function validTime(hhmm: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm);
}

function triggerFromState(state: WizardState): TriggerConfig {
  if (state.triggerKind === 'event') {
    return { type: 'event', eventName: state.eventName };
  }
  return {
    type: 'schedule',
    atLocalTime: state.atLocalTime,
    ...(state.daysOfWeek.length > 0 && state.daysOfWeek.length < 7 ? { daysOfWeek: [...state.daysOfWeek].sort((a, b) => a - b) } : {}),
  };
}

export function buildAgentConfig(state: WizardState, floors: ActionFloors): AgentConfig {
  const perAction: Record<string, ActionApprovalMode> = {};
  const payloads: Record<string, Record<string, unknown>> = {};
  for (const key of state.actions) {
    const floor = floors[key] ?? 'suggest';
    const desired = state.modes[key] ?? floor;
    perAction[key] = clampMode(desired, floor);
    payloads[key] = state.payloads[key] ?? {};
  }
  return {
    version: AGENT_CONFIG_VERSION,
    trigger: triggerFromState(state),
    scopes: [...state.scopes],
    actions: [...state.actions],
    approvalRules: {
      moneyOrGuestRequiresApproval: true,
      defaultMode: 'suggest',
      perAction,
    },
    templateParams: { payloads },
  };
}

export function configToWizard(agent: Agent, floors: ActionFloors): WizardState {
  const c = agent.config;
  const modes: Record<string, ActionApprovalMode> = {};
  for (const key of c.actions) {
    const floor = floors[key] ?? 'suggest';
    const stored = c.approvalRules.perAction[key] ?? c.approvalRules.defaultMode ?? floor;
    modes[key] = clampMode(stored, floor); // clamp on read so edit mode can't surface a forbidden 'auto'
  }
  const storedPayloads = (c.templateParams?.payloads ?? {}) as Record<string, Record<string, unknown>>;
  const payloads: Record<string, Record<string, unknown>> = {};
  for (const key of c.actions) payloads[key] = storedPayloads[key] ?? {};

  return {
    templateKey: agent.templateKey,
    name: agent.name,
    description: agent.description ?? '',
    triggerKind: c.trigger.type,
    atLocalTime: c.trigger.type === 'schedule' ? c.trigger.atLocalTime : '08:00',
    daysOfWeek: c.trigger.type === 'schedule' ? (c.trigger.daysOfWeek ?? []) : [],
    eventName: c.trigger.type === 'event' ? c.trigger.eventName : '',
    scopes: [...c.scopes],
    actions: [...c.actions],
    modes,
    payloads,
  };
}

/** Core completeness (name + valid trigger + ≥1 action). Payload completeness is
 *  checked separately because it needs the action input schemas. */
export function isCoreComplete(state: WizardState): boolean {
  if (state.name.trim().length === 0) return false;
  if (state.actions.length === 0) return false;
  if (state.triggerKind === 'schedule') return validTime(state.atLocalTime);
  return state.eventName.trim().length > 0;
}

/** True when every selected action has values for all its required input fields. */
export function requiredPayloadsMet(state: WizardState, requiredByAction: Record<string, string[]>): boolean {
  for (const key of state.actions) {
    const required = requiredByAction[key] ?? [];
    const payload = state.payloads[key] ?? {};
    for (const field of required) {
      const v = payload[field];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return false;
    }
  }
  return true;
}
