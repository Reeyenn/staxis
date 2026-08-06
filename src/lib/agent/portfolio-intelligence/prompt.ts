import 'server-only';

import type { SystemPromptBlocks } from '@/lib/agent/prompts';
import {
  buildPortfolioSystemPrompt,
  type PortfolioPromptInput,
} from '@/lib/agent/portfolio/prompt';

import { formatEvidenceForPrompt, type PortfolioEvidencePackageV1 } from './evidence';
import {
  formatPortfolioPresentationPlanContract,
} from './presentation';
import {
  formatPortfolioFindingProjectionForPrompt,
  type PortfolioFindingProjectionV1,
} from './pattern-contract';
import { PORTFOLIO_PROMPT_VERSION } from './versions';

export interface PortfolioIntelligencePromptInput
  extends PortfolioPromptInput {
  evidence: PortfolioEvidencePackageV1;
  knowledgeBlock?: string | null;
  findingsProjection?: PortfolioFindingProjectionV1 | null;
}

/** One shared agent loop, with a distinct portfolio orchestration layer. The
 * deterministic evidence is always first in the uncached turn block; optional
 * knowledge/findings are references, never allowed to override it. */
export async function buildPortfolioIntelligenceSystemPrompt(
  input: PortfolioIntelligencePromptInput,
): Promise<SystemPromptBlocks> {
  const base = await buildPortfolioSystemPrompt({
    identity: input.identity,
    companyRole: input.companyRole,
    conversationId: input.conversationId,
    now: input.now,
    companyKnowledgeMode: 'external_overlay',
  });
  const evidence = formatEvidenceForPrompt(input.evidence);
  const findingsBlock = input.findingsProjection
    ? formatPortfolioFindingProjectionForPrompt(input.findingsProjection)
    : null;
  const presentationContract = formatPortfolioPresentationPlanContract(
    input.evidence,
    input.findingsProjection,
  );
  const referenceBlocks = [input.knowledgeBlock, findingsBlock]
    .filter((block): block is string => typeof block === 'string' && block.trim().length > 0);
  const dynamic = [
    evidence,
    ...referenceBlocks,
    'Priority rule: canonical metric evidence outranks reference knowledge and pattern findings. Findings can explain where to look; hypotheses are never facts. If sources conflict, disclose the conflict and abstain.',
    presentationContract,
  ].join('\n\n');
  const metricStamp = input.evidence.metrics
    .map((metric) => `${metric.id}@${metric.version}`)
    .sort()
    .join(',');
  return {
    ...base,
    dynamic,
    factual: [base.factual, evidence].filter(Boolean).join('\n\n'),
    versionLabel: [
      base.versionLabel,
      PORTFOLIO_PROMPT_VERSION,
      input.evidence.version,
      input.evidence.plan.version,
      `scope:${input.evidence.scopeHash}`,
      `metrics:${metricStamp}`,
    ].join('+'),
  };
}
