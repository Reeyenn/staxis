// The wizard's local view-model. Pure types + an empty-state factory; imports
// only contract types so it stays test-safe.

import type { ScopeKey, ActionApprovalMode, AgentEventName } from '@/lib/agents/types';

export type TriggerKind = 'schedule' | 'event';

export interface WizardState {
  /** null until a template is chosen; 'custom' for the guided custom path. */
  templateKey: string | null;
  name: string;
  description: string;
  triggerKind: TriggerKind;
  atLocalTime: string;          // 'HH:MM'
  daysOfWeek: number[];         // 0=Sun..6=Sat; [] = every day
  eventName: AgentEventName | '';
  scopes: ScopeKey[];
  actions: string[];            // selected action keys, order preserved
  modes: Record<string, ActionApprovalMode>;            // per-action dial
  payloads: Record<string, Record<string, unknown>>;    // per-action inputs
}

export function emptyWizardState(): WizardState {
  return {
    templateKey: null,
    name: '',
    description: '',
    triggerKind: 'schedule',
    atLocalTime: '08:00',
    daysOfWeek: [],
    eventName: '',
    scopes: [],
    actions: [],
    modes: {},
    payloads: {},
  };
}
