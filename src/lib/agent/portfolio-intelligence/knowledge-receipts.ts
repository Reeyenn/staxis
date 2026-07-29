import 'server-only';

import { createHash } from 'node:crypto';

import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import { scopedDb } from '@/lib/agent/scoped-db';

import type { CompanyKnowledgeOverlayV1, KnowledgeClaimV1 } from './knowledge';
import {
  PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
  validatePortfolioKnowledgeSelection,
  type PortfolioKnowledgeClaimCatalog,
  type PortfolioKnowledgePresentationSelection,
} from './knowledge-presentation';
import {
  validatePortfolioFindingReceipt,
  type PortfolioFindingReceiptV1,
} from './pattern-contract';
import type { PlannerScopeCatalog, PortfolioQueryPlan } from './schemas';

export const PORTFOLIO_KNOWLEDGE_ARTIFACT_VERSION =
  'portfolio-knowledge-artifact.v1' as const;
export const PORTFOLIO_KNOWLEDGE_EVIDENCE_VERSION =
  'portfolio-knowledge-evidence.v1' as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueClaims(claims: readonly KnowledgeClaimV1[]): KnowledgeClaimV1[] {
  return [...new Map(
    claims.map((claim) => [
      `${claim.provenance.sourceKind}:${claim.provenance.recordId}`,
      claim,
    ]),
  ).values()].sort((left, right) => (
    left.provenance.sourceKind.localeCompare(right.provenance.sourceKind)
      || left.provenance.recordId.localeCompare(right.provenance.recordId)
  ));
}

function selectedSourceClaims(input: {
  catalog: PortfolioKnowledgeClaimCatalog;
  selection: PortfolioKnowledgePresentationSelection;
}): KnowledgeClaimV1[] {
  const verdict = validatePortfolioKnowledgeSelection({
    catalog: input.catalog,
    candidate: input.selection,
  });
  if (!verdict.ok) {
    throw new Error(`knowledge receipt selection rejected: ${verdict.reason}`);
  }
  return uniqueClaims(verdict.claims.flatMap((claim) => [
    ...(claim.companyClaim ? [claim.companyClaim] : []),
    ...claim.propertyClaims,
    ...(claim.effectiveClaim ? [claim.effectiveClaim] : []),
  ]));
}

function sourceVersions(input: {
  catalog: PortfolioKnowledgeClaimCatalog;
  selection: PortfolioKnowledgePresentationSelection;
}): Array<Record<string, string | null>> {
  return selectedSourceClaims(input).map((claim) => ({
    sourceKind: claim.provenance.sourceKind,
    recordId: claim.provenance.recordId,
    organizationId: claim.provenance.organizationId,
    propertyId: claim.provenance.propertyId,
    source: claim.provenance.source,
    reviewState: claim.provenance.reviewState,
    updatedAt: claim.provenance.updatedAt,
    effectiveFrom: claim.provenance.effectiveFrom,
    expiresAt: claim.provenance.expiresAt,
  }));
}

function selectedHotels(input: {
  receipt: AuthorizationScopeReceipt;
  scopeCatalog: PlannerScopeCatalog;
}): Array<{ propertyId: string; propertyName: string }> {
  const byId = new Map(input.scopeCatalog.hotels.map((hotel) => [hotel.propertyId, hotel.name]));
  return [...input.receipt.propertyIds].sort().map((propertyId) => {
    const propertyName = byId.get(propertyId);
    if (!propertyName) {
      throw new Error('knowledge receipt is missing selected authorized hotel metadata');
    }
    return { propertyId, propertyName };
  });
}

/**
 * Persist a deterministic knowledge answer without inventing a provider call.
 * The raw question, exact overlay, selected claims, and exact rendered answer
 * live in the service-only artifact; the compact query receipt carries hashes,
 * scope, versions, and source revisions used by normal conversation replay.
 */
export async function persistPortfolioKnowledgeReceipt(input: {
  receipt: AuthorizationScopeReceipt;
  scopeCatalog: PlannerScopeCatalog;
  plan: PortfolioQueryPlan;
  overlay: CompanyKnowledgeOverlayV1;
  claimCatalog: PortfolioKnowledgeClaimCatalog;
  selection: PortfolioKnowledgePresentationSelection;
  totalMatched: number;
  selectorLabel: string;
  conversationId: string;
  question: string;
  answer: string;
  generatedAt: Date;
  durationMs: number;
  findingVersions: PortfolioFindingReceiptV1;
}): Promise<string> {
  const normalizedQuestion = input.question.trim();
  if (!normalizedQuestion || !input.answer.trim()) {
    throw new Error('knowledge receipt requires a non-empty question and answer');
  }
  if (input.plan.intent !== 'knowledge_lookup'
      || !input.plan.knowledgeQuery
      || input.plan.metricIds.length > 0) {
    throw new Error('knowledge receipt requires a metric-free knowledge query plan');
  }
  if (input.claimCatalog.receipt.id !== input.receipt.id
      || input.claimCatalog.scopeHash !== input.receipt.scopeHash
      || input.overlay !== input.claimCatalog.overlay
      || input.overlay.organizationId !== input.receipt.organizationId) {
    throw new Error('knowledge receipt scope/catalog mismatch');
  }
  const findingVersions = validatePortfolioFindingReceipt(input.findingVersions);
  if (findingVersions.organizationId !== input.receipt.organizationId
      || findingVersions.scopeReceiptId !== input.receipt.id
      || findingVersions.scopeHash !== input.receipt.scopeHash) {
    throw new Error('knowledge receipt finding provenance does not match the exact scope');
  }
  if (findingVersions.status !== 'not_mounted'
      && (findingVersions.accountId !== input.receipt.accountId
        || findingVersions.authorizationHash !== input.receipt.authorizationHash
        || findingVersions.coverage.authorizedPropertyCount
          !== input.receipt.authorizedPropertyIds.length
        || findingVersions.coverage.selectedPropertyCount !== input.receipt.propertyIds.length
        || findingVersions.displayedClaimIds.length !== 0)) {
    throw new Error('knowledge receipt mounted findings do not match the exact non-display scope');
  }
  const selectionVerdict = validatePortfolioKnowledgeSelection({
    catalog: input.claimCatalog,
    candidate: input.selection,
  });
  if (!selectionVerdict.ok
      || !Number.isSafeInteger(input.totalMatched)
      || input.totalMatched < selectionVerdict.claims.length) {
    throw new Error('knowledge receipt selection is not reproducible');
  }
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) {
    throw new Error('knowledge receipt duration must be a non-negative integer');
  }

  const hotels = selectedHotels({ receipt: input.receipt, scopeCatalog: input.scopeCatalog });
  const authorizedPropertyIds = [...input.receipt.authorizedPropertyIds].sort();
  const selectedPropertyIds = [...input.receipt.propertyIds].sort();
  const sources = sourceVersions({ catalog: input.claimCatalog, selection: input.selection });
  const questionHash = sha256(normalizedQuestion);
  const answerHash = sha256(input.answer);
  const generatedAt = input.generatedAt.toISOString();
  const anchorPropertyId = input.receipt.propertyIds[0];
  if (!anchorPropertyId) throw new Error('knowledge receipt requires a selected property anchor');

  const knowledgeVersions = {
    status: 'included',
    artifactVersion: PORTFOLIO_KNOWLEDGE_ARTIFACT_VERSION,
    overlayVersion: input.overlay.version,
    presentationVersion: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
    asOf: input.overlay.asOf,
    sources,
    exclusions: input.overlay.exclusions.map((exclusion) => ({
      sourceKind: exclusion.sourceKind,
      recordId: exclusion.recordId,
      propertyId: exclusion.propertyId,
      reason: exclusion.reason,
    })),
  };
  const evidence = {
    version: PORTFOLIO_KNOWLEDGE_EVIDENCE_VERSION,
    organizationId: input.receipt.organizationId,
    organizationName: input.receipt.organizationName,
    scopeReceiptId: input.receipt.id,
    authorizationHash: input.receipt.authorizationHash,
    scopeHash: input.receipt.scopeHash,
    authorizedPropertyIds,
    selectedPropertyIds,
    generatedAt,
    coverage: {
      authorized: input.receipt.authorizedPropertyCount,
      selected: input.receipt.selectedPropertyCount,
      reported: input.receipt.selectedPropertyCount,
      excluded: 0,
      excludedHotels: [],
    },
    // Conversation replay needs only the exact selected hotel names. Knowledge
    // content remains in the service-only artifact below, never this browser
    // disclosure projection.
    facts: hotels,
    knowledge: {
      versions: knowledgeVersions,
      query: input.plan.knowledgeQuery,
      selection: input.selection,
      totalMatched: input.totalMatched,
    },
  };

  const artifactInsert = await scopedDb(anchorPropertyId)
    .from('portfolio_knowledge_request_artifacts')
    .insert({
      organization_id: input.receipt.organizationId,
      account_id: input.receipt.accountId,
      conversation_id: input.conversationId,
      scope_receipt_id: input.receipt.id,
      authorization_hash: input.receipt.authorizationHash,
      scope_hash: input.receipt.scopeHash,
      artifact_version: PORTFOLIO_KNOWLEDGE_ARTIFACT_VERSION,
      normalized_question: normalizedQuestion,
      question_hash: questionHash,
      query_plan_version: input.plan.version,
      plan: input.plan,
      overlay_version: input.overlay.version,
      presentation_version: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
      authorized_property_ids: authorizedPropertyIds,
      selected_property_ids: selectedPropertyIds,
      selected_claim_ids: input.selection.orderedClaimIds,
      source_versions: sources,
      knowledge_versions: knowledgeVersions,
      finding_versions: findingVersions,
      evidence,
      reproduction_input: {
        overlay: input.overlay,
        selectedHotels: hotels,
        selectorLabel: input.selectorLabel,
        selection: input.selection,
        totalMatched: input.totalMatched,
      },
      rendered_answer_text: input.answer,
      rendered_answer_hash: answerHash,
      duration_ms: input.durationMs,
      generated_at: generatedAt,
    })
    .select('id')
    .single() as unknown as {
      data: { id: string } | null;
      error: { message: string } | null;
    };
  if (artifactInsert.error || !artifactInsert.data) {
    throw new Error(
      `portfolio knowledge artifact persistence failed: ${artifactInsert.error?.message ?? 'missing row'}`,
    );
  }

  const receiptInsert = await scopedDb(anchorPropertyId)
    .from('portfolio_query_receipts')
    .insert({
      organization_id: input.receipt.organizationId,
      account_id: input.receipt.accountId,
      conversation_id: input.conversationId,
      scope_receipt_id: input.receipt.id,
      authorization_hash: input.receipt.authorizationHash,
      scope_hash: input.receipt.scopeHash,
      question_hash: questionHash,
      query_plan_version: input.plan.version,
      evidence_version: PORTFOLIO_KNOWLEDGE_EVIDENCE_VERSION,
      prompt_version: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
      prompt_hash: null,
      model_id: null,
      model_tier: null,
      request_artifact_id: null,
      model_candidate_hash: null,
      presentation_plan_version: null,
      renderer_version: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
      receipt_kind: 'deterministic_knowledge',
      knowledge_artifact_id: artifactInsert.data.id,
      authorized_property_ids: authorizedPropertyIds,
      selected_property_ids: selectedPropertyIds,
      metric_versions: {},
      source_versions: sources,
      knowledge_versions: knowledgeVersions,
      finding_versions: findingVersions,
      plan: input.plan,
      evidence,
      answer_hash: answerHash,
      status: 'completed',
      duration_ms: input.durationMs,
      generated_at: generatedAt,
    })
    .select('id')
    .single() as unknown as {
      data: { id: string } | null;
      error: { message: string } | null;
    };
  if (receiptInsert.error || !receiptInsert.data) {
    throw new Error(
      `portfolio knowledge receipt persistence failed: ${receiptInsert.error?.message ?? 'missing row'}`,
    );
  }
  return receiptInsert.data.id;
}
