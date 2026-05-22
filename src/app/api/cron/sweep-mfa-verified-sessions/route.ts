// Phase 2B / Door B (audit 2026-05-22) — janitorial sweeper for the
// mfa_verified_sessions table.
//
// The table has FK CASCADE on auth.sessions(id), so most rows are
// deleted automatically when a session expires. This sweeper exists as
// a belt-and-suspenders for any drift:
//   - Rows where the auth.sessions row has been removed without the
//     CASCADE firing (rare; defensive)
//   - Rows older than 30 days (the longest realistic refresh-token
//     lifetime — way past Supabase's default JWT refresh window)
//
// Runs every 6 hours via vercel.json cron. Safe to invoke manually:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//        https://hotelops-ai.vercel.app/api/cron/sweep-mfa-verified-sessions

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Hard floor: rows older than this get swept regardless of session existence.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  try {
    const { error: delErr, count } = await supabaseAdmin
      .from('mfa_verified_sessions')
      .delete({ count: 'exact' })
      .lt('verified_at', cutoff);
    if (delErr) {
      log.error('[sweep-mfa-verified-sessions] delete failed', {
        requestId, err: delErr.message,
      });
      return err('Sweep failed', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }
    await writeCronHeartbeat('sweep-mfa-verified-sessions', {
      requestId,
      notes: { swept: count ?? 0 },
    });
    return ok({
      swept: count ?? 0,
      cutoff,
    }, { requestId });
  } catch (e) {
    log.error('[sweep-mfa-verified-sessions] threw', {
      requestId, err: e instanceof Error ? e.message : String(e),
    });
    return err('Sweep threw', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
