import {
  AI_FEATURE_KEYS,
  AI_PROVIDERS,
  type AiCapability,
  type AiFeatureDefinition,
  type AiFeatureGroup,
  type AiFeatureKey,
  type AiModelPricing,
  type AiModelRef,
  type AiProvider,
} from './types';

export { AI_FEATURE_KEYS } from './types';

export interface AiModelOverlay {
  provider: AiProvider;
  modelId: string;
  displayName: string;
  capabilities: AiCapability[];
  pricing: AiModelPricing | null;
}

// ─── THE price table ───────────────────────────────────────────────────────
//
// This block is the ONLY place in the codebase where a model price is written
// down. Everything else — the agent cost estimator, the cost-cap reservation
// sizing, the admin spend screens — derives from here.
//
// It is written down once on purpose. Until 2026-07-25 `src/lib/agent/llm.ts`
// carried a second, hand-maintained table that had silently drifted: it priced
// Opus at $15/$75 per million tokens (the retired Opus 3 rate) against the
// correct $5/$25 below. Nothing was visibly broken only because the one
// price-sensitive consumer — the cost-cap reservation — happens to read the
// Sonnet row, which the two tables agreed on. That was luck, not design.
// `ai-model-pricing-single-source.test.ts` is the guard that keeps it single.
//
// Cache rates are Anthropic's published multiples of the input rate:
// read = 0.1x, 5-minute write = 1.25x, 1-hour write = 2x. Verified against the
// Anthropic list prices on the asOf date below.

/** The three Anthropic tiers the legacy agent routing path selects between. */
export type AnthropicPricingTier = 'haiku' | 'sonnet' | 'opus';

/** Date the rates below were last checked against Anthropic's published list
 * prices. Bump it (and the rates) together — a stale date is the signal. */
const ANTHROPIC_LIST_PRICE_AS_OF = '2026-07-25';

const HAIKU_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  cachedInputUsdPerMillionTokens: 0.1,
  cacheCreation5mInputUsdPerMillionTokens: 1.25,
  cacheCreation1hInputUsdPerMillionTokens: 2,
  source: 'official-list-price',
  asOf: ANTHROPIC_LIST_PRICE_AS_OF,
};
const SONNET_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cachedInputUsdPerMillionTokens: 0.3,
  cacheCreation5mInputUsdPerMillionTokens: 3.75,
  cacheCreation1hInputUsdPerMillionTokens: 6,
  source: 'official-list-price',
  asOf: ANTHROPIC_LIST_PRICE_AS_OF,
};
const OPUS_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 25,
  cachedInputUsdPerMillionTokens: 0.5,
  cacheCreation5mInputUsdPerMillionTokens: 6.25,
  cacheCreation1hInputUsdPerMillionTokens: 10,
  source: 'official-list-price',
  asOf: ANTHROPIC_LIST_PRICE_AS_OF,
};

/** Verified Anthropic list price per tier. The single source of truth. */
export const ANTHROPIC_TIER_PRICING: Readonly<
  Record<AnthropicPricingTier, AiModelPricing>
> = {
  haiku: HAIKU_PRICING,
  sonnet: SONNET_PRICING,
  opus: OPUS_PRICING,
};

/**
 * The verified input/output token rates for a tier, as plain numbers.
 *
 * Every field on `AiModelPricing` is optional (an audio model has no token
 * rates at all), so callers that need the numbers — reservation sizing, the
 * scale-the-hold helpers — would otherwise each hand-roll an `?? 0` and
 * silently price a mispopulated row at zero. Throwing here means a tier
 * without a verified rate fails loudly at the call site instead.
 */
export function anthropicTierTokenRates(tier: AnthropicPricingTier): {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
} {
  const { inputUsdPerMillionTokens, outputUsdPerMillionTokens } = ANTHROPIC_TIER_PRICING[tier];
  if (
    typeof inputUsdPerMillionTokens !== 'number'
    || typeof outputUsdPerMillionTokens !== 'number'
  ) {
    throw new Error(`ANTHROPIC_TIER_PRICING.${tier} is missing verified token rates`);
  }
  return { inputUsdPerMillionTokens, outputUsdPerMillionTokens };
}

/** Multiply every token rate on a verified price by `multiple`, relabelling
 * the result. Rounded to 4dp so a rate like 4.10 can't scale into
 * 12.299999999999999 and surface as a nonsense price on the admin screen. */
function scaleTokenPricing(
  base: AiModelPricing,
  multiple: number,
  label: Pick<AiModelPricing, 'source' | 'asOf'>,
): AiModelPricing {
  const scale = (rate: number | undefined): number | undefined =>
    typeof rate === 'number' ? Math.round(rate * multiple * 10_000) / 10_000 : undefined;
  return {
    inputUsdPerMillionTokens: scale(base.inputUsdPerMillionTokens),
    outputUsdPerMillionTokens: scale(base.outputUsdPerMillionTokens),
    cachedInputUsdPerMillionTokens: scale(base.cachedInputUsdPerMillionTokens),
    cacheCreation5mInputUsdPerMillionTokens: scale(base.cacheCreation5mInputUsdPerMillionTokens),
    cacheCreation1hInputUsdPerMillionTokens: scale(base.cacheCreation1hInputUsdPerMillionTokens),
    ...label,
  };
}

/** Safety factor applied to the top verified tier for unpriced models. */
const CONSERVATIVE_PRICING_MULTIPLE = 3;

// Provider model-list APIs do not publish prices. Unknown Anthropic models use
// a clearly labelled safety estimate at three times the current top verified
// Opus list price. It remains selectable, but is never represented as verified.
// DERIVED, not typed out: when Opus's list price moves, the safety estimate
// must move with it or it quietly stops being 3x anything.
export const CONSERVATIVE_ANTHROPIC_PRICING: AiModelPricing = scaleTokenPricing(
  OPUS_PRICING,
  CONSERVATIVE_PRICING_MULTIPLE,
  { source: 'conservative-unverified', asOf: ANTHROPIC_LIST_PRICE_AS_OF },
);

// ─── OpenAI list prices ─────────────────────────────────────────────────────
//
// Same rule as the Anthropic block above: written down once, here, and nowhere
// else. Checked against OpenAI's published price sheet on the asOf date below
// (https://developers.openai.com/api/docs/pricing — the canonical target of the
// old platform.openai.com/docs/pricing URL).
//
// TWO STRUCTURAL DIFFERENCES from the Anthropic rows, both real rather than
// missing data:
//
//   1. There is no cache-WRITE rate, because OpenAI does not charge one. Its
//      prompt caching is automatic and free to populate; only cache READS are
//      priced, at a published 10% of the input rate. The cacheCreation fields
//      are therefore left undefined rather than set to zero — the adapter never
//      reports creation tokens (see toAnthropicUsage in openai-messages.ts), so
//      the estimator's conservative fallback multiple can never fire, and an
//      absent line item on a price sheet is not the same receipt as a published
//      zero.
//   2. The `pro` tiers publish no cached-input rate at all. Leaving it
//      undefined makes estimateAiCostUsd price their cache reads at the FULL
//      input rate — an overestimate, which is the safe direction.
//
// Models OpenAI still serves but no longer prices publicly (gpt-5, gpt-5.1,
// gpt-5.2 and their snapshots — 123 ids come back from /v1/models today) are
// deliberately absent. Discovery gives an unlisted OpenAI model no capabilities
// and no pricing, so it cannot satisfy any feature's required capabilities and
// cannot be selected. That is the intended outcome: we will not run a hotel's
// spend through a model whose price we cannot cite.

/** Date the OpenAI rates below were last checked against the published sheet.
 * Bump it and the rates together — a stale date is the signal. */
const OPENAI_LIST_PRICE_AS_OF = '2026-07-26';
const OPENAI_PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';

function openAiPricing(
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
  cachedInputUsdPerMillionTokens?: number,
): AiModelPricing {
  return {
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    ...(cachedInputUsdPerMillionTokens === undefined
      ? {}
      : { cachedInputUsdPerMillionTokens }),
    source: OPENAI_PRICE_SOURCE,
    asOf: OPENAI_LIST_PRICE_AS_OF,
  };
}

const GPT_FLAGSHIP_PRICING = openAiPricing(5, 30, 0.5);
const GPT_MID_PRICING = openAiPricing(2.5, 15, 0.25);
const GPT_LUNA_PRICING = openAiPricing(1, 6, 0.1);
const GPT_MINI_PRICING = openAiPricing(0.75, 4.5, 0.075);
const GPT_NANO_PRICING = openAiPricing(0.2, 1.25, 0.02);
const GPT_PRO_PRICING = openAiPricing(30, 180);
const GPT_CODEX_PRICING = openAiPricing(1.75, 14, 0.175);

const CLAUDE_CAPABILITIES: AiCapability[] = [
  'text',
  'image_input',
  'pdf_input',
  'tool_use',
];

/**
 * What the OpenAI chat adapter actually implements — not what OpenAI's models
 * are capable of in general.
 *
 * `pdf_input` is absent on purpose. OpenAI does accept PDF parts, but
 * src/lib/ai/openai-messages.ts translates only text, images and tool calls, so
 * claiming it here would let an admin move invoice scanning onto a GPT model
 * and get a silently blank extraction. Capability metadata in this file is a
 * promise about OUR code path, and it stays one.
 */
const OPENAI_CHAT_CAPABILITIES: AiCapability[] = [
  'text',
  'image_input',
  'tool_use',
];

export const AI_MODEL_OVERLAYS: readonly AiModelOverlay[] = [
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    capabilities: CLAUDE_CAPABILITIES,
    pricing: HAIKU_PRICING,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5 (2025-10-01)',
    capabilities: CLAUDE_CAPABILITIES,
    pricing: HAIKU_PRICING,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    capabilities: CLAUDE_CAPABILITIES,
    pricing: SONNET_PRICING,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    capabilities: CLAUDE_CAPABILITIES,
    // Use the standard list price rather than the temporary launch discount so
    // accounting remains conservative after that promotion expires.
    pricing: SONNET_PRICING,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    capabilities: CLAUDE_CAPABILITIES,
    pricing: OPUS_PRICING,
  },
  // ── OpenAI chat models ──
  // Aliases and their dated snapshots both appear because /v1/models returns
  // both and an admin may pin either; a snapshot always carries its alias's
  // published price.
  {
    provider: 'openai',
    modelId: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_FLAGSHIP_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_MID_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_LUNA_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_FLAGSHIP_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.5-2026-04-23',
    displayName: 'GPT-5.5 (2026-04-23)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_FLAGSHIP_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_PRO_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.5-pro-2026-04-23',
    displayName: 'GPT-5.5 Pro (2026-04-23)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_PRO_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4',
    displayName: 'GPT-5.4',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_MID_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-2026-03-05',
    displayName: 'GPT-5.4 (2026-03-05)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_MID_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_MINI_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-mini-2026-03-17',
    displayName: 'GPT-5.4 Mini (2026-03-17)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_MINI_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_NANO_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-nano-2026-03-17',
    displayName: 'GPT-5.4 Nano (2026-03-17)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_NANO_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-pro',
    displayName: 'GPT-5.4 Pro',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_PRO_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.4-pro-2026-03-05',
    displayName: 'GPT-5.4 Pro (2026-03-05)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_PRO_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_CODEX_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'chat-latest',
    displayName: 'ChatGPT (chat-latest)',
    capabilities: OPENAI_CHAT_CAPABILITIES,
    pricing: GPT_FLAGSHIP_PRICING,
  },
  {
    provider: 'openai',
    modelId: 'whisper-1',
    displayName: 'Whisper 1',
    capabilities: ['audio_transcription'],
    pricing: {
      usdPerAudioMinute: 0.006,
      source: 'application-default',
      asOf: '2026-05',
    },
  },
  {
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    displayName: 'Text Embedding 3 Small',
    capabilities: ['embeddings'],
    pricing: {
      inputUsdPerMillionTokens: 0.02,
      source: 'application-default',
      asOf: '2026-05',
    },
  },
] as const;

function overlayKey(provider: AiProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

const OVERLAY_BY_KEY = new Map(
  AI_MODEL_OVERLAYS.map((entry) => [overlayKey(entry.provider, entry.modelId), entry]),
);

export function getAiModelOverlay(
  provider: AiProvider,
  modelId: string,
): AiModelOverlay | null {
  return OVERLAY_BY_KEY.get(overlayKey(provider, modelId)) ?? null;
}

function model(provider: AiProvider, modelId: string): AiModelRef {
  const overlay = getAiModelOverlay(provider, modelId);
  return {
    provider,
    modelId,
    displayName: overlay?.displayName,
    capabilities: overlay ? [...overlay.capabilities] : undefined,
    pricing: overlay?.pricing ? { ...overlay.pricing } : null,
  };
}

const HAIKU = model('anthropic', 'claude-haiku-4-5');
const HAIKU_PINNED = model('anthropic', 'claude-haiku-4-5-20251001');
const SONNET = model('anthropic', 'claude-sonnet-4-6');
const WHISPER = model('openai', 'whisper-1');
const EMBEDDING = model('openai', 'text-embedding-3-small');

/**
 * What each provider's EXECUTION PATH in this codebase can do — the honest
 * input to "may an admin move this feature there".
 *
 * Read this as a statement about our adapters, not about the providers. OpenAI
 * models handle PDFs; our OpenAI adapter does not, so `pdf_input` is absent and
 * invoice scanning stays on Claude. When the adapter learns a capability, add
 * it here and the picker opens up on its own — there is no second list to keep
 * in sync.
 *
 * `browser` and `in_house` are not model APIs at all: the first is the client
 * side Web Speech API, the second our own forecasters. They appear so that the
 * features they back resolve to exactly themselves.
 */
const PROVIDER_RUNTIME_CAPABILITIES: Readonly<Record<AiProvider, readonly AiCapability[]>> = {
  anthropic: CLAUDE_CAPABILITIES,
  // Chat capabilities come from the Messages adapter; embeddings and
  // transcription are separate OpenAI endpoints this app already calls.
  openai: [...OPENAI_CHAT_CAPABILITIES, 'embeddings', 'audio_transcription'],
  browser: ['speech_recognition'],
  in_house: ['forecasting', 'optimization'],
};

/**
 * The providers that can satisfy every one of `required`.
 *
 * A locked feature short-circuits to its own provider: `modelSwitchable: false`
 * means nobody can move it regardless, and one such feature
 * (`ml.daily_report_headcount`, not wired up yet) declares NO required
 * capabilities — which would otherwise vacuously "match" every provider and
 * advertise an unwired ML stub as runnable on Claude.
 */
function runtimeProvidersFor(
  required: readonly AiCapability[],
  primary: AiProvider,
  modelSwitchable: boolean,
): readonly AiProvider[] {
  if (!modelSwitchable) return [primary];
  const supported = AI_PROVIDERS.filter((provider) =>
    required.every((capability) => PROVIDER_RUNTIME_CAPABILITIES[provider].includes(capability)),
  );
  // A feature whose own default model cannot run it is a registry bug, and a
  // silent one: the picker would offer a set that excludes the model currently
  // serving production. Fail at module load instead.
  if (!supported.includes(primary)) {
    throw new Error(
      `AI feature registry: default model provider "${primary}" cannot satisfy required capabilities ` +
      `[${required.join(', ')}]. Fix the capabilities, the default model, or PROVIDER_RUNTIME_CAPABILITIES.`,
    );
  }
  return supported;
}

function defineFeature(
  key: AiFeatureKey,
  group: AiFeatureGroup,
  label: string,
  description: string,
  requiredCapabilities: AiCapability[],
  primary: AiModelRef,
  opts: {
    enabled?: boolean;
    editable?: boolean;
    switchable?: boolean;
    modelSwitchable?: boolean;
    fallbackAllowed?: boolean;
    modelLockReason?: string;
    availability?: 'available' | 'unavailable';
  } = {},
): AiFeatureDefinition {
  const modelSwitchable = opts.modelSwitchable ?? true;
  return {
    key,
    group,
    label,
    description,
    runtimeProvider: primary.provider,
    runtimeProviders: runtimeProvidersFor(
      requiredCapabilities,
      primary.provider,
      modelSwitchable,
    ),
    editable: opts.editable ?? true,
    switchable: opts.switchable ?? true,
    modelSwitchable,
    fallbackAllowed: opts.fallbackAllowed ?? true,
    ...(opts.modelLockReason ? { modelLockReason: opts.modelLockReason } : {}),
    availability: opts.availability ?? 'available',
    requiredCapabilities,
    defaultConfig: {
      enabled: opts.enabled ?? true,
      primary,
      fallback: null,
      parameters: {},
    },
  };
}

export function isAiFeatureRuntimeProviderCompatible(
  featureKey: AiFeatureKey,
  provider: AiProvider,
): boolean {
  return AI_FEATURE_REGISTRY[featureKey].runtimeProviders.includes(provider);
}

/** Plain-English list of the providers a feature can run on, for the admin
 * surfaces that have to explain a rejected selection. */
export function aiFeatureRuntimeProviderLabel(featureKey: AiFeatureKey): string {
  const providers = AI_FEATURE_REGISTRY[featureKey].runtimeProviders;
  if (providers.length === 1) return providers[0];
  return `${providers.slice(0, -1).join(', ')} or ${providers[providers.length - 1]}`;
}

export const AI_FEATURE_REGISTRY: Readonly<Record<AiFeatureKey, AiFeatureDefinition>> = {
  'agent.ask_staxis': defineFeature(
    'agent.ask_staxis', 'Agent', 'Ask Staxis',
    'The main AI helper: the box at the bottom of the screen where you ask questions and it can take actions for you.',
    ['text', 'tool_use'], SONNET,
  ),
  // Cross-hotel chat. Its own row rather than a share of Ask Staxis: a company
  // question fans out over every hotel the company operates, so its token
  // profile and its blast radius are different, and an operator must be able to
  // move it (or switch it off) without touching the copilot every hotel uses
  // every day.
  'agent.portfolio_chat': defineFeature(
    'agent.portfolio_chat', 'Agent', 'Company-wide questions',
    'Lets an owner or VP ask the helper about all of their company\'s hotels at once, comparing spend, maintenance and open problems across the group. Off unless the company turns it on.',
    ['text', 'tool_use'], SONNET,
  ),
  // The companion bubble's own conversation. Its own row rather than a share
  // of Ask Staxis for one honest reason: it is a DIFFERENT product surface with
  // a different shape of turn. A companion turn starts from a bubble somebody
  // tapped on a screen they were already using, is usually one short question,
  // and is the surface most people will meet the AI through. Reeyen must be
  // able to move it, or drop it to a cheaper model, without touching the chat
  // bar that managers type long questions into all day.
  //
  // A turn is billed here ONLY when it actually came from the companion (the
  // route reads `origin` off the request). Everything typed into the bar stays
  // on agent.ask_staxis, so this knob is never a knob that does nothing.
  'companion.conversation': defineFeature(
    'companion.conversation', 'Agent', 'Companion bubble',
    'The helper bubble in the corner of every screen. Same assistant and same abilities as the main helper: this only decides which model answers when somebody talks to it through the bubble.',
    ['text', 'tool_use'], SONNET,
  ),
  'agent.conversation_summary': defineFeature(
    'agent.conversation_summary', 'Agent', 'Conversation summaries',
    'Shortens long AI chats behind the scenes so the helper remembers earlier parts of the conversation.',
    ['text'], HAIKU,
  ),
  'agent.memory_consolidation': defineFeature(
    'agent.memory_consolidation', 'Agent', 'Memory consolidation',
    'Learns lasting facts about your hotel from conversations so the AI gets smarter over time.',
    ['text'], SONNET,
  ),
  // Sorting and phrasing, not reasoning — so it defaults to the cheapest tier.
  // The numbers it phrases are produced by code and re-checked mechanically
  // afterwards, which is what makes a small model safe here: a smarter one
  // would not be allowed to author anything this one cannot.
  'findings.judge': defineFeature(
    'findings.judge', 'Agent', 'Nightly findings sorter',
    'Puts the problems Staxis noticed overnight in the order a manager should read them and writes each one in plain English and Spanish. It never decides what is wrong, only how to say it and what to show first.',
    ['text'], HAIKU,
  ),
  // Discovery, not decision. It picks from a fixed list of checks against a
  // fixed list of subjects — there is no field in its output where a number
  // could appear — and everything it suggests is then re-tested by a real query
  // before anyone hears about it. A cheap model is not a compromise here: a
  // smarter one would be allowed to author exactly as little.
  'findings.sweep': defineFeature(
    'findings.sweep', 'Agent', 'Weekly pattern sweep',
    'Once a week, for a few hotels at a time, looks over the hotel\'s own totals and suggests things worth watching that nothing checks yet. Every suggestion is re-tested against the real numbers first, and anything that does not hold up is thrown away.',
    ['text'], HAIKU,
  ),
  // Rewording, not writing. The morning brief is assembled from stored numbers
  // by code and is complete before this feature is consulted; all it may do is
  // smooth the sentences, and prose-guard.ts discards the rewrite whole if a
  // number appears in it that the assembly did not put there. Turning this off
  // costs polish and nothing else.
  'findings.brief': defineFeature(
    'findings.brief', 'Agent', 'Morning brief wording',
    'Rewrites the morning summary at the top of the Staxis tab so it reads like a person wrote it. The brief is written in English only. It cannot change any number or add anything to the summary. If it tries, the plain version is used instead.',
    ['text'], HAIKU,
  ),
  'walkthrough.step_generation': defineFeature(
    'walkthrough.step_generation', 'Guidance', 'Guided walkthroughs',
    'Powers the step-by-step guided tours that walk someone through using the app.',
    ['text', 'tool_use'], SONNET,
  ),
  'inventory.photo_count': defineFeature(
    'inventory.photo_count', 'Inventory', 'Shelf photo counting',
    'Counts what is on a shelf from a photo during inventory counts.',
    ['text', 'image_input'], SONNET,
  ),
  'inventory.invoice_scan': defineFeature(
    'inventory.invoice_scan', 'Inventory', 'Inventory invoice scanning',
    'Reads a delivery invoice photo/PDF and pulls out the items that arrived.',
    ['text', 'image_input', 'pdf_input'], SONNET,
  ),
  // Reading a hotel's own spreadsheet is a different job from reading a
  // supplier's invoice, and it gets its own knob for one practical reason: a
  // new hotel fires this a handful of times during setup and then never again,
  // while the invoice scanner fires every week forever. Reeyen must be able to
  // move the setup reader to a cheaper model, or switch it off after onboarding
  // finishes, without touching the scanner Maria uses on Mondays.
  'inventory.sheet_import': defineFeature(
    'inventory.sheet_import', 'Inventory', 'Inventory sheet reading',
    'Reads an inventory or occupancy spreadsheet, PDF or photo the hotel already keeps and turns it into a list to approve. It never saves anything on its own.',
    ['text', 'image_input', 'pdf_input'], SONNET,
  ),
  'financials.invoice_scan': defineFeature(
    'financials.invoice_scan', 'Financials', 'Financial invoice scanning',
    'Reads a vendor invoice photo and pre-fills the expense: who, how much, what for.',
    ['text', 'image_input'], SONNET,
  ),
  'financials.quote_scan': defineFeature(
    'financials.quote_scan', 'Financials', 'Quote scanning',
    'Reads a contractor/vendor quote photo and pulls out the total and line items.',
    ['text', 'image_input'], SONNET,
  ),
  'communications.staxis_assistant': defineFeature(
    'communications.staxis_assistant', 'Communications', 'Messaging assistant',
    'Answers when staff type @Staxis in team chat. Can check rooms, create work orders, and more.',
    ['text', 'tool_use'], SONNET,
  ),
  'communications.action_detection': defineFeature(
    'communications.action_detection', 'Communications', 'Message action detection',
    'Spots messages like broken-AC reports in team chat and offers a one-tap create-work-order button.',
    ['text'], HAIKU,
  ),
  'communications.announcement_polish': defineFeature(
    'communications.announcement_polish', 'Communications', 'Announcement polish',
    'Cleans up a rough manager note into a clear announcement before posting.',
    ['text'], HAIKU,
  ),
  'communications.message_translation': defineFeature(
    'communications.message_translation', 'Communications', 'Message translation',
    'Translates team-chat messages so each person reads them in their own language.',
    ['text'], HAIKU,
  ),
  'housekeeping.notice_translation': defineFeature(
    'housekeeping.notice_translation', 'Housekeeping', 'Housekeeping notice translation',
    'Translates manager notice-board posts into Spanish for housekeepers.',
    ['text'], HAIKU,
  ),
  'housekeeping.board_photo_read': defineFeature(
    'housekeeping.board_photo_read', 'Housekeeping', 'Housekeeping board photo reading',
    'Reads a photo of the paper housekeeping board during first-time setup and pulls out the sections, floors and names it can see. Runs at most once per hotel, and setup finishes fine if it cannot read the photo.',
    ['text', 'image_input'], SONNET,
  ),
  'communications.announcement_translation': defineFeature(
    'communications.announcement_translation', 'Communications', 'Announcement translation',
    'Translates announcements so every staff member reads them in their language.',
    ['text'], HAIKU,
  ),
  'complaints.classification': defineFeature(
    'complaints.classification', 'Guest service', 'Complaint classification',
    'Sorts each guest complaint by how serious it is and what kind of problem it is.',
    ['text'], HAIKU,
  ),
  'complaints.recovery_draft': defineFeature(
    'complaints.recovery_draft', 'Guest service', 'Service-recovery drafts',
    'Drafts the apology and make-it-right message to a guest after a complaint (staff edit before sending).',
    ['text'], HAIKU,
  ),
  'reports.run_summary': defineFeature(
    'reports.run_summary', 'Reports', 'Report-run summaries',
    'Writes the one-line takeaway at the top of each emailed report.',
    ['text'], HAIKU_PINNED,
  ),
  'communications.voice_transcription': defineFeature(
    'communications.voice_transcription', 'Communications', 'Voice transcription',
    'Turns staff voice messages into text.',
    ['audio_transcription'], WHISPER,
  ),
  'knowledge.embeddings': defineFeature(
    'knowledge.embeddings', 'Knowledge', 'Knowledge embeddings',
    'Powers document search in the Knowledge hub. Shown for information only. Its model cannot be changed here.',
    ['embeddings'], EMBEDDING,
    {
      editable: false,
      switchable: false,
      modelSwitchable: false,
      fallbackAllowed: false,
      modelLockReason: 'Display only because this fixed vector space is shared with protected Knowledge OCR. Any model change requires a versioned full knowledge re-index.',
    },
  ),
  'knowledge.fact_extraction': defineFeature(
    'knowledge.fact_extraction', 'Knowledge', 'Learning from what you tell it',
    'Turns a note you type, or a file you drop in, into the short facts about your hotel that show up on the Knows screen for you to confirm.',
    ['text', 'pdf_input'], SONNET,
  ),
  // Declaring pdf_input pins this to Anthropic (runtimeProvidersFor): a scanned
  // PDF rides as a native `document` block, which the OpenAI adapter does not
  // translate. That is the honest constraint, not an oversight — a manager who
  // switched this to a GPT model would get every scanned PDF failing.
  //
  // Ledger-only until 2026-07-27, when the page-reading pass moved off the
  // decommissioned Fly robot and onto vision-extract. See AI_LEDGER_ONLY_FEATURES.
  'knowledge.document_ocr': defineFeature(
    'knowledge.document_ocr', 'Knowledge', 'Reading scanned documents',
    'Reads a scanned PDF or a photo of a page uploaded to the Knowledge hub, so staff can search its text.',
    ['text', 'image_input', 'pdf_input'], SONNET,
  ),
  'speech.ask_staxis_dictation': defineFeature(
    'speech.ask_staxis_dictation', 'Speech & input', 'Ask Staxis dictation',
    'The free talk-to-type used when dictating into Ask Staxis. Runs in the browser. Costs nothing, nothing to configure.',
    ['speech_recognition'],
    {
      provider: 'browser', modelId: 'web-speech-recognition',
      displayName: 'Browser Web Speech API', capabilities: ['speech_recognition'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.housekeeping_demand': defineFeature(
    'ml.housekeeping_demand', 'In-house ML', 'Housekeeping demand forecast',
    'Our own forecasting system that predicts how many rooms need cleaning each day. Shown for information only.',
    ['forecasting'],
    {
      provider: 'in_house', modelId: 'housekeeping-demand-bayesian-xgboost',
      displayName: 'Housekeeping Demand Model', capabilities: ['forecasting'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.housekeeping_supply': defineFeature(
    'ml.housekeeping_supply', 'In-house ML', 'Housekeeping supply forecast',
    'Our own system that learns how long each housekeeper takes per room. Shown for information only.',
    ['forecasting'],
    {
      provider: 'in_house', modelId: 'housekeeping-supply-bayesian',
      displayName: 'Housekeeping Supply Model', capabilities: ['forecasting'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.housekeeping_optimizer': defineFeature(
    'ml.housekeeping_optimizer', 'In-house ML', 'Housekeeping optimizer',
    'Our own system that recommends how many housekeepers to schedule. Shown for information only.',
    ['optimization'],
    {
      provider: 'in_house', modelId: 'housekeeping-monte-carlo-lpt',
      displayName: 'Housekeeping Monte Carlo Optimizer', capabilities: ['optimization'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.inventory_consumption': defineFeature(
    'ml.inventory_consumption', 'In-house ML', 'Inventory consumption forecast',
    'Our own system that predicts how fast you go through supplies. Shown for information only.',
    ['forecasting'],
    {
      provider: 'in_house', modelId: 'inventory-rate-bayesian',
      displayName: 'Inventory Consumption Model', capabilities: ['forecasting'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.daily_report_headcount': defineFeature(
    'ml.daily_report_headcount', 'In-house ML', 'Daily-report headcount forecast',
    'A staffing forecast the daily report will use once it is wired up. Not active yet.',
    [],
    {
      provider: 'in_house', modelId: 'unwired-predict-headcount-endpoint',
      displayName: 'Unavailable /predict/headcount endpoint', capabilities: [], pricing: null,
    },
    {
      enabled: false, editable: false, switchable: false,
      modelSwitchable: false, fallbackAllowed: false, availability: 'unavailable',
    },
  ),
};

export function isAiFeatureKey(value: unknown): value is AiFeatureKey {
  return typeof value === 'string' && AI_FEATURE_KEYS.includes(value as AiFeatureKey);
}

export function getAiFeatureDefinition(featureKey: AiFeatureKey): AiFeatureDefinition {
  return AI_FEATURE_REGISTRY[featureKey];
}

export function listAiFeatureDefinitions(): AiFeatureDefinition[] {
  return AI_FEATURE_KEYS.map((key) => AI_FEATURE_REGISTRY[key]);
}
