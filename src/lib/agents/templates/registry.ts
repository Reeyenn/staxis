// ─── Agent template registry ────────────────────────────────────────────────
// The engine runs ANY AgentTemplate via this registry. This chat ships ZERO
// concrete templates — Chat 3 adds Morning Turnover and imports it from
// ./index.ts. Engine unit tests use a synthetic in-test template.

import type { AgentTemplate, AgentTemplateMeta, BilingualText } from '@/lib/agents/types';

interface TemplateEntry {
  template: AgentTemplate;
  name: BilingualText;
  description: BilingualText;
}

const registry = new Map<string, TemplateEntry>();

export function registerTemplate(entry: TemplateEntry): void {
  registry.set(entry.template.key, entry);
}

export function getTemplate(key: string | null | undefined): AgentTemplate | undefined {
  if (!key) return undefined;
  return registry.get(key)?.template;
}

export function listTemplateMeta(): AgentTemplateMeta[] {
  return Array.from(registry.values()).map((e) => ({
    key: e.template.key,
    name: e.name,
    description: e.description,
    defaultConfig: e.template.defaultConfig,
    requiredScopes: e.template.requiredScopes,
  }));
}
