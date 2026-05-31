/**
 * POST /api/comms/detect-action  — Body: { pid, text }
 * Returns whether a message implies an operational action (create work order /
 * log complaint) so the UI can offer a one-tap button. RATE LIMIT: RAW pid.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { detectAction } from '@/lib/comms/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; text?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const tV = validateString(body.text, { max: 2000, label: 'text' });
  if (tV.error) return err(tV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-detect-action', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const action = await detectAction(tV.value!);
  return ok({ action }, { requestId: ctx.requestId, headers: ctx.headers });
}
