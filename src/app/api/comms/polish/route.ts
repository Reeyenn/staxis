/**
 * POST /api/comms/polish  — Body: { pid, text }
 * Managers: clean a rough note into a clear announcement (preview only — the
 * manager still reviews + posts via /announce). RATE LIMIT: RAW pid.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { polishAnnouncement } from '@/lib/comms/assistant';
import type { AiUsageReport } from '@/lib/ai/usage';
import { recordAiUsageBestEffort } from '@/lib/ai/usage-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function POST(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + 15_000;
  let body: { pid?: string; text?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  if (!ctx.isManager) {
    return err('only managers can polish announcements', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const tV = validateString(body.text, { max: 2000, label: 'text' });
  if (tV.error) return err(tV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-polish', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  let usage: AiUsageReport | null = null;
  const text = await polishAnnouncement(tV.value!, ctx.lang, {
    deadlineAt,
    abortSignal: req.signal,
    onUsage: (value) => { usage = value; },
  });
  await recordAiUsageBestEffort({
    usage,
    userId: ctx.accountId,
    propertyId: ctx.pid,
    kind: 'background',
    requestId: ctx.requestId,
    feature: 'communications.announcement_polish',
  });
  return ok({ text }, { requestId: ctx.requestId, headers: ctx.headers });
}
