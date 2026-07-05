// POST /api/engineer/voice-log
// Body: { pid, staffId, text, idempotencyKey? }
//
// AI feature #2 (voice logging) for the engineer mobile page. The page captures
// speech on-device (or typed natural language) and posts the transcript here;
// Claude parses it into structured readings ("pool pH 7.4, chlorine 3,
// alkalinity 90"), each matched to a reading type and logged hands-free.

import { NextRequest } from 'next/server';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';
import { requireEngineerStaff, resolveCostAccount } from '@/lib/compliance/api-helpers';
import { parseReadingsFromText, type NlpUsage } from '@/lib/compliance/nlp';
import { findReadingTypeByName, logReading } from '@/lib/compliance/store';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body { pid?: unknown; staffId?: unknown; text?: unknown; idempotencyKey?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const textV = validateString(body.text, { max: 600, label: 'text' });
  if (textV.error) return err(textV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, staffId = staffV.value!, text = textV.value!;
  const idemBase = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length <= 80 ? body.idempotencyKey : null;

  const rl = await checkAndIncrementRateLimit('engineer-voice', pid, { subKey: staffId });
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Security audit 2026-06-26 #1: verify the per-staff link token (body.tok),
  // not the raw (pid, staffId) tuple.
  const gate = await requireEngineerStaff(req, { pid, staffId, requestId, bodyToken: (body as { tok?: unknown } | null)?.tok });
  if (!gate.ok) return gate.response;
  const staff = gate.staff;

  // Budget gate: this is an ACCOUNTLESS public surface that makes a Claude call.
  // Attribute spend to a property owner/GM account and fail closed when over
  // the daily AI budget (Codex finding — voice parsing bypassed the ledger).
  const accountId = await resolveCostAccount(pid);
  if (accountId) {
    const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
    if (!budget.ok) return err(budget.message, { requestId, status: 429, code: budget.reason });
  }

  let usage: NlpUsage | null = null;
  try {
    const parsed = await parseReadingsFromText(text, (u) => { usage = u; });
    const logged: Array<{ name: string; value: number; outOfRange: boolean }> = [];
    const unmatched: string[] = [];
    for (const p of parsed) {
      const type = await findReadingTypeByName(pid, p.metric);
      if (!type) { unmatched.push(p.metric); continue; }
      const result = await logReading({
        pid, readingTypeId: type.id, value: p.value, source: 'voice',
        staffId: staff.id, staffName: staff.name,
        idempotencyKey: idemBase ? `voice:${idemBase}:${type.id}` : null,
      });
      logged.push({ name: type.name, value: p.value, outOfRange: result.outOfRange });
    }
    return ok({ logged, unmatched, parsedCount: parsed.length }, { requestId });
  } catch (e) {
    log.error('[engineer/voice-log] failed', { requestId, pid, staffId, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  } finally {
    // Record the Claude parse cost against the resolved account.
    if (usage && accountId) {
      const u = usage as NlpUsage;
      try {
        await recordNonRequestCost({
          userId: accountId, propertyId: pid, conversationId: null,
          model: u.model, modelId: u.modelId,
          tokensIn: u.inputTokens, tokensOut: u.outputTokens,
          costUsd: u.costUsd, kind: 'audio',
        });
      } catch { /* cost ledger best-effort */ }
    }
  }
}
