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
  'agent.ask_staxis': defineFeature(
    'agent.ask_staxis', 'Agent', 'Ask Staxis',
    'Main conversational hotel-operations assistant and its action tools.',
    ['text', 'tool_use'], SONNET,
  ),
  'agent.conversation_summary': defineFeature(
    'agent.conversation_summary', 'Agent', 'Conversation summaries',
    'Compresses long assistant conversations into durable context.',
    ['text'], HAIKU,
  ),
  'agent.memory_consolidation': defineFeature(
    'agent.memory_consolidation', 'Agent', 'Memory consolidation',
    'Extracts durable hotel facts and operational patterns from conversations.',
    ['text'], SONNET,
  ),
  'walkthrough.step_generation': defineFeature(
    'walkthrough.step_generation', 'Guidance', 'Guided walkthroughs',
    'Plans the next step in interactive product walkthroughs.',
    ['text', 'tool_use'], SONNET,
  ),
  'inventory.photo_count': defineFeature(
    'inventory.photo_count', 'Inventory', 'Shelf photo counting',
    'Identifies and counts inventory items from a shelf photo.',
    ['text', 'image_input'], SONNET,
  ),
  'inventory.invoice_scan': defineFeature(
    'inventory.invoice_scan', 'Inventory', 'Inventory invoice scanning',
    'Extracts inventory deliveries from invoice photos or PDFs.',
    ['text', 'image_input', 'pdf_input'], SONNET,
  ),
  'financials.invoice_scan': defineFeature(
    'financials.invoice_scan', 'Financials', 'Financial invoice scanning',
    'Extracts payable and line-item information from invoice images.',
    ['text', 'image_input'], SONNET,
  ),
  'financials.quote_scan': defineFeature(
    'financials.quote_scan', 'Financials', 'Quote scanning',
    'Extracts vendor quote totals and line items from images.',
    ['text', 'image_input'], SONNET,
  ),
  'lost_found.photo_description': defineFeature(
    'lost_found.photo_description', 'Front desk', 'Lost-item photo description',
    'Creates a structured description of a photographed lost item.',
    ['text', 'image_input'], SONNET,
  ),
  'lost_found.match_rerank': defineFeature(
    'lost_found.match_rerank', 'Front desk', 'Lost-and-found match reranking',
    'Reranks deterministic lost-item candidate matches using text context.',
    ['text'], HAIKU,
  ),
  'packages.label_scan': defineFeature(
    'packages.label_scan', 'Front desk', 'Package label scanning',
    'Reads recipient and carrier details from package-label photos.',
    ['text', 'image_input'], SONNET,
  ),
  'compliance.photo_reading': defineFeature(
    'compliance.photo_reading', 'Engineering', 'Compliance photo readings',
    'Reads gauges, meters, strips, and other compliance measurements from photos.',
    ['text', 'image_input'], SONNET,
  ),
  'compliance.text_reading_parse': defineFeature(
    'compliance.text_reading_parse', 'Engineering', 'Compliance reading parser',
    'Parses typed or transcribed engineering readings into structured values.',
    ['text'], SONNET,
  ),
  'compliance.setup_parse': defineFeature(
    'compliance.setup_parse', 'Engineering', 'Compliance setup parser',
    'Extracts equipment counts and presence from a manager setup description.',
    ['text'], SONNET,
  ),
  'compliance.anomaly_phrasing': defineFeature(
    'compliance.anomaly_phrasing', 'Engineering', 'Compliance anomaly phrasing',
    'Rewrites detected anomalies into concise, actionable alerts.',
    ['text'], SONNET,
  ),
  'communications.staxis_assistant': defineFeature(
    'communications.staxis_assistant', 'Communications', 'Messaging assistant',
    'Answers @Staxis questions in staff conversations and can use approved tools.',
    ['text', 'tool_use'], SONNET,
  ),
  'communications.action_detection': defineFeature(
    'communications.action_detection', 'Communications', 'Message action detection',
    'Detects work orders and complaints implied by a staff message.',
    ['text'], HAIKU,
  ),
  'communications.unread_summary': defineFeature(
    'communications.unread_summary', 'Communications', 'Unread-message summaries',
    'Summarizes missed staff messages into a short action-oriented brief.',
    ['text'], HAIKU,
  ),
  'communications.announcement_polish': defineFeature(
    'communications.announcement_polish', 'Communications', 'Announcement polish',
    'Rewrites a rough manager note into a clear staff announcement.',
    ['text'], HAIKU,
  ),
  'communications.ui_translation': defineFeature(
    'communications.ui_translation', 'Communications', 'Interface translation',
    'Translates uncached interface phrases for multilingual staff.',
    ['text'], HAIKU,
  ),
  'communications.message_translation': defineFeature(
    'communications.message_translation', 'Communications', 'Message translation',
    'Translates uncached staff messages into each reader’s language.',
    ['text'], HAIKU,
  ),
  'housekeeping.notice_translation': defineFeature(
    'housekeeping.notice_translation', 'Housekeeping', 'Housekeeping notice translation',
    'Translates manager notices for housekeeping staff.',
    ['text'], HAIKU,
  ),
  'communications.announcement_translation': defineFeature(
    'communications.announcement_translation', 'Communications', 'Announcement translation',
    'Translates organization-wide announcements for staff.',
    ['text'], HAIKU,
  ),
  'complaints.classification': defineFeature(
    'complaints.classification', 'Guest service', 'Complaint classification',
    'Classifies guest complaints by severity and operational category.',
    ['text'], HAIKU,
  ),
  'complaints.recovery_draft': defineFeature(
    'complaints.recovery_draft', 'Guest service', 'Service-recovery drafts',
    'Drafts concise guest service-recovery responses.',
    ['text'], HAIKU,
  ),
  'reports.run_summary': defineFeature(
    'reports.run_summary', 'Reports', 'Report-run summaries',
    'Explains the most important findings in an individual report run.',
    ['text'], HAIKU_PINNED,
  ),
  'reports.weekly_insight': defineFeature(
    'reports.weekly_insight', 'Reports', 'Weekly insights',
    'Turns weekly operating metrics into a concise management insight.',
    ['text'], HAIKU_PINNED,
  ),
  'communications.voice_transcription': defineFeature(
    'communications.voice_transcription', 'Communications', 'Voice transcription',
    'Transcribes staff voice-message audio into text.',
    ['audio_transcription'], WHISPER,
  ),
  'knowledge.embeddings': defineFeature(
    'knowledge.embeddings', 'Knowledge', 'Knowledge embeddings',
    'Display only. The fixed shared vector model powers knowledge search and protected Knowledge OCR; changing it requires a versioned full re-index outside this control center.',
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
    'Browser Web Speech recognition used to dictate Ask Staxis messages. Display only; no hosted model is called.',
    ['speech_recognition'],
    {
      provider: 'browser', modelId: 'web-speech-recognition',
      displayName: 'Browser Web Speech API', capabilities: ['speech_recognition'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'speech.engineer_dictation': defineFeature(
    'speech.engineer_dictation', 'Speech & input', 'Engineer reading dictation',
    'Browser Web Speech recognition used to dictate engineering readings. Display only; no hosted model is called.',
    ['speech_recognition'],
    {
      provider: 'browser', modelId: 'web-speech-recognition',
      displayName: 'Browser Web Speech API', capabilities: ['speech_recognition'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.housekeeping_demand': defineFeature(
    'ml.housekeeping_demand', 'In-house ML', 'Housekeeping demand forecast',
    'In-house Bayesian/XGBoost layer that forecasts daily cleaning demand. Display only.',
    ['forecasting'],
    {
      provider: 'in_house', modelId: 'housekeeping-demand-bayesian-xgboost',
      displayName: 'Housekeeping Demand Model', capabilities: ['forecasting'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.housekeeping_supply': defineFeature(
    'ml.housekeeping_supply', 'In-house ML', 'Housekeeping supply forecast',
    'In-house Bayesian room-by-staff cleaning-time model. Display only.',
    ['forecasting'],
    {
      provider: 'in_house', modelId: 'housekeeping-supply-bayesian',
      displayName: 'Housekeeping Supply Model', capabilities: ['forecasting'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.housekeeping_optimizer': defineFeature(
    'ml.housekeeping_optimizer', 'In-house ML', 'Housekeeping optimizer',
    'In-house Monte Carlo/LPT optimizer that recommends staffing headcount. Display only.',
    ['optimization'],
    {
      provider: 'in_house', modelId: 'housekeeping-monte-carlo-lpt',
      displayName: 'Housekeeping Monte Carlo Optimizer', capabilities: ['optimization'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.inventory_consumption': defineFeature(
    'ml.inventory_consumption', 'In-house ML', 'Inventory consumption forecast',
    'In-house Bayesian inventory-rate model that predicts item consumption. Display only.',
    ['forecasting'],
    {
      provider: 'in_house', modelId: 'inventory-rate-bayesian',
      displayName: 'Inventory Consumption Model', capabilities: ['forecasting'], pricing: null,
    },
    { editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false },
  ),
  'ml.daily_report_headcount': defineFeature(
    'ml.daily_report_headcount', 'In-house ML', 'Daily-report headcount forecast',
    'The daily report calls an ML headcount endpoint that is not implemented by the current service. Display only and unavailable.',
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
