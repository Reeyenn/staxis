import 'server-only';

import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { log } from '@/lib/log';
import type { AiUsageReport } from './usage';

export const AI_USAGE_LEDGER_WRITE_CONCURRENCY = 8;

/** Record every billable attempt separately so a failed primary and successful
 * fallback keep their actual model attribution in agent_costs.
 *
 * `background` is deliberate for these utility calls (translation, summaries,
 * classification, drafting): they do not participate in the chat request
 * reservation/finalization protocol, whose `request` rows are created only by
 * the agent command pipeline. Audio and vision retain their dedicated ledger
 * kinds and use the existing total-spend preflight where a trusted accounts.id
 * is available. Ledger failure is observable but never changes the feature's
 * user-facing result. */
export async function recordAiUsageBestEffort(opts: {
  usage: AiUsageReport | null;
  userId: string;
  propertyId: string;
  kind: 'background' | 'audio' | 'vision';
  requestId?: string;
  feature: string;
}): Promise<void> {
  if (!opts.usage) return;
  const billable = opts.usage.attempts.filter((attempt) => attempt.costUsd > 0);
  for (let i = 0; i < billable.length; i += AI_USAGE_LEDGER_WRITE_CONCURRENCY) {
    const chunk = billable.slice(i, i + AI_USAGE_LEDGER_WRITE_CONCURRENCY);
    await Promise.all(chunk.map(async (attempt) => {
      try {
        await recordNonRequestCost({
          userId: opts.userId,
          propertyId: opts.propertyId,
          conversationId: null,
          model: attempt.model,
          modelId: attempt.modelId,
          tokensIn: attempt.inputTokens,
          tokensOut: attempt.outputTokens,
          cachedInputTokens: attempt.cachedInputTokens,
          costUsd: attempt.costUsd,
          kind: opts.kind,
        });
      } catch (error) {
        log.error('[ai-usage] agent_costs attribution failed', {
          requestId: opts.requestId,
          feature: opts.feature,
          propertyId: opts.propertyId,
          model: attempt.model,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }));
  }
}
