/**
 * POST /api/comms/translate  — Body: { pid, texts: string[], target: lang }
 * Powers the app-wide 5-language switcher's auto-translate fallback for UI
 * chrome that lacks a static HT/TL/VI translation. Cache-first (global UI
 * cache), so repeated strings are translated once. Authenticated.
 *
 * RATE LIMIT: keyed on the RAW property UUID (ctx.pid), per the AI-endpoint
 * rule — never a hashed pid:user composite (the fail-closed FK trap). Cached,
 * billing-impacting. Client degrades to source text on any failure/429.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { translateUiStrings } from '@/lib/comms/translate';
import type { CommsLang } from '@/lib/comms/types';
import type { AiUsageReport } from '@/lib/ai/usage';
import { recordAiUsageBestEffort } from '@/lib/ai/usage-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LANGS = ['en', 'es', 'ht', 'tl', 'vi'] as const;

export async function POST(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + 24_000;
  let body: { pid?: string; texts?: unknown; target?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const targetV = validateEnum(body.target, LANGS, 'target');
  if (targetV.error) {
    return err(targetV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  if (!Array.isArray(body.texts)) {
    return err('texts must be an array', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  const texts = (body.texts as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.slice(0, 2000))
    .slice(0, 300);

  if (targetV.value === 'en' || texts.length === 0) {
    // No-op for English / empty — echo back.
    const echo: Record<string, string> = {};
    for (const t of texts) echo[t] = t;
    return ok({ translations: echo }, { requestId: ctx.requestId, headers: ctx.headers });
  }

  // RAW pid (AI-endpoint rule).
  const rl = await checkAndIncrementRateLimit('comms-translate', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  let usage: AiUsageReport | null = null;
  const translations = await translateUiStrings(texts, targetV.value as CommsLang, {
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
    feature: 'communications.ui_translation',
  });
  return ok({ translations }, { requestId: ctx.requestId, headers: ctx.headers });
}
