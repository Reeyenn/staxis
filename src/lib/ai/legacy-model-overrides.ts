import 'server-only';

import { env } from '@/lib/env';
import {
  CONSERVATIVE_ANTHROPIC_PRICING,
  getAiModelOverlay,
} from '@/lib/ai/feature-registry';
import type { AiFeatureKey, AiFeatureSummary, AiModelRef } from '@/lib/ai/types';
import type { AiExecutionPlan } from '@/lib/ai/runtime';

export type LegacyModelTier = 'haiku' | 'sonnet' | 'opus';

export const LEGACY_BASE_MODELS: Record<LegacyModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

export function parseLegacyModelOverrides(
  raw: string | null | undefined,
): Partial<Record<LegacyModelTier, string>> {
  if (!raw) return {};
  const out: Partial<Record<LegacyModelTier, string>> = {};
  for (const pair of raw.split(',')) {
    const [tier, snapshot] = pair.split('=', 2).map((value) => value.trim());
    if (snapshot && (tier === 'haiku' || tier === 'sonnet' || tier === 'opus')) {
      out[tier] = snapshot;
    }
  }
  return out;
}

export const LEGACY_MODEL_OVERRIDES = parseLegacyModelOverrides(env.MODEL_OVERRIDE);

export const EFFECTIVE_LEGACY_MODELS: Record<LegacyModelTier, string> = {
  haiku: LEGACY_MODEL_OVERRIDES.haiku ?? LEGACY_BASE_MODELS.haiku,
  sonnet: LEGACY_MODEL_OVERRIDES.sonnet ?? LEGACY_BASE_MODELS.sonnet,
  opus: LEGACY_MODEL_OVERRIDES.opus ?? LEGACY_BASE_MODELS.opus,
};

/** Features whose code-default path historically flowed through MODELS[tier].
 * Database configurations remain authoritative and are never overlaid. */
export const LEGACY_MODEL_OVERRIDE_FEATURE_TIERS: Readonly<
  Partial<Record<AiFeatureKey, LegacyModelTier>>
> = {
  'agent.ask_staxis': 'sonnet',
  'agent.conversation_summary': 'haiku',
  'agent.memory_consolidation': 'sonnet',
  'walkthrough.step_generation': 'sonnet',
};

export function effectiveLegacyModelRef(
  tier: LegacyModelTier,
  base: AiModelRef,
): AiModelRef {
  const modelId = EFFECTIVE_LEGACY_MODELS[tier];
  if (modelId === base.modelId) return base;
  const overlay = getAiModelOverlay('anthropic', modelId);
  return {
    provider: 'anthropic',
    modelId,
    displayName: overlay?.displayName,
    capabilities: overlay ? [...overlay.capabilities] : base.capabilities ? [...base.capabilities] : undefined,
    // Unknown pinned snapshots stay selectable but use the conservative
    // unverified estimate instead of silently inheriting a cheaper tier rate.
    pricing: overlay?.pricing
      ? { ...overlay.pricing }
      : { ...CONSERVATIVE_ANTHROPIC_PRICING },
  };
}

export function applyLegacyModelOverrideToPlan(
  plan: AiExecutionPlan,
  tier: LegacyModelTier,
): AiExecutionPlan {
  if (plan.config.source === 'database') return plan;
  const primary = effectiveLegacyModelRef(tier, plan.primary);
  if (primary === plan.primary) return plan;
  return {
    ...plan,
    config: { ...plan.config, primary },
    primary,
  };
}

/** Admin-only presentation overlay: activeConfig shows the model actually used
 * by the legacy default path while defaultConfig remains the code default. */
export function applyLegacyModelOverridesToSummaries(
  features: AiFeatureSummary[],
): AiFeatureSummary[] {
  return features.map((feature) => {
    const tier = LEGACY_MODEL_OVERRIDE_FEATURE_TIERS[feature.key];
    if (!tier || feature.activeConfig.source !== 'default') return feature;
    const primary = effectiveLegacyModelRef(tier, feature.activeConfig.primary);
    if (primary === feature.activeConfig.primary) return feature;
    return {
      ...feature,
      activeConfig: { ...feature.activeConfig, primary },
    };
  });
}
