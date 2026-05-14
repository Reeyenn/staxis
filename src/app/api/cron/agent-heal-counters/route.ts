/**
 * GET /api/cron/agent-heal-counters
 *
 * Daily at 04:00 UTC (right after archival at 03:00). Recomputes
 * agent_conversations.message_count + unsummarized_message_count
 * from agent_messages and heals any drift. The drift itself indicates
 * a bug in trigger logic or an RPC path — surfaces drift events to
 * Sentry so a real engineer investigates.
 *
 * Round 12 T12.12, 2026-05-13. The META fix from the round-12 review:
 * implicit invariants in code drift silently. This cron is the
 * counter-side safety net (INV-4, INV-7 in INVARIANTS.md).
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureMessage } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface HealRow {
  conversation_id: string;
  stored_msg_count: number;
  actual_msg_count: number;
  stored_unsum_count: number;
  actual_unsum_count: number;
  healed: boolean;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_heal_conversation_counters', {
      p_dry_run: false,
    });

    if (error) {
      throw new Error(`heal RPC failed: ${error.message}`);
    }

    const healedRows = (data ?? []) as HealRow[];
    const healedCount = healedRows.length;

    // Drift means a bug somewhere. Surface to Sentry so an engineer
    // looks; if every cron silently heals drift, we never learn what
    // produced it.
    if (healedCount > 0) {
      log.warn('[agent-heal-counters] healed counter drift', {
        requestId,
        healedCount,
        sample: healedRows.slice(0, 3),
      });
      captureMessage('agent-heal-counters: drift detected and healed', {
        subsystem: 'agent',
        cron: 'agent-heal-counters',
        healed_count: healedCount,
        sample_conversation_ids: healedRows.slice(0, 5).map(r => r.conversation_id),
      });
    }

    await writeCronHeartbeat('agent-heal-counters', {
      requestId,
      notes: { healedCount, dryRun: false },
    });

    return ok({
      healedCount,
      drift: healedRows.map(r => ({
        conversationId: r.conversation_id,
        msgCount: { stored: r.stored_msg_count, actual: r.actual_msg_count },
        unsumCount: { stored: r.stored_unsum_count, actual: r.actual_unsum_count },
      })),
    }, { requestId });
  } catch (e) {
    return err(`heal-counters cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
