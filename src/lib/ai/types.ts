export const AI_PROVIDERS = ['anthropic', 'openai', 'browser', 'in_house'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_DISCOVERABLE_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiHostedProvider = (typeof AI_DISCOVERABLE_PROVIDERS)[number];

export const AI_CAPABILITIES = [
  'text',
  'image_input',
  'pdf_input',
  'tool_use',
  'structured_output',
  'audio_transcription',
  'embeddings',
  'speech_recognition',
  'forecasting',
  'optimization',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const AI_FEATURE_KEYS = [
  'agent.ask_staxis',
  'agent.conversation_summary',
  'agent.memory_consolidation',
  'walkthrough.step_generation',
  'inventory.photo_count',
  'inventory.invoice_scan',
  'financials.invoice_scan',
  'financials.quote_scan',
  'compliance.photo_reading',
  'compliance.text_reading_parse',
  'compliance.setup_parse',
  'compliance.anomaly_phrasing',
  'communications.staxis_assistant',
  'communications.action_detection',
  'communications.unread_summary',
  'communications.announcement_polish',
  'communications.ui_translation',
  'communications.message_translation',
  'housekeeping.notice_translation',
  'communications.announcement_translation',
  'complaints.classification',
  'complaints.recovery_draft',
  'reports.run_summary',
  'reports.weekly_insight',
  'communications.voice_transcription',
  'knowledge.embeddings',
  'speech.ask_staxis_dictation',
  'speech.engineer_dictation',
  'ml.housekeeping_demand',
  'ml.housekeeping_supply',
  'ml.housekeeping_optimizer',
  'ml.inventory_consumption',
  'ml.daily_report_headcount',
  'admin.model_recommendations',
] as const;
export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

export type AiFeatureGroup =
  | 'Admin'
  | 'Agent'
  | 'Guidance'
  | 'Inventory'
  | 'Financials'
  | 'Front desk'
  | 'Engineering'
  | 'Communications'
  | 'Housekeeping'
  | 'Guest service'
  | 'Reports'
  | 'Knowledge'
  | 'Speech & input'
  | 'In-house ML';

export interface AiModelPricing {
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  /** Prompt-cache read/hit tokens. */
  cachedInputUsdPerMillionTokens?: number;
  /** Five-minute prompt-cache creation/write tokens. */
  cacheCreation5mInputUsdPerMillionTokens?: number;
  /** One-hour prompt-cache creation/write tokens. */
  cacheCreation1hInputUsdPerMillionTokens?: number;
  usdPerAudioMinute?: number;
  source: string;
  asOf: string;
}

export interface AiModelSelection {
  provider: AiProvider;
  modelId: string;
}

export interface AiModelRef extends AiModelSelection {
  displayName?: string;
  capabilities?: AiCapability[];
  pricing: AiModelPricing | null;
}

export interface AiFeatureDefaultConfig {
  enabled: boolean;
  primary: AiModelRef;
  fallback: AiModelRef | null;
  parameters: Record<string, unknown>;
}

export interface AiFeatureDefinition {
  key: AiFeatureKey;
  label: string;
  description: string;
  group: AiFeatureGroup;
  /** Provider whose SDK/request shape actually implements this feature.
   * Catalog capability metadata alone cannot make another provider runtime-compatible. */
  runtimeProvider: AiProvider;
  editable: boolean;
  switchable: boolean;
  modelSwitchable: boolean;
  fallbackAllowed: boolean;
  modelLockReason?: string;
  availability: 'available' | 'unavailable';
  requiredCapabilities: AiCapability[];
  defaultConfig: AiFeatureDefaultConfig;
}

export interface ResolvedAiFeatureConfig {
  featureKey: AiFeatureKey;
  enabled: boolean;
  primary: AiModelRef;
  fallback: AiModelRef | null;
  parameters: Record<string, unknown>;
  source: 'database' | 'default' | 'fail_closed';
  versionId: string | null;
  version: number | null;
}

export interface AiFeatureSummary extends AiFeatureDefinition {
  activeConfig: ResolvedAiFeatureConfig;
}

export type AiModelCatalogStatus = 'available' | 'unavailable';

export interface AiModelCatalogEntry {
  provider: AiHostedProvider;
  modelId: string;
  displayName: string;
  status: AiModelCatalogStatus;
  available: boolean;
  capabilities: AiCapability[];
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  releasedAt: string | null;
  pricing: AiModelPricing | null;
  source: 'provider' | 'registry' | 'provider+registry';
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export type AiConfigValidationStatus = 'pending' | 'passed' | 'failed';

export interface AiConfigValidationReport {
  valid: boolean;
  checkedAt: string;
  errors: string[];
  warnings: string[];
  requiredCapabilities: AiCapability[];
  primaryCapabilities: AiCapability[];
  fallbackCapabilities: AiCapability[] | null;
  probes: AiConfigProbeResult[];
}

export interface AiConfigProbeResult {
  ok: boolean;
  provider: AiProvider;
  modelId: string;
  kind: 'anthropic_message' | 'openai_embedding' | 'openai_transcription';
  latencyMs: number;
  error?: string;
}

export interface AiConfigVersion {
  id: string;
  featureKey: AiFeatureKey;
  version: number;
  enabled: boolean;
  primary: AiModelRef;
  fallback: AiModelRef | null;
  parameters: Record<string, unknown>;
  validationStatus: AiConfigValidationStatus;
  validationReport: AiConfigValidationReport | Record<string, unknown>;
  validatedAt: string | null;
  validatedBy: string | null;
  validatedByEmail: string | null;
  isActive: boolean;
  parentId: string | null;
  changeReason: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByEmail: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  activatedByEmail: string | null;
}

export interface AiFeaturesResponse {
  features: AiFeatureSummary[];
  providers: AiProvider[];
  generatedAt: string;
}

export interface AiModelsResponse {
  models: AiModelCatalogEntry[];
  provider: AiHostedProvider | null;
}

export interface RefreshAiModelsRequest {
  provider: AiHostedProvider;
}

export interface RefreshAiModelsResponse {
  provider: AiHostedProvider;
  discovered: number;
  available: number;
  refreshedAt: string;
  models: AiModelCatalogEntry[];
}

/** One AI-written model recommendation, already server-validated against the
 * catalog and the feature registry. */
export interface AiRecommendation {
  /** Feature this applies to, or null for general fleet-wide advice. */
  featureKey: AiFeatureKey | null;
  title: string;
  /** Plain-English rationale for a non-technical owner. */
  why: string;
  suggestedPrimary: AiModelSelection | null;
  suggestedFallback: AiModelSelection | null;
  estimatedMonthlySavingsUsd: number | null;
  confidence: 'high' | 'medium' | 'low';
}

/** One saved "Get recommendations" run. */
export interface AiRecommendationReport {
  /** Row id; null only if persisting the fresh run failed (still shown once). */
  id: string | null;
  generatedAt: string;
  modelUsed: string;
  /** 30-day fleet AI spend that grounded the advice (USD). */
  spend30dUsd: number;
  recommendations: AiRecommendation[];
}

export interface AiRecommendationsResponse {
  report: AiRecommendationReport;
}

export interface AiRecommendationReportsResponse {
  reports: AiRecommendationReport[];
}

export interface AiConfigsResponse {
  configs: AiConfigVersion[];
  featureKey: AiFeatureKey | null;
}

export interface CreateAiConfigRequest {
  featureKey: AiFeatureKey;
  enabled: boolean;
  primary: AiModelSelection;
  fallback?: AiModelSelection | null;
  parameters?: Record<string, unknown>;
  parentId?: string | null;
  changeReason?: string | null;
}

export interface CreateAiConfigResponse {
  config: AiConfigVersion;
}

export interface ValidateAiConfigResponse {
  config: AiConfigVersion;
  report: AiConfigValidationReport;
}

export interface ActivateAiConfigRequest {
  expectedActiveId: string | null;
  reason: string;
}

export interface ActivateAiConfigResponse {
  featureKey: AiFeatureKey;
  previousConfigId: string | null;
  activeConfigId: string;
  version: number;
  config: AiConfigVersion;
}
