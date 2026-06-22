// POST/GET /api/cron/compliance-reminders
//
// AI feature #4 (SMS side). Hourly cron: reminds maintenance staff what's due
// and escalates overdue life-safety checks to the GM/owner by SMS. Per-property
// local-time gating + day-slot SMS idempotency live in reminders.ts.

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { processSmsJobs } from '@/lib/sms-jobs';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { runComplianceRemindersForProperty } from '@/lib/compliance/reminders';
import { runWithConcurrency } from '@/lib/parallel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authErr = requireCronSecret(req);
  if (authErr) return authErr;

  // Properties with compliance definitions configured (don't fan out to the
  // whole fleet — only properties that actually use the feature).
  let propertyIds: string[] = [];
  try {
    const { data } = await supabaseAdmin
      .from('compliance_reading_types')
      .select('property_id')
      .limit(5000);
    const fromReadings = new Set((data ?? []).map((r) => String(r.property_id)));
    const { data: pmData } = await supabaseAdmin
      .from('compliance_pm_tasks')
      .select('property_id')
      .limit(5000);
    for (const r of pmData ?? []) fromReadings.add(String(r.property_id));
    propertyIds = Array.from(fromReadings);
  } catch (e) {
    log.error('[cron/compliance-reminders] property list failed', { requestId, msg: errToString(e) });
    return err('failed to list properties', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Resolve each property's real timezone. Reminders + life-safety escalation
  // SMS gate on the property's LOCAL hour; without this they fired at Chicago
  // time for every hotel, so non-Central hotels got their nudges and overdue
  // escalations at the wrong local hour. (Correctness audit 2026-06-18.)
  const tzById = new Map<string, string>();
  if (propertyIds.length) {
    const { data: tzRows } = await supabaseAdmin
      .from('properties')
      .select('id, timezone')
      .in('id', propertyIds);
    for (const r of tzRows ?? []) {
      tzById.set(String(r.id), (r as { timezone?: string | null }).timezone || 'America/Chicago');
    }
  }

  let remindersSent = 0;
  let escalationsSent = 0;
  // Bounded fan-out (cap 5) instead of an unbounded Promise.allSettled stampede
  // that, at fleet scale, opens one connection per property at once.
  const now = new Date();
  const outcomes = await runWithConcurrency(
    propertyIds,
    (id) => runComplianceRemindersForProperty(id, now, tzById.get(id) ?? 'America/Chicago'),
    5,
  );
  let failed = 0;
  for (const o of outcomes) {
    if (o.ok) {
      remindersSent += o.value.remindersSent;
      escalationsSent += o.value.escalationsSent;
    } else {
      failed += 1;
    }
  }

  // Drain whatever we just enqueued.
  try { await processSmsJobs(100); }
  catch (e) { log.error('[cron/compliance-reminders] drain failed', { requestId, msg: errToString(e) }); }

  await writeCronHeartbeat('compliance-reminders', {
    requestId,
    notes: { properties: propertyIds.length, remindersSent, escalationsSent, failed },
    status: failed > 0 ? 'degraded' : 'ok',
  });

  return ok({ properties: propertyIds.length, remindersSent, escalationsSent }, { requestId });
}

export const GET = handle;
export const POST = handle;
