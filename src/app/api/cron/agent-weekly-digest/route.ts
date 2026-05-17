/**
 * GET /api/cron/agent-weekly-digest
 *
 * Sundays 09:00 UTC. Pulls the last 7 days of agent activity and
 * sends a short SMS digest to MANAGER_PHONE so Reeyen can see how
 * the AI agent is being used without opening any dashboard.
 *
 * Round 12 follow-up — Reeyen specifically asked for proactive
 * alerting because, as a non-technical founder, he can't read code
 * to spot silent regressions. A weekly buzz on his phone is the
 * minimum "thing happened, glance at it" signal.
 *
 * Auth: CRON_SECRET bearer.
 *
 * SMS shape (one segment if possible):
 *   Staxis weekly · 2026-05-13
 *   42 chats · 18 users · $1.23 spent (3% of cap)
 *   Background: $0.04 · 0 errors · 0 incomplete
 *   New users: 4 · Long convos summarized: 2
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { sendSms } from '@/lib/sms';
import { COST_LIMITS } from '@/lib/agent/cost-controls';
import { captureException } from '@/lib/sentry';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const E164 = /^\+[1-9]\d{10,14}$/;

interface DigestPayload {
  weekStartIso: string;
  weekEndIso: string;
  requestCount: number;
  uniqueUsers: number;
  requestCostUsd: number;
  backgroundCostUsd: number;
  toolErrors: number;
  summariesWritten: number;
  smsSent: boolean;
  smsSkippedReason?: string;
}

async function computeDigest(): Promise<DigestPayload> {
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = now.toISOString();

  // Pull last-7-days agent_costs (state=finalized, not swept by recovery).
  const { data: costs } = await supabaseAdmin
    .from('agent_costs')
    .select('cost_usd, kind, user_id, state, swept_at')
    .eq('state', 'finalized')
    .is('swept_at', null)
    .gte('created_at', weekStartIso);

  const rows = costs ?? [];
  const requestRows = rows.filter(r => r.kind === 'request');
  const backgroundRows = rows.filter(r => r.kind === 'background');

  const requestCostUsd = requestRows.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
  const backgroundCostUsd = backgroundRows.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
  const uniqueUsers = new Set(requestRows.map(r => r.user_id as string)).size;
  const requestCount = requestRows.length;

  // Tool errors this week (is_error=true on tool rows).
  const { count: toolErrors } = await supabaseAdmin
    .from('agent_messages')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'tool')
    .eq('is_error', true)
    .gte('created_at', weekStartIso);

  // Summaries written this week.
  const { count: summariesWritten } = await supabaseAdmin
    .from('agent_messages')
    .select('id', { count: 'exact', head: true })
    .eq('is_summary', true)
    .gte('created_at', weekStartIso);

  return {
    weekStartIso,
    weekEndIso,
    requestCount,
    uniqueUsers,
    requestCostUsd: Math.round(requestCostUsd * 100) / 100,
    backgroundCostUsd: Math.round(backgroundCostUsd * 100) / 100,
    toolErrors: Number(toolErrors ?? 0),
    summariesWritten: Number(summariesWritten ?? 0),
    smsSent: false,
  };
}

function formatDigestSms(d: DigestPayload): string {
  const date = d.weekEndIso.slice(0, 10);
  const capUsd = COST_LIMITS.globalDailyUsd * 7;  // weekly budget
  const capPct = capUsd > 0 ? Math.round((d.requestCostUsd / capUsd) * 100) : 0;

  const lines = [
    `Staxis weekly · ${date}`,
    `${d.requestCount} chats · ${d.uniqueUsers} users · $${d.requestCostUsd.toFixed(2)} spent (${capPct}% of cap)`,
    `Background: $${d.backgroundCostUsd.toFixed(2)} · ${d.toolErrors} tool errors`,
    `Summaries written: ${d.summariesWritten}`,
  ];

  return lines.join('\n');
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    const digest = await computeDigest();

    const phone = (env.OPS_ALERT_PHONE || '').trim();
    if (!phone || !E164.test(phone)) {
      digest.smsSkippedReason = 'MANAGER_PHONE missing or invalid E.164';
      log.warn('[agent-weekly-digest] skipping SMS — phone not configured', { requestId });
    } else {
      try {
        await sendSms(phone, formatDigestSms(digest));
        digest.smsSent = true;
      } catch (smsErr) {
        log.error('[agent-weekly-digest] Twilio send failed', { requestId, err: smsErr });
        captureException(smsErr, { subsystem: 'agent-weekly-digest', failure_mode: 'twilio_send_failed' });
        digest.smsSkippedReason = `twilio failed: ${smsErr instanceof Error ? smsErr.message : String(smsErr)}`;
      }
    }

    await writeCronHeartbeat('agent-weekly-digest', {
      requestId,
      notes: {
        requestCount: digest.requestCount,
        requestCostUsd: digest.requestCostUsd,
        smsSent: digest.smsSent,
        smsSkippedReason: digest.smsSkippedReason,
      },
    });

    return ok(digest, { requestId });
  } catch (e) {
    return err(`weekly digest failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
