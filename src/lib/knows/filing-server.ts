// ═══════════════════════════════════════════════════════════════════════════
// The filing call — the only place the Knows box talks to a model.
//
// One sentence in, one drawer name out. Everything about the SHAPE of that
// answer lives in src/lib/agent/knows-filing.ts, which is pure and tested; this
// file is the provider call, the deadline, and the cost line.
//
//   THIS FUNCTION CANNOT FAIL.
//
// It has no error return, no throw and no null. A provider outage, a switched
// off feature, an exhausted daily budget, a timeout, a refusal, a reply full of
// prose — every one of them lands on `fallbackFiling`, which files the sentence
// as a plain taught fact. That is not defensive coding for its own sake: the
// person on the other end typed a sentence about their hotel and pressed Save,
// and losing it because a classifier was unavailable would be the worst thing
// this screen could do. A slightly wrong drawer costs one tap on Adjust.
//
// COST. Cheapest tier by default (see 'knows.teach_filing' in the AI feature
// registry) and one short call per typed sentence. Spend is booked to the same
// ledger every other non-request model call uses, so it shows up on the
// AI-spend screen instead of hiding inside the chat line.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { runAgent, type UsageReport } from '@/lib/agent/llm';
import { isValidRole, type AppRole } from '@/lib/roles';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { log } from '@/lib/log';
import { withPromiseDeadline } from '@/lib/fetch-deadline';
import {
  FILING_DEADLINE_MS,
  FILING_SYSTEM_PROMPT,
  KNOWS_FILING_FEATURE,
  buildFilingUserMessage,
  fallbackFiling,
  parseFiling,
  type Filed,
} from '@/lib/agent/knows-filing';

export interface FilingRequest {
  sentence: string;
  propertyId: string;
  accountId: string;
  displayName: string | null;
  role: string;
}

/** Which drawer this sentence belongs in. Never throws. */
export async function fileTypedSentence(req: FilingRequest): Promise<Filed> {
  const usages: UsageReport[] = [];
  try {
    const run = await withPromiseDeadline(
      runAgent({
        systemPrompt: { stable: FILING_SYSTEM_PROMPT, dynamic: '' },
        history: [],
        newUserMessage: buildFilingUserMessage(req.sentence),
        tools: [],
        toolContext: {
          user: {
            uid: req.accountId,
            accountId: req.accountId,
            username: 'knows-filing',
            displayName: req.displayName ?? 'Manager',
            // The model has no tools here, so this identity is only ever a
            // label on the run. Coerce rather than widen the caller's type:
            // `commsContext` hands back the operational role as a string.
            role: isValidRole(req.role) ? req.role : ('general_manager' as AppRole),
            propertyAccess: [req.propertyId],
          },
          propertyId: req.propertyId,
          staffId: null,
          requestId: 'knows-filing',
          surface: 'chat',
        },
        model: 'haiku',
        featureKey: KNOWS_FILING_FEATURE,
        onUsage: (usage) => { usages.push(usage); },
      }),
      { timeoutMs: FILING_DEADLINE_MS, label: 'Knows filing' },
    );
    return parseFiling(run.text, req.sentence);
  } catch (e) {
    // Deliberately warn, not error: nothing is broken for the person: their
    // sentence is about to be saved as a fact. The line exists so a filing
    // slot that is down for a week is visible in the logs rather than showing
    // up as "everything I teach it becomes a fact".
    log.warn('[knows-filing] filed as a plain fact', {
      propertyId: req.propertyId,
      err: e instanceof Error ? e.message : 'unknown',
    });
    return fallbackFiling(req.sentence);
  } finally {
    const billable = usages.filter((u) => u.costUsd > 0);
    if (billable.length > 0) {
      const first = billable[0];
      await recordNonRequestCost({
        feature: KNOWS_FILING_FEATURE,
        userId: req.accountId,
        propertyId: req.propertyId,
        conversationId: null,
        model: first.model,
        modelId: first.modelId,
        tokensIn: billable.reduce((s, u) => s + u.inputTokens, 0),
        tokensOut: billable.reduce((s, u) => s + u.outputTokens, 0),
        cachedInputTokens: billable.reduce((s, u) => s + u.cachedInputTokens, 0),
        costUsd: billable.reduce((s, u) => s + u.costUsd, 0),
        kind: 'background',
      }).catch((costErr) => {
        log.error('[knows-filing] cost-ledger write failed', {
          err: costErr instanceof Error ? costErr : new Error(String(costErr)),
          propertyId: req.propertyId,
        });
      });
    }
  }
}
