// ─── Generic "custom agent" planner ─────────────────────────────────────────
// Additive Chat-2 file. The engine plans ONLY from a registered template
// (engine: `proposed = template ? template.plan(...) : []`), so a wizard-built
// agent needs a template to do anything. This generic planner makes the custom
// path genuinely runnable today (create → run → test → approve) using the
// actions Staxis already ships — without touching the engine or the contracts.
//
// It is intentionally dumb: it proposes exactly the actions the manager chose,
// each with the payload the wizard collected (stored at config.templateParams
// .payloads[actionKey]). The engine validates each payload via the action's
// validate(); anything invalid is skipped/rejected by the engine as usual. The
// per-action safety dial + the money/guest approval floor still apply at run time.
//
// plan() is PURE + SYNC (no LLM, no I/O) — keeps "Test on a date" reproducible.
// Chat 3 adds named templates (e.g. Morning Turnover) the same way.

import type { AgentTemplate, AgentConfig, ProposedAction, TemplatePlanInput } from '@/lib/agents/types';
import { AGENT_CONFIG_VERSION } from '@/lib/agents/types';
import { registerTemplate } from './registry';

export const CUSTOM_TEMPLATE_KEY = 'custom';

const defaultConfig: AgentConfig = {
  version: AGENT_CONFIG_VERSION,
  trigger: { type: 'schedule', atLocalTime: '08:00' },
  scopes: [],
  actions: [],
  approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'suggest', perAction: {} },
  templateParams: { payloads: {} },
};

export const customTemplate: AgentTemplate = {
  key: CUSTOM_TEMPLATE_KEY,
  defaultConfig,
  requiredScopes: [],
  plan(input: TemplatePlanInput): ProposedAction[] {
    const payloads = (input.config.templateParams?.payloads ?? {}) as Record<string, Record<string, unknown>>;
    return input.config.actions.map((actionKey) => ({
      actionKey,
      payload: payloads[actionKey] ?? {},
      reason: { en: 'Action you configured for this agent', es: 'Acción que configuraste para este agente' },
    }));
  },
};

registerTemplate({
  template: customTemplate,
  name: { en: 'Custom agent', es: 'Agente personalizado' },
  description: {
    en: 'Build an agent from the actions Staxis already supports — guided, not a blank canvas.',
    es: 'Crea un agente con las acciones que Staxis ya admite — guiado, no un lienzo en blanco.',
  },
});
