import {
  AI_FEATURE_KEYS,
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

const HAIKU_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  cachedInputUsdPerMillionTokens: 0.1,
  cacheCreation5mInputUsdPerMillionTokens: 1.25,
  cacheCreation1hInputUsdPerMillionTokens: 2,
  source: 'official-list-price',
  asOf: '2026-07-15',
};
const SONNET_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cachedInputUsdPerMillionTokens: 0.3,
  cacheCreation5mInputUsdPerMillionTokens: 3.75,
  cacheCreation1hInputUsdPerMillionTokens: 6,
  source: 'official-list-price',
  asOf: '2026-07-15',
};
const OPUS_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 25,
  cachedInputUsdPerMillionTokens: 0.5,
  cacheCreation5mInputUsdPerMillionTokens: 6.25,
  cacheCreation1hInputUsdPerMillionTokens: 10,
  source: 'official-list-price',
  asOf: '2026-07-15',
};

// Provider model-list APIs do not publish prices. Unknown Anthropic models use
// a clearly labelled safety estimate at three times the current top verified
// Opus list price. It remains selectable, but is never represented as verified.
export const CONSERVATIVE_ANTHROPIC_PRICING: AiModelPricing = {
  inputUsdPerMillionTokens: 15,
  outputUsdPerMillionTokens: 75,
  cachedInputUsdPerMillionTokens: 1.5,
  cacheCreation5mInputUsdPerMillionTokens: 18.75,
  cacheCreation1hInputUsdPerMillionTokens: 30,
  source: 'conservative-unverified',
  asOf: '2026-07-15',
};

const CLAUDE_CAPABILITIES: AiCapability[] = [
  'text',
  'image_input',
  'pdf_input',
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
  return {
    key,
    group,
    label,
    description,
    runtimeProvider: primary.provider,
    editable: opts.editable ?? true,
    switchable: opts.switchable ?? true,
    modelSwitchable: opts.modelSwitchable ?? true,
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
  return AI_FEATURE_REGISTRY[featureKey].runtimeProvider === provider;
}

export const AI_FEATURE_REGISTRY: Readonly<Record<AiFeatureKey, AiFeatureDefinition>> = {
  'admin.model_recommendations': defineFeature(
    'admin.model_recommendations', 'Admin', 'Model recommendations',
    'Writes the suggestions on the Recommendations tab — reads your model prices, spend, and any newly available models. Runs only when you click refresh.',
    ['text'], SONNET,
  ),
  'agent.ask_staxis': defineFeature(
    'agent.ask_staxis', 'Agent', 'Ask Staxis',
    'The main AI helper — the box at the bottom of the screen where you ask questions and it can take actions for you.',
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
  'financials.invoice_scan': defineFeature(
    'financials.invoice_scan', 'Financials', 'Financial invoice scanning',
    'Reads a vendor invoice photo and pre-fills the expense — who, how much, what for.',
    ['text', 'image_input'], SONNET,
  ),
  'financials.quote_scan': defineFeature(
    'financials.quote_scan', 'Financials', 'Quote scanning',
    'Reads a contractor/vendor quote photo and pulls out the total and line items.',
    ['text', 'image_input'], SONNET,
  ),
  'compliance.photo_reading': defineFeature(
    'compliance.photo_reading', 'Engineering', 'Compliance photo readings',
    'Reads the number off a gauge, meter, or test strip from an engineer photo.',
    ['text', 'image_input'], SONNET,
  ),
  'compliance.text_reading_parse': defineFeature(
    'compliance.text_reading_parse', 'Engineering', 'Compliance reading parser',
    'Turns a typed or spoken engineering reading into a properly logged number.',
    ['text'], SONNET,
  ),
  'compliance.setup_parse': defineFeature(
    'compliance.setup_parse', 'Engineering', 'Compliance setup parser',
    'During setup, turns a manager plain-English equipment description into the compliance checklist.',
    ['text'], SONNET,
  ),
  'compliance.anomaly_phrasing': defineFeature(
    'compliance.anomaly_phrasing', 'Engineering', 'Compliance anomaly phrasing',
    'Writes the short warning message when an equipment reading looks wrong.',
    ['text'], SONNET,
  ),
  'communications.staxis_assistant': defineFeature(
    'communications.staxis_assistant', 'Communications', 'Messaging assistant',
    'Answers when staff type @Staxis in team chat — can check rooms, create work orders, and more.',
    ['text', 'tool_use'], SONNET,
  ),
  'communications.action_detection': defineFeature(
    'communications.action_detection', 'Communications', 'Message action detection',
    'Spots messages like broken-AC reports in team chat and offers a one-tap create-work-order button.',
    ['text'], HAIKU,
  ),
  'communications.unread_summary': defineFeature(
    'communications.unread_summary', 'Communications', 'Unread-message summaries',
    'Writes the what-did-I-miss summary of unread team messages.',
    ['text'], HAIKU,
  ),
  'communications.announcement_polish': defineFeature(
    'communications.announcement_polish', 'Communications', 'Announcement polish',
    'Cleans up a rough manager note into a clear announcement before posting.',
    ['text'], HAIKU,
  ),
  'communications.ui_translation': defineFeature(
    'communications.ui_translation', 'Communications', 'Interface translation',
    'Translates the app buttons and labels for staff who use it in another language.',
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
    'Powers document search in the Knowledge hub. Shown for information only — its model cannot be changed here.',
    ['embeddings'], EMBEDDING,
    {
      editable: false,
      switchable: false,
      modelSwitchable: false,
      fallbackAllowed: false,
      modelLockReason: 'Display only because this fixed vector space is shared with protected Knowledge OCR. Any model change requires a versioned full knowledge re-index.',
    },
  ),
  'speech.ask_staxis_dictation': defineFeature(
    'speech.ask_staxis_dictation', 'Speech & input', 'Ask Staxis dictation',
    'The free talk-to-type used when dictating into Ask Staxis. Runs in the browser — costs nothing, nothing to configure.',
    ['speech_recognition'],
    {
      provider: 'browser', modelId: 'web-speech-recognition',
      displayName: 'Browser Web Speech API', capabilities: ['speech_recognition'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'speech.engineer_dictation': defineFeature(
    'speech.engineer_dictation', 'Speech & input', 'Engineer reading dictation',
    'The free talk-to-type engineers use to speak readings aloud. Runs in the browser — costs nothing, nothing to configure.',
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
