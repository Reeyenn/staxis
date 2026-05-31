/**
 * POST /api/housekeeper/messages/translate  — Body: { pid, staffId, texts, target }
 * Auto-translate UI strings for the floor messaging view (when the housekeeper
 * subset dictionary lacks a key). Manual capability check + RAW-pid rate limit.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { getStaffRow } from '@/lib/comms/core';
import { translateUiStrings } from '@/lib/comms/translate';
import type { CommsLang } from '@/lib/comms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const LANGS = ['en', 'es', 'ht', 'tl', 'vi'] as const;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };
  let body: { pid?: string; staffId?: string; texts?: unknown; target?: string };
  try { body = await req.json(); } catch { body = {}; }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const targetV = validateEnum(body.target, LANGS, 'target');
  if (targetV.error) return err(targetV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  if (!Array.isArray(body.texts)) return err('texts must be an array', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });

  const staff = await getStaffRow(pidV.value!, staffV.value!);
  if (!staff) return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });

  const texts = (body.texts as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 2000)).slice(0, 200);
  if (targetV.value === 'en' || texts.length === 0) {
    const echo: Record<string, string> = {};
    for (const t of texts) echo[t] = t;
    return ok({ translations: echo }, { requestId, headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-translate', pidV.value!);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const translations = await translateUiStrings(texts, targetV.value as CommsLang);
  return ok({ translations }, { requestId, headers });
}
