// ═══════════════════════════════════════════════════════════════════════════
// /api/companion/trace — the patterns on the screen somebody is standing on.
//
//   GET  ?pid=…&page=maintenance   → up to three patterns, worst first
//   POST { pid, key, action }      → do the one thing the card offered, and
//                                    hand back the receipt for what was written
//
// ─── WHY THIS IS NOT PART OF THE BOOTSTRAP ─────────────────────────────────
// /api/companion is read ONCE per person per hotel and is deliberately not a
// poll: nothing in it is live. A trace is the opposite — it is about the screen
// you are looking at right now, and it has to be re-asked when you walk to
// another one. Folding it into the bootstrap would mean either paying for
// detection on every page load whether or not anybody navigated, or a trace
// that never changed after the first screen of the session. So it is a sibling
// route on the same namespace, read on navigation.
//
// ─── WHY POST RE-COMPUTES INSTEAD OF TRUSTING THE BODY ─────────────────────
// The browser sends a pattern KEY and which button was pressed. It does not
// send the description, the room, or the severity. The server finds the pattern
// again from the same rows the card was built from and executes ITS OWN plan.
//
// That is the same discipline the chat DO wires run on ("what gets written is
// what was read back, not what the second call says"), and it buys two things:
// a stale tab cannot write a ticket about a run that has since been fixed, and
// the text on the board is always the text somebody was actually shown. The
// cost is one extra detection pass on a tap, which is a read of one hotel's own
// work orders.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { validateString } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isSectionEnabled, normalizeSectionFlags } from '@/lib/sections/registry';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { isValidRole, type AppRole } from '@/lib/roles';
import { createWorkOrderForComms } from '@/lib/comms/core';
import { buildTracePatterns } from '@/lib/companion/trace/server';
import { MAX_TRACES } from '@/lib/companion/trace';
import type { TracePage, TracePattern } from '@/lib/companion/trace/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGES: readonly TracePage[] = ['maintenance', 'inventory', 'staxis'];

function asPage(raw: string | null): TracePage | null {
  return PAGES.includes(raw as TracePage) ? (raw as TracePage) : null;
}

/**
 * Is the Staxis section on for this hotel?
 *
 * Same gate the companion bootstrap applies to its candidates, and for the same
 * reason: a hotel that has switched Staxis off gets nothing shipped to its
 * browser, whatever the browser then decides to do with it. Failing to read the
 * property reads as "off", which is the quiet direction.
 */
async function staxisIsOn(propertyId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('enabled_sections')
      .eq('id', propertyId)
      .maybeSingle();
    if (!data) return false;
    return isSectionEnabled(normalizeSectionFlags(data.enabled_sections), 'staxis');
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit(
    'companion-trace',
    hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const role: AppRole = isValidRole(ctx.role) ? ctx.role : 'staff';
  const page = asPage(searchParams.get('page'));

  // A hat with no companion has no trace either. One rule, checked twice, so
  // neither gate is load-bearing on its own.
  if (!chatIsMountedForRole(role) || !(await staxisIsOn(ctx.pid))) {
    return ok({ patterns: [] }, { requestId: ctx.requestId, headers: ctx.headers });
  }

  let patterns: TracePattern[];
  try {
    patterns = await buildTracePatterns({ propertyId: ctx.pid, page, role });
  } catch (e) {
    // Never throws upward. The trace is an offer, not a dependency.
    log.error('[trace] detection failed', {
      requestId: ctx.requestId, pid: ctx.pid, err: errToString(e),
    });
    patterns = [];
  }

  return ok(
    { patterns: patterns.slice(0, MAX_TRACES) },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}

// ─── Doing the one thing the card offered ───────────────────────────────────

interface ActBody {
  pid?: string;
  key?: unknown;
  page?: unknown;
  action?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: ActBody;
  try {
    body = (await req.json()) as ActBody;
  } catch {
    body = {};
  }

  const ctx = await commsContext(req, typeof body.pid === 'string' ? body.pid : null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const keyV = validateString(body.key, { max: 200, min: 1, label: 'key' });
  if (keyV.error) {
    return err(keyV.error, {
      requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
    });
  }
  const index = typeof body.action === 'number' && Number.isInteger(body.action) ? body.action : -1;
  if (index < 0 || index > 3) {
    return err('unknown action', {
      requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'companion-trace-act',
    hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const role: AppRole = isValidRole(ctx.role) ? ctx.role : 'staff';
  if (!chatIsMountedForRole(role) || !(await staxisIsOn(ctx.pid))) {
    return err('Staxis is switched off for this hotel', {
      requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers,
    });
  }

  try {
    const page = asPage(typeof body.page === 'string' ? body.page : null);
    const patterns = await buildTracePatterns({ propertyId: ctx.pid, page, role });
    const pattern = patterns.find((p) => p.key === keyV.value);
    const plan = pattern?.actions[index];
    if (!pattern || !plan) {
      // The honest answer to a tap on a card whose facts have moved. Nothing is
      // written, and the wording is the one the browser shows verbatim.
      return ok(
        { done: false, reason: 'This got handled already, so I left it alone.' },
        { requestId: ctx.requestId, headers: ctx.headers },
      );
    }

    // One tool, and it is the same function POST /api/comms/action already uses
    // to put a ticket on the board. There is no trace-only write path.
    const created = await createWorkOrderForComms(ctx.pid, {
      roomNumber: plan.args.location ?? null,
      description: plan.args.description ?? '',
      severity: plan.args.severity ?? 'medium',
      byName: ctx.displayName,
    });

    return ok(
      {
        done: true,
        // The receipt is built from what was WRITTEN, in the same shape the
        // findings action ledger uses (`ActionReceipt`), so the two receipts in
        // this product read the same way to a person and to a test.
        receipt: {
          table: 'work_orders',
          id: created.id,
          kind: 'created' as const,
          label: plan.args.description ?? '',
          where: plan.args.location ?? null,
        },
      },
      { requestId: ctx.requestId, status: 201, headers: ctx.headers },
    );
  } catch (e) {
    log.error('[trace] act failed', {
      requestId: ctx.requestId, pid: ctx.pid, err: errToString(e),
    });
    return err('Internal server error', {
      requestId: ctx.requestId, status: 500, code: ApiErrorCode.InternalError, headers: ctx.headers,
    });
  }
}
