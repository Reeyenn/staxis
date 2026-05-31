// POST/GET /api/cron/compliance-anomaly-sweep
//
// Engineering Compliance v2 — periodic anomaly safety net. The reading
// write-path catches spikes in real time; this sweep re-evaluates each active
// reading type's recent history for SLOW trends (drift) and stuck/dead meters
// (flatline), and AI-sharpens the wording of new alerts.
//
// AI phrasing is rate-limited + budget-capped, keyed on the RAW pid (the real
// property UUID) — api_limits.property_id has an FK to properties, so a hashed
// composite key would FK-violate and fail closed. Per-property is the bucket.

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { processSmsJobs } from '@/lib/sms-jobs';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import {
  sweepPropertyForAnomalies,
  getUnphrasedActiveAlerts,
  applyAiPhrasing,
} from '@/lib/compliance/anomaly-engine';
import { phraseAnomalies, type NlpUsage } from '@/lib/compliance/nlp';
import { resolveCostAccount } from '@/lib/compliance/api-helpers';
import { assertAudioBudget, recordNonRequestCost } from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function aiPhraseForProperty(pid: string): Promise<number> {
  const alerts = await getUnphrasedActiveAlerts(pid, 8);
  if (alerts.length === 0) return 0;

  // Budget gate first (cheap fail-fast), then rate limit on the RAW pid.
  const accountId = await resolveCostAccount(pid);
  if (accountId) {
    const budget = await assertAudioBudget({ userId: accountId, propertyId: pid });
    if (!budget.ok) return 0; // over budget → keep templated wording
  }
  const rl = await checkAndIncrementRateLimit('compliance-anomaly-phrase', pid);
  if (!rl.allowed) return 0;

  // Need the type name for context.
  const typeIds = Array.from(new Set(alerts.map((a) => a.readingTypeId)));
  const { data: typeRows } = await supabaseAdmin
    .from('compliance_reading_types')
    .select('id, name')
    .in('id', typeIds);
  const nameById = new Map((typeRows ?? []).map((t) => [String(t.id), String(t.name)]));

  let usage: NlpUsage | null = null;
  const phrased = await phraseAnomalies(
    alerts.map((a) => ({ id: a.id, kind: a.kind, typeName: nameById.get(a.readingTypeId) ?? 'reading', reason: a.reason })),
    (u) => { usage = u; },
  );
  for (const p of phrased) {
    await applyAiPhrasing(pid, p.id, p.en, p.es || null);
  }
  if (usage && accountId) {
    const u = usage as NlpUsage;
    try {
      await recordNonRequestCost({
        userId: accountId, propertyId: pid, conversationId: null,
        model: u.model, modelId: u.modelId,
        tokensIn: u.inputTokens, tokensOut: u.outputTokens, costUsd: u.costUsd, kind: 'audio',
      });
    } catch { /* ledger best-effort */ }
  }
  return phrased.length;
}

async function handle(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authErr = requireCronSecret(req);
  if (authErr) return authErr;

  // Only properties that actually configured compliance readings.
  let propertyIds: string[] = [];
  try {
    const { data } = await supabaseAdmin
      .from('compliance_reading_types')
      .select('property_id')
      .eq('active', true)
      .limit(5000);
    propertyIds = Array.from(new Set((data ?? []).map((r) => String(r.property_id))));
  } catch (e) {
    log.error('[cron/compliance-anomaly-sweep] property list failed', { requestId, msg: errToString(e) });
    return err('failed to list properties', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  let detected = 0;
  let phrased = 0;
  let failed = 0;
  for (const pid of propertyIds) {
    try {
      const { recorded } = await sweepPropertyForAnomalies(pid);
      detected += recorded;
      phrased += await aiPhraseForProperty(pid);
    } catch (e) {
      failed += 1;
      log.error('[cron/compliance-anomaly-sweep] property failed', { requestId, pid, msg: errToString(e) });
    }
  }

  // Drain any SMS the sweep enqueued.
  try { await processSmsJobs(100); }
  catch (e) { log.error('[cron/compliance-anomaly-sweep] drain failed', { requestId, msg: errToString(e) }); }

  await writeCronHeartbeat('compliance-anomaly-sweep', {
    requestId,
    notes: { properties: propertyIds.length, detected, phrased, failed },
    status: failed > 0 ? 'degraded' : 'ok',
  });

  return ok({ properties: propertyIds.length, detected, phrased, failed }, { requestId });
}

export const GET = handle;
export const POST = handle;
