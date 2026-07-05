/**
 * POST /api/housekeeper/lunch-break
 *
 * Start or end a lunch break. Single open break per (staff, date) is
 * enforced by the staff_breaks_one_open_idx unique index — so a
 * double-tap of "Start lunch" returns a conflict instead of silently
 * inserting two open rows.
 *
 * Action is inferred from current state: if there's an open break for
 * this housekeeper today, this call ends it; otherwise it starts a new
 * one. The optional `breakType` defaults to 'lunch'.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  businessDate?: string; // YYYY-MM-DD
  breakType?: 'lunch' | 'short';
}

/**
 * GET /api/housekeeper/lunch-break?pid=...&staffId=...
 *
 * Returns the currently-open break (if any) for this housekeeper. Used by
 * the LunchBreakButton on page load so a refresh during an active break
 * shows "End lunch" instead of resetting to "Start lunch" and silently
 * ending the open break on the next tap.
 *
 * Searches across ANY business_date — a break that started before midnight
 * and crossed the boundary is still findable from the next day's session.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  const rl = await checkAndIncrementRateLimit(
    'housekeeper-lunch-break',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Security audit 2026-06-26 #1: verify the per-staff link token (?tok=).
  const gate = await verifyStaffLinkToken(req, { pid, staffId, requestId });
  if (!gate.ok) return gate.response;

  const { data: openRow, error: lookupErr } = await supabaseAdmin
    .from('staff_breaks')
    .select('id, business_date, break_type, started_at')
    .eq('property_id', pid)
    .eq('staff_id', staffId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    log.error('lunch-break GET: lookup failed', { requestId, err: errToString(lookupErr) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }

  return ok(
    {
      openBreak: openRow
        ? {
            id: openRow.id,
            businessDate: openRow.business_date,
            breakType: openRow.break_type,
            startedAt: openRow.started_at,
          }
        : null,
    },
    { requestId, headers },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-lunch-break');
  if (!gate.ok) return gate.response;
  const body = gate.body;

  const businessDate = body.businessDate;
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return err('invalid businessDate (YYYY-MM-DD)', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }
  const breakType = body.breakType === 'short' ? 'short' : 'lunch';

  // Find any open (ended_at IS NULL) break for this (pid, staffId)
  // REGARDLESS OF business_date — a break that starts at 11:55pm and
  // ends at 12:10am crosses midnight; if we filter on the new day's
  // date we'd miss the open row, insert a new one (partial unique index
  // forbids it for the new date but the original stays open forever),
  // and the audit table grows a perpetual open break.
  const { data: open, error: lookupErr } = await supabaseAdmin
    .from('staff_breaks')
    .select('id, started_at, break_type, business_date')
    .eq('property_id', gate.pid)
    .eq('staff_id', gate.staffId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    log.error('lunch-break: lookup failed', {
      requestId: gate.requestId,
      err: errToString(lookupErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  const now = new Date().toISOString();

  if (open) {
    // End the open break.
    const { error: updErr } = await supabaseAdmin
      .from('staff_breaks')
      .update({ ended_at: now })
      .eq('id', open.id as string);
    if (updErr) {
      log.error('lunch-break: end failed', {
        requestId: gate.requestId,
        err: errToString(updErr),
      });
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }
    return ok(
      {
        action: 'ended',
        breakId: open.id,
        startedAt: open.started_at,
        endedAt: now,
        breakType: open.break_type,
      },
      { requestId: gate.requestId, headers: gate.headers },
    );
  }

  // Start a new one. The partial unique index ensures we can't accidentally
  // open two — a double-tap returns 23505 from Postgres which we map to 409.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('staff_breaks')
    .insert({
      property_id: gate.pid,
      staff_id: gate.staffId,
      business_date: businessDate,
      break_type: breakType,
      started_at: now,
    })
    .select('id, started_at')
    .single();
  if (insErr) {
    // 23505 = unique_violation. The index enforces "one open break per day".
    const msg = errToString(insErr);
    if (msg.includes('23505') || msg.includes('duplicate key')) {
      return err('a break is already open', {
        requestId: gate.requestId,
        status: 409,
        code: ApiErrorCode.ValidationFailed,
        headers: gate.headers,
      });
    }
    log.error('lunch-break: insert failed', { requestId: gate.requestId, err: msg });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  return ok(
    {
      action: 'started',
      breakId: inserted?.id,
      startedAt: inserted?.started_at,
      breakType,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
