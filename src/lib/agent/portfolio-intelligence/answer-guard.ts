import type { SystemPromptBlocks } from '@/lib/agent/prompts';
import {
  buildAnswerReceipt,
  checkAnswerNumbers,
  type NumberGuardResult,
} from '@/lib/agent/number-guard';

import type { PortfolioEvidencePackageV1 } from './evidence';
import type { PortfolioFindingProjectionV1 } from './pattern-contract';
import {
  portfolioFindingNumberReceiptPayloads,
  type PortfolioPresentationPlan,
} from './presentation';

/**
 * Portfolio synthesis is buffered, so an unbacked figure can be stopped before
 * any token reaches the browser. The generic chat loop intentionally disables
 * its number guard for tool-less background jobs; Portfolio Intelligence is a
 * tool-less synthesis over deterministic evidence and therefore opts in here.
 */
export function validatePortfolioAnswerNumbers(input: {
  answer: string;
  systemPrompt: SystemPromptBlocks;
  selectedFindings?: {
    evidence: PortfolioEvidencePackageV1;
    projection: PortfolioFindingProjectionV1;
    plan: PortfolioPresentationPlan;
  } | null;
  findingPayloads?: string[];
}): NumberGuardResult {
  const findingPayloads = input.findingPayloads ?? (input.selectedFindings
    ? portfolioFindingNumberReceiptPayloads({
        evidence: input.selectedFindings.evidence,
        findingsProjection: input.selectedFindings.projection,
        plan: input.selectedFindings.plan,
      })
    : []);
  return checkAnswerNumbers(input.answer, buildAnswerReceipt({
    // Portfolio prompt.dynamic also carries untrusted knowledge/Finding text.
    // Canonical metric evidence is already duplicated into `.factual`; never
    // let arbitrary reference-block numerals become an answer receipt.
    systemPrompt: { ...input.systemPrompt, dynamic: '' },
    // User and prior-assistant text is intentionally not evidence here. The
    // answer states database facts, so "say 9,999 rooms" must not license an
    // otherwise unsupported figure merely because the user supplied it.
    history: [],
    newUserMessage: null,
    // This is not provider/prompt prose. It is the exact deterministic render
    // payload for accepted claim IDs selected by the validated presentation
    // plan. Rejected, out-of-scope, projected-but-unselected findings cannot
    // license a number in the released answer.
    toolPayloads: findingPayloads,
  }));
}
