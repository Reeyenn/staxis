/**
 * POST /api/front-desk/lost-and-found/auto-match
 *
 * Given a guest LOST report, suggest open FOUND items that could be it.
 * Deterministic scorer (room + date + category + description overlap), then an
 * optional Claude re-rank for a human-readable "why". Candidates are fetched
 * server-side scoped to the property — a forged id can't widen the pool, and
 * nothing from another hotel can ever enter it.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { captureException } from '@/lib/sentry';
import { validateUuid } from '@/lib/api-validate';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';
import { gateFrontDeskWrite } from '@/lib/lost-and-found/api-gate';
import { fetchRegister, getAppItem } from '@/lib/lost-and-found/store';
import { rankCandidates, aiRerank, type MatchUsage } from '@/lib/lost-and-found/match';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  pid?: string;
  lostId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateFrontDeskWrite<Body>(req, 'lost-found-auto-match');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId, accountId } = gate;

  const idV = validateUuid(body.lostId, 'lostId');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let usage: MatchUsage | null = null;
  try {
    const lost = await getAppItem(pid, idV.value!);
    if (!lost) {
      return err('Lost report not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
      });
    }
    if (lost.type !== 'lost') {
      return err('Item is not a lost report', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    // App-side open found items only (PMS items aren't matchable from the app).
    const register = await fetchRegister(pid);
    const candidates = register.filter(
      (i) => i.source === 'app' && i.type === 'found' && i.status === 'open',
    );

    const ranked = rankCandidates(lost, candidates, { minScore: 12, limit: 8 });
    if (ranked.length === 0) {
      return ok({ matches: [] }, { requestId });
    }

    // AI re-rank (fails safe to deterministic order). Pre-flight budget; if the
    // daily cap is hit we still return the deterministic ranking.
    let aiAllowed = true;
    if (accountId) {
      const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
      aiAllowed = budget.ok;
    }
    const finalRanked = aiAllowed
      ? await aiRerank(lost, ranked, {
          abortSignal: req.signal,
          onUsage: (u) => {
            usage = u;
          },
        })
      : ranked;

    const matches = finalRanked.map((c) => ({
      id: c.item.id,
      score: c.score,
      reasons: c.reasons,
      aiConfidence: 'aiConfidence' in c ? c.aiConfidence : undefined,
      aiReason: 'aiReason' in c ? c.aiReason : undefined,
      item: {
        id: c.item.id,
        itemDescription: c.item.itemDescription,
        category: c.item.category,
        location: c.item.location,
        roomNumber: c.item.roomNumber,
        photoPath: c.item.photoPath,
        occurredAt: c.item.occurredAt,
      },
    }));

    return ok({ matches }, { requestId });
  } catch (e) {
    log.error('lost-found auto-match failed', { requestId, pid, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  } finally {
    if (usage && accountId) {
      const u = usage as MatchUsage;
      try {
        await recordNonRequestCost({
          userId: accountId,
          propertyId: pid,
          conversationId: null,
          model: u.model,
          modelId: u.modelId,
          tokensIn: u.inputTokens,
          tokensOut: u.outputTokens,
          cachedInputTokens: u.cachedInputTokens,
          costUsd: u.costUsd,
          kind: 'background',
        });
      } catch (costErr) {
        const errObj = costErr instanceof Error ? costErr : new Error(String(costErr));
        log.error('lost-found auto-match cost-ledger write failed', { requestId, pid, err: errObj });
        captureException(errObj, {
          subsystem: 'cost-ledger',
          route: 'lost-found-auto-match',
          severity: 'high',
          pid,
        });
      }
    }
  }
}
