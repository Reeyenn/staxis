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
  'agent.portfolio_chat',
  'companion.conversation',
  'agent.conversation_summary',
  'agent.memory_consolidation',
  'findings.judge',
  'findings.sweep',
  'findings.brief',
  'walkthrough.step_generation',
  'inventory.photo_count',
  'inventory.invoice_scan',
  'inventory.sheet_import',
  'financials.invoice_scan',
  'financials.quote_scan',
  'communications.staxis_assistant',
  'communications.action_detection',
  'communications.announcement_polish',
  'communications.message_translation',
  'housekeeping.notice_translation',
  'housekeeping.board_photo_read',
  'communications.announcement_translation',
  'complaints.classification',
  'complaints.recovery_draft',
  'reports.run_summary',
  'communications.voice_transcription',
  'knowledge.embeddings',
  'knowledge.fact_extraction',
  'knowledge.document_ocr',
  'speech.ask_staxis_dictation',
  'ml.housekeeping_demand',
  'ml.housekeeping_supply',
  'ml.housekeeping_optimizer',
  'ml.inventory_consumption',
  'ml.daily_report_headcount',
] as const;
export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

// ─── What the cost ledger is allowed to call a spender ──────────────────────
//
// `agent_costs.feature` (migration 0374) answers "which named job spent this",
// which is what lets an AI employee's card show its own bill. Almost every
// answer is an AI Control Center feature key — the registry already governs
// which model each of those calls, so the call site always knows its own key.
//
// ONE SPENDER IS NOT A CONTROL-CENTER FEATURE, and pretending otherwise would
// put a lie in the ledger:
//
//   agent.eval_suite — the eval harness. It drives the chat agent, so its spend
//     would otherwise land on `agent.ask_staxis` and inflate what real managers
//     appear to cost.
//
// `knowledge.document_ocr` USED TO LIVE HERE (2026-07-27). It was ledger-only
// because the page-reading pass ran on the Fly robot with its model pinned in
// cua-service, so there was no model for an admin to switch. That robot was
// decommissioned 2026-07-25 and the OCR pass now runs server-side through
// `vision-extract` — an admin-configurable model like every other scan — so it
// moved up into AI_FEATURE_KEYS. The LABEL STRING IS DELIBERATELY UNCHANGED:
// `agent_costs` rows written by the old worker keep the same name, so the
// employee card's bill history stays continuous across the move.
//
// The union is CLOSED on purpose. Every ledger writer takes an `AiCostFeature`,
// so a new call site cannot invent a label, cannot pass a typo, and cannot omit
// the field — it fails to compile instead of quietly booking spend that no
// employee card can ever find again.
export const AI_LEDGER_ONLY_FEATURES = [
  'agent.eval_suite',
] as const;
export type AiLedgerOnlyFeature = (typeof AI_LEDGER_ONLY_FEATURES)[number];

/** Every value `agent_costs.feature` may hold. */
export type AiCostFeature = AiFeatureKey | AiLedgerOnlyFeature;

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
  /** Provider of this feature's DEFAULT model. Retained as the label shown when
   * a surface needs to name one provider ("implemented by …"), and as the
   * fallback the picker offers first. It is NOT the permission check — use
   * `runtimeProviders` for that. */
  runtimeProvider: AiProvider;
  /**
   * Every provider whose execution path can really run this feature.
   *
   * Derived in feature-registry.ts by intersecting `requiredCapabilities` with
   * what each provider's ADAPTER implements — not with what the provider's
   * models can do in the abstract. That distinction is the whole point: a
   * feature needing `pdf_input` stays Anthropic-only because our OpenAI adapter
   * translates no PDF part, however capable GPT itself may be.
   *
   * Previously this was a single provider derived from the default model, which
   * meant every text feature was pinned to Anthropic purely because Claude
   * happened to be its default — a fact about history rather than about
   * capability.
   */
  runtimeProviders: readonly AiProvider[];
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
  kind: 'anthropic_message' | 'openai_message' | 'openai_embedding' | 'openai_transcription';
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
  configuredProviders: AiHostedProvider[];
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
