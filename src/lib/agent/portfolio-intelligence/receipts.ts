import 'server-only';

import { createHash } from 'node:crypto';

import { scopedDb } from '@/lib/agent/scoped-db';
import type { ProviderRequestAttempt } from '@/lib/agent/llm';
import type { SystemPromptBlocks } from '@/lib/agent/prompts';
import type { AiExecutionPlan } from '@/lib/ai/runtime';
import { normalizeAnthropicUsage } from '@/lib/ai/usage';

import type { PortfolioEvidencePackageV1 } from './evidence';
import type { PortfolioScopeReceiptView } from './engine';
import {
  PORTFOLIO_DETERMINISTIC_RENDERER_VERSION,
  type PortfolioPresentationPlan,
} from './presentation';
import {
  validatePortfolioFindingReceipt,
  type PortfolioFindingReceiptV1,
} from './pattern-contract';

export const PORTFOLIO_MODEL_REQUEST_ARTIFACT_VERSION = 'portfolio-model-request.v1' as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function metricVersions(evidence: PortfolioEvidencePackageV1): Record<string, string> {
  return Object.fromEntries(evidence.metrics.map((metric) => [metric.id, metric.version]));
}

function sourceVersions(evidence: PortfolioEvidencePackageV1): Array<Record<string, string | null>> {
  const unique = new Map<string, Record<string, string | null>>();
  for (const fact of evidence.facts) {
    if (!fact.source) continue;
    const row = {
      propertyId: fact.propertyId,
      metricId: fact.metricId,
      sourceTable: fact.source.sourceTable,
      sourceRecordId: fact.source.sourceRecordId,
      ingestRunId: fact.source.ingestRunId,
      sourceCapturedAt: fact.source.sourceCapturedAt,
      sourceBusinessAsOfDate: fact.source.sourceBusinessAsOfDate ?? null,
      sourceObservedAt: fact.source.sourceObservedAt ?? null,
      sourceKind: fact.source.sourceKind,
      parserName: fact.source.parserName,
      parserVersion: fact.source.parserVersion,
      queryVersion: fact.source.queryVersion ?? null,
    };
    unique.set(JSON.stringify(row), row);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.propertyId}:${left.metricId}`.localeCompare(`${right.propertyId}:${right.metricId}`));
}

/** SHA-256 over the exact prompt block object passed to the provider runtime. */
export function portfolioPromptHash(prompt: {
  stable: string;
  dynamic: string;
  factual: string;
  versionLabel: string;
  stableStamp: string;
}): string {
  return sha256(JSON.stringify({
    stable: prompt.stable,
    dynamic: prompt.dynamic,
    factual: prompt.factual,
    versionLabel: prompt.versionLabel,
    stableStamp: prompt.stableStamp,
  }));
}

function configuredExecution(executionPlan: AiExecutionPlan): Record<string, unknown> {
  const model = (value: AiExecutionPlan['primary'] | null) => value ? {
    provider: value.provider,
    modelId: value.modelId,
    pricing: value.pricing,
  } : null;
  return {
    featureKey: executionPlan.config.featureKey,
    source: executionPlan.config.source,
    versionId: executionPlan.config.versionId,
    version: executionPlan.config.version,
    declaredParameters: executionPlan.config.parameters,
    primary: model(executionPlan.primary),
    fallback: model(executionPlan.fallback),
  };
}

function providerResponseText(attempt: ProviderRequestAttempt): string | null {
  if (!attempt.response) return null;
  return attempt.response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const ROLLING_ARTIFACT_COLUMNS = [
  'finding_versions',
  'authorized_property_ids',
  'selected_property_ids',
] as const;

interface ArtifactInsertResult {
  data: { id: string } | null;
  error: { code?: string; message: string } | null;
}

function isExactRollingArtifactSchemaCacheMiss(
  error: ArtifactInsertResult['error'],
): boolean {
  if (!error || error.code !== 'PGRST204') return false;
  const message = error.message.toLowerCase();
  return (message.includes('schema cache') || message.includes('could not find'))
    && ROLLING_ARTIFACT_COLUMNS.some((column) => message.includes(column));
}

/** A narrowly-scoped rolling bridge for the three columns added after the
 * original artifact table. It retries once only for PostgREST's exact missing
 * column/schema-cache failure; authorization, validation and tenant failures
 * are returned unchanged and never retried. */
export async function insertPortfolioModelRequestArtifactWithCompatibilityBridge(input: {
  row: Record<string, unknown>;
  insert: (row: Record<string, unknown>) => Promise<ArtifactInsertResult>;
}): Promise<{ id: string }> {
  const first = await input.insert(input.row);
  if (first.data && !first.error) return first.data;
  if (!isExactRollingArtifactSchemaCacheMiss(first.error)) {
    throw new Error(
      `portfolio model request artifact persistence failed: ${first.error?.message ?? 'missing row'}`,
    );
  }
  const legacyRow = { ...input.row };
  for (const column of ROLLING_ARTIFACT_COLUMNS) delete legacyRow[column];
  const retry = await input.insert(legacyRow);
  if (retry.error || !retry.data) {
    throw new Error(
      `portfolio model request artifact persistence failed after schema bridge: ${retry.error?.message ?? 'missing row'}`,
    );
  }
  return retry.data;
}

export function validatePortfolioFindingPersistenceReceipt(input: {
  findingVersions: PortfolioFindingReceiptV1;
  receipt: Pick<
    PortfolioScopeReceiptView,
    | 'id'
    | 'accountId'
    | 'organizationId'
    | 'authorizationHash'
    | 'scopeHash'
    | 'authorizedPropertyIds'
    | 'propertyIds'
  >;
  presentationPlan: PortfolioPresentationPlan | null;
}): PortfolioFindingReceiptV1 {
  const findingVersions = validatePortfolioFindingReceipt(input.findingVersions);
  if (findingVersions.organizationId !== input.receipt.organizationId
      || findingVersions.scopeReceiptId !== input.receipt.id
      || findingVersions.scopeHash !== input.receipt.scopeHash) {
    throw new Error('portfolio finding receipt does not match the live request scope');
  }
  if (findingVersions.status !== 'not_mounted') {
    if (findingVersions.accountId !== input.receipt.accountId
        || findingVersions.authorizationHash !== input.receipt.authorizationHash
        || findingVersions.coverage.authorizedPropertyCount
          !== input.receipt.authorizedPropertyIds.length
        || findingVersions.coverage.selectedPropertyCount
          !== input.receipt.propertyIds.length) {
      throw new Error('portfolio finding receipt coverage does not match the live scope arrays');
    }
    const selectedByPlan = new Set(input.presentationPlan?.orderedClaimIds ?? []);
    const expectedDisplayed = findingVersions.projectedClaimIds
      .filter((id) => selectedByPlan.has(id))
      .sort();
    if (!sameJson(expectedDisplayed, [...findingVersions.displayedClaimIds].sort())) {
      throw new Error('portfolio finding receipt display set does not match the persisted plan');
    }
  }
  return findingVersions;
}

/** Fail closed before a service-only artifact is inserted. In particular, a
 * malformed-but-billable 200 must retain its response and usage, while a true
 * pre-response failure must not pretend that either existed. */
function validateProviderRequestAttempts(
  attempts: ProviderRequestAttempt[],
  actualModelId: string,
  modelCandidateText: string,
): ProviderRequestAttempt {
  if (attempts.length < 1 || attempts.length > 2) {
    throw new Error('portfolio receipt requires one primary and at most one fallback attempt');
  }

  for (const [ordinal, attempt] of attempts.entries()) {
    if (attempt.ordinal !== ordinal
        || attempt.requestedModelId.trim().length === 0
        || attempt.request.model !== attempt.requestedModelId) {
      throw new Error('portfolio provider request attempt identity/order mismatch');
    }
    if (attempt.outcome === 'pending') {
      throw new Error('portfolio receipt requires completed exact provider request attempts');
    }
    if (attempt.outcome === 'failed') {
      if (attempt.response !== null
          || attempt.responseModelId !== null
          || attempt.billableUsage !== null
          || !attempt.failureName) {
        throw new Error('portfolio failed provider attempt has contradictory response evidence');
      }
      continue;
    }
    if (!attempt.response
        || !attempt.responseModelId
        || !attempt.billableUsage
        || attempt.response.model !== attempt.responseModelId
        || !sameJson(attempt.billableUsage, normalizeAnthropicUsage(attempt.response.usage))) {
      throw new Error('portfolio completed provider response/usage snapshot mismatch');
    }
    if (attempt.outcome === 'rejected' && !attempt.failureName) {
      throw new Error('portfolio rejected provider response requires a validation failure');
    }
    if (attempt.outcome === 'succeeded' && attempt.failureName !== null) {
      throw new Error('portfolio successful provider response cannot carry a failure');
    }
  }

  const successfulAttempts = attempts.filter((attempt) => attempt.outcome === 'succeeded');
  const successfulAttempt = successfulAttempts[0];
  if (successfulAttempts.length !== 1 || !successfulAttempt) {
    throw new Error('portfolio synthesis must have exactly one successful provider request');
  }
  if (successfulAttempt !== attempts.at(-1)) {
    throw new Error('portfolio successful provider request must be the terminal attempt');
  }
  if (successfulAttempt.responseModelId !== actualModelId) {
    throw new Error('portfolio provider request response model does not match actual usage model');
  }
  if (providerResponseText(successfulAttempt) !== modelCandidateText) {
    throw new Error('portfolio model candidate does not match the successful provider response');
  }
  return successfulAttempt;
}

/**
 * Persists the exact service-only provider request/candidate artifact, then an
 * immutable receipt bound to that artifact, before any answer is released.
 * The raw artifact has a retention policy and is never available through a
 * browser role; hashes remain on the compact receipt for cheap verification.
 */
export async function persistPortfolioQueryReceipt(input: {
  receipt: PortfolioScopeReceiptView;
  evidence: PortfolioEvidencePackageV1;
  conversationId: string | null;
  question: string;
  systemPrompt: SystemPromptBlocks & {
    versionLabel: string;
    stableStamp: string;
  };
  executionPlan: AiExecutionPlan;
  providerRequestAttempts: ProviderRequestAttempt[];
  actualModelId: string | null;
  actualModelTier: string | null;
  knowledgeVersions: Record<string, unknown>;
  findingVersions: PortfolioFindingReceiptV1;
  /** Exact provider output. It must be an ID-only presentation plan and is
   * never shown directly to the user. */
  modelCandidateText: string;
  presentationPlan: PortfolioPresentationPlan | null;
  /** Deterministically rendered answer. A suppressed but otherwise valid
   * answer remains in the service-only replay artifact for incident review. */
  answerText?: string | null;
  statusOverride?: 'completed' | 'partial' | 'abstained' | 'authorization_changed';
}): Promise<string> {
  const anchorPropertyId = input.evidence.selectedPropertyIds[0];
  if (!anchorPropertyId) throw new Error('portfolio receipt requires a selected property anchor');
  if (input.receipt.id !== input.evidence.scopeReceiptId
      || input.receipt.scopeHash !== input.evidence.scopeHash
      || input.receipt.organizationId !== input.evidence.organizationId
      || !sameJson(
        [...input.receipt.authorizedPropertyIds].sort(),
        [...input.evidence.authorizedPropertyIds].sort(),
      )
      || !sameJson(
        [...input.receipt.propertyIds].sort(),
        [...input.evidence.selectedPropertyIds].sort(),
      )) {
    throw new Error('portfolio receipt/evidence scope mismatch');
  }
  if (!input.actualModelId || !input.actualModelTier) {
    throw new Error('portfolio receipt requires the actual provider model identity');
  }
  const findingVersions = validatePortfolioFindingPersistenceReceipt({
    findingVersions: input.findingVersions,
    receipt: input.receipt,
    presentationPlan: input.presentationPlan,
  });

  const normalizedQuestion = input.question.trim();
  if (!normalizedQuestion) throw new Error('portfolio receipt requires a non-empty question');
  const promptHash = portfolioPromptHash(input.systemPrompt);
  const successfulAttempt = validateProviderRequestAttempts(
    input.providerRequestAttempts,
    input.actualModelId,
    input.modelCandidateText,
  );
  const providerRequest = {
    version: PORTFOLIO_MODEL_REQUEST_ARTIFACT_VERSION,
    runtime: 'messages.create',
    attempts: input.providerRequestAttempts,
  };
  const execution = configuredExecution(input.executionPlan);
  const appliedParameters = {
    requestedModelId: successfulAttempt.requestedModelId,
    responseModelId: successfulAttempt.responseModelId,
    provider: successfulAttempt.provider,
    max_tokens: successfulAttempt.request.max_tokens,
    tools: successfulAttempt.request.tools ?? null,
    iterationLimit: 1,
    configuredButNotAppliedByMessagesLoop: input.executionPlan.config.parameters,
  };
  const questionHash = sha256(normalizedQuestion);
  const modelCandidateHash = sha256(input.modelCandidateText);
  const renderedAnswerHash = input.answerText ? sha256(input.answerText) : null;

  const artifactRow = {
      organization_id: input.receipt.organizationId,
      account_id: input.receipt.accountId,
      conversation_id: input.conversationId,
      scope_receipt_id: input.receipt.id,
      authorization_hash: input.receipt.authorizationHash,
      scope_hash: input.receipt.scopeHash,
      artifact_version: PORTFOLIO_MODEL_REQUEST_ARTIFACT_VERSION,
      normalized_question: normalizedQuestion,
      question_hash: questionHash,
      prompt_version: input.systemPrompt.versionLabel,
      prompt_hash: promptHash,
      provider_request: providerRequest,
      provider_request_hash: sha256(JSON.stringify(providerRequest)),
      configured_execution: execution,
      applied_parameters: appliedParameters,
      actual_model_id: input.actualModelId,
      actual_model_tier: input.actualModelTier,
      model_candidate_text: input.modelCandidateText,
      model_candidate_hash: modelCandidateHash,
      presentation_plan: input.presentationPlan,
      presentation_plan_version: input.presentationPlan?.version ?? null,
      renderer_version: PORTFOLIO_DETERMINISTIC_RENDERER_VERSION,
      rendered_answer_text: input.answerText ?? null,
      rendered_answer_hash: renderedAnswerHash,
      authorized_property_ids: input.evidence.authorizedPropertyIds,
      selected_property_ids: input.evidence.selectedPropertyIds,
      finding_versions: findingVersions,
  };
  const artifactInsert = await insertPortfolioModelRequestArtifactWithCompatibilityBridge({
    row: artifactRow,
    insert: async (row) => await scopedDb(anchorPropertyId)
      .from('portfolio_model_request_artifacts')
      .insert(row)
      .select('id')
      .single() as unknown as ArtifactInsertResult,
  });

  const status = input.statusOverride ?? (input.evidence.coverage.reported === 0
    ? 'abstained'
    : input.evidence.partial
      ? 'partial'
      : 'completed');
  const { data, error } = await scopedDb(anchorPropertyId)
    .from('portfolio_query_receipts')
    .insert({
      organization_id: input.receipt.organizationId,
      account_id: input.receipt.accountId,
      conversation_id: input.conversationId,
      scope_receipt_id: input.receipt.id,
      authorization_hash: input.receipt.authorizationHash,
      scope_hash: input.receipt.scopeHash,
      question_hash: questionHash,
      query_plan_version: input.evidence.plan.version,
      evidence_version: input.evidence.version,
      prompt_version: input.systemPrompt.versionLabel,
      prompt_hash: promptHash,
      model_id: input.actualModelId,
      model_tier: input.actualModelTier,
      request_artifact_id: artifactInsert.id,
      model_candidate_hash: modelCandidateHash,
      presentation_plan_version: input.presentationPlan?.version ?? null,
      renderer_version: PORTFOLIO_DETERMINISTIC_RENDERER_VERSION,
      authorized_property_ids: input.evidence.authorizedPropertyIds,
      selected_property_ids: input.evidence.selectedPropertyIds,
      metric_versions: metricVersions(input.evidence),
      source_versions: sourceVersions(input.evidence),
      knowledge_versions: input.knowledgeVersions,
      finding_versions: findingVersions,
      plan: input.evidence.plan,
      evidence: input.evidence,
      answer_hash: renderedAnswerHash,
      status,
      duration_ms: input.evidence.durationMs,
      generated_at: input.evidence.generatedAt,
    })
    .select('id')
    .single() as unknown as {
      data: { id: string } | null;
      error: { message: string } | null;
    };
  if (error || !data) {
    throw new Error(`portfolio query receipt persistence failed: ${error?.message ?? 'missing row'}`);
  }
  return data.id;
}
