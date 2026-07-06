// ─── GET /api/agent/activity ────────────────────────────────────────────────
//
// The read side of the AI-assistant approval gate: a manager-only feed of every
// action the AI proposed on a property (done / denied / expired / failed),
// newest first, for the "AI activity" review pop-up.
//
// AUTH — three gates, all server-side:
//   1. requireSession        — a valid signed-in user (+ 2FA per the global gate)
//   2. userHasPropertyAccess — the caller can see this property (?pid=)  → 403
//   3. canManageTeam(role)   — admin / owner / general_manager only      → 403
//
// The agent_pending_actions table is deny-all RLS, so the read goes through
// supabaseAdmin scoped to property_id (see fetchActivity). This is a READ-ONLY
// route — no mutation, no resolve. Envelope: ok()/err() per api-response.ts,
// matching the sibling GET at /api/agent/conversations/[id].

import type { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId, log } from '@/lib/log';
import { canManageTeam } from '@/lib/roles';
import { loadAgentUserCtx } from '../command/_stream-runner';
import { fetchActivity, ACTIVITY_PAGE_SIZE } from '@/lib/agent/activity';
// Side-effect import — registers all tools so buildActionSummary resolves.
import '@/lib/agent/tools/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseNonNegInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  // Property-access gate — the caller must be able to see this property.
  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('no access to this property', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Manager-role gate — the AI-activity review is management-only (same trio as
  // team management / financials). front_desk / housekeeping / maintenance /
  // staff must NOT reach it, even on a property they can otherwise see.
  const ctxLoad = await loadAgentUserCtx(auth.userId, pid);
  if (!ctxLoad.ok) {
    return err('account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (!canManageTeam(ctxLoad.userCtx.role)) {
    return err('manager access required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const limit = parseNonNegInt(url.searchParams.get('limit'), ACTIVITY_PAGE_SIZE);
  const offset = parseNonNegInt(url.searchParams.get('offset'), 0);

  try {
    const page = await fetchActivity({ propertyId: pid, limit, offset });
    return ok(page, { requestId });
  } catch (e) {
    log.error('[agent/activity] failed to load', { requestId, pid, e });
    return err('failed to load AI activity', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
