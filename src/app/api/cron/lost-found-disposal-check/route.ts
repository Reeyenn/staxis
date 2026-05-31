/**
 * GET /api/cron/lost-found-disposal-check
 *
 * Daily disposal automation for the Lost & Found register:
 *   1. Open FOUND items past their hold_until → auto-moved to 'expired'
 *      (the 90-day hold elapsed — staff can now donate/discard).
 *   2. Open FOUND items within 7 days of hold_until → an in-app nudge to the
 *      property's owners/GMs so nothing is tossed without a heads-up.
 *
 * Staff get in-app nudges (they're signed in); guests get SMS via the separate
 * notify-guest route. Idempotent: one nudge per property per UTC day
 * (dedupe_key), and re-running can't double-expire (status flips to 'expired').
 */

import type { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getNudgeRecipients } from '@/lib/agent/nudges';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { LAF_NEARING_DISPOSAL_DAYS } from '@/lib/lost-and-found/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<Response> {
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;
  const requestId = getOrMintRequestId(req);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const horizonIso = new Date(now + LAF_NEARING_DISPOSAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const dayBucket = Math.floor(now / (24 * 60 * 60 * 1000));

  try {
    const { data, error } = await supabaseAdmin
      .from('lost_and_found_items')
      .select('id, property_id, item_description, hold_until')
      .eq('type', 'found')
      .eq('status', 'open')
      .not('hold_until', 'is', null)
      .lte('hold_until', horizonIso)
      .limit(5000);
    if (error) {
      log.error('lost-found disposal: query failed', { requestId, err: errToString(error) });
      return err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }

    const rows = (data ?? []) as Array<{
      id: string;
      property_id: string;
      item_description: string | null;
      hold_until: string | null;
    }>;

    // Partition expired vs nearing, tally per property.
    const expiredIds: string[] = [];
    const perProperty = new Map<string, { expired: number; nearing: number }>();
    for (const r of rows) {
      // Parse to epoch ms rather than comparing ISO strings (offset/fractional
      // formats from PostgREST would make a string compare unreliable).
      const holdMs = r.hold_until ? Date.parse(r.hold_until) : NaN;
      const isExpired = Number.isFinite(holdMs) && holdMs <= now;
      const bucket = perProperty.get(r.property_id) ?? { expired: 0, nearing: 0 };
      if (isExpired) {
        expiredIds.push(r.id);
        bucket.expired += 1;
      } else {
        bucket.nearing += 1;
      }
      perProperty.set(r.property_id, bucket);
    }

    // Auto-expire in one bulk update. Re-assert the predicates (type/open/past
    // hold) so an item a staffer returned/shipped/disposed between our SELECT
    // and this UPDATE is never clobbered back to 'expired'.
    if (expiredIds.length > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('lost_and_found_items')
        .update({ status: 'expired' })
        .in('id', expiredIds)
        .eq('type', 'found')
        .eq('status', 'open')
        .lte('hold_until', nowIso);
      if (updErr) {
        log.error('lost-found disposal: expire update failed', {
          requestId,
          err: errToString(updErr),
        });
      }
    }

    // Nudge owners/GMs per property (one per day via dedupe_key).
    let nudgesInserted = 0;
    for (const [pid, counts] of perProperty) {
      if (counts.expired === 0 && counts.nearing === 0) continue;
      const recipients = await getNudgeRecipients(pid);
      if (recipients.length === 0) continue;

      const parts: string[] = [];
      if (counts.expired > 0) {
        parts.push(`${counts.expired} Lost & Found item${counts.expired === 1 ? '' : 's'} hit the 90-day hold and ${counts.expired === 1 ? 'is' : 'are'} ready to donate or discard`);
      }
      if (counts.nearing > 0) {
        parts.push(`${counts.nearing} item${counts.nearing === 1 ? '' : 's'} nearing the disposal deadline`);
      }
      const summary = parts.join('; ') + '.';

      for (const userId of recipients) {
        const { error: insErr } = await supabaseAdmin.from('agent_nudges').insert({
          user_id: userId,
          property_id: pid,
          category: 'operational',
          severity: counts.expired > 0 ? 'warning' : 'info',
          payload: {
            summary,
            type: 'lost_found_disposal',
            expired: counts.expired,
            nearing: counts.nearing,
          },
          dedupe_key: `laf_disposal:${pid}:${dayBucket}`,
        });
        if (!insErr) nudgesInserted += 1;
        // 23505 = already nudged today; expected, swallow.
      }
    }

    await writeCronHeartbeat('lost-found-disposal-check', {
      requestId,
      notes: { checkedProperties: perProperty.size, expired: expiredIds.length, nudgesInserted },
    });

    return ok(
      {
        checkedProperties: perProperty.size,
        expired: expiredIds.length,
        nudgesInserted,
      },
      { requestId },
    );
  } catch (e) {
    log.error('lost-found disposal: threw', { requestId, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
