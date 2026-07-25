/**
 * Drip questions — the ONE thing Staxis asks a manager. MANAGEMENT ONLY, service-role.
 *
 * GET  ?propertyId=<uuid>
 *   → { ok, data: { question: { topic, category, en, es } | null } }
 *   The single question this hotel should be asked right now, or null. Serving
 *   it RECORDS the ask (see src/lib/agent/drip-questions.ts) — that write is
 *   what makes an ignored question stay gone for the rest of the day, so this
 *   GET is deliberately not side-effect free.
 *
 * POST { propertyId, topic, answer: 'yes' | 'no' }
 *   → { ok, data: { recorded, storedFact } }
 *   'yes' becomes a human-authored, non-expiring agent_memory fact. 'no' is
 *   recorded as a decline and the question is never asked again. Replays are
 *   idempotent (recorded:false, nothing changes).
 *
 * Auth: requireSession + canManageTeam + the caller must manage the named
 * property. Reads/writes go through supabaseAdmin behind that gate
 * (agent_memory and agent_knowledge_questions are both deny-all to the browser).
 *
 * One deliberate asymmetry: GET answers a non-manager with question:null rather
 * than 403. /feed is a screen every role opens, and a housekeeper landing there
 * has not done anything wrong — they simply never get a card. A POST from a
 * non-manager is a real permission failure and is refused as one.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid, validateEnum, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import { getDripQuestion, answerDripQuestion } from '@/lib/agent/drip-questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadManagerCaller(session.userId);
  // No account row, not a manager, or not this hotel's manager → no card. See
  // the header: a passive screen must not shout at the people it isn't for.
  if (!caller || !managerManagesHotel(caller, pidV.value!)) {
    return ok({ question: null }, { requestId });
  }

  try {
    const question = await getDripQuestion(pidV.value!);
    return ok({ question }, { requestId });
  } catch (e) {
    // A question is a nicety. Never let it break the screen it lives on.
    log.error('[memory/question:GET] failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return ok({ question: null }, { requestId });
  }
}

interface PostBody {
  propertyId?: unknown;
  topic?: unknown;
  answer?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadManagerCaller(session.userId);
  if (!caller) return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!managerManagesHotel(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const topicV = validateString(body.topic, { label: 'topic', min: 1, max: 80 });
  if (topicV.error) return err(topicV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const answerV = validateEnum(body.answer, ['yes', 'no'] as const, 'answer');
  if (answerV.error) return err(answerV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const limit = await checkAndIncrementRateLimit('knowledge-question-answer', pidV.value!);
  if (!limit.allowed) {
    return err('Too many answers, try again shortly', {
      requestId,
      status: 429,
      code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(limit.retryAfterSec) },
    });
  }

  const res = await answerDripQuestion({
    propertyId: pidV.value!,
    topic: topicV.value!,
    answer: answerV.value!,
    actor: { accountId: caller.accountId, name: caller.displayName, role: caller.role },
  });
  if (!res.ok) {
    log.error('[memory/question:POST] answer failed', { requestId, err: res.error });
    return err(res.error ?? 'Failed to save', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ recorded: res.recorded, storedFact: res.storedFact ?? false }, { requestId });
}
