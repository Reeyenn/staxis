/**
 * PATCH /api/staff/wage
 *
 * Sole writer of `staff.hourly_wage_cents`. The Staff Directory edit
 * modal used to bundle wage changes into the generic updateStaffMember
 * payload; the cost-tracking feature (2026-05-26) lifts wage edits onto
 * a dedicated, owner-and-GM-only path so:
 *
 *   • The role gate is tighter than canManageTeam (which also admits
 *     non-management roles via the assignable-role list).
 *   • Every change is appended to `wage_changes` (audit table) regardless
 *     of which surface initiated it.
 *   • Browser callers can't accidentally include wage in a bulk save —
 *     forgetting to validate per-field would have leaked wages into the
 *     generic update path otherwise.
 *
 * Body:
 *   { propertyId, staffId, newWageCents | null, reason? }
 *
 * Responses:
 *   200 { ok: true, data: { wageChangeId, newWageCents } }
 *   400 validation_failed   (bad UUIDs, wage out of range, etc.)
 *   401 unauthorized        (no session or invalid)
 *   403 forbidden           (caller is not owner / GM / admin)
 *   404 not_found           (staff/property doesn't exist, or staff
 *                            belongs to a different property)
 *   409 idempotency_conflict not used — wage writes are non-idempotent
 *                            by intent (audit row per attempt)
 *   429 rate_limited        (per-property hourly cap)
 *
 * GET /api/staff/wage?staffId=&propertyId=
 *   Returns the current wage_cents + the last N audit rows for the
 *   inline "history" tooltip on the staff edit modal. Same role gate
 *   as PATCH — housekeepers must not read wages.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hard upper bound on wage in cents: matches the CHECK constraint on
// staff.hourly_wage_cents in migration 0229 ($10,000/hr). The UI input
// uses dollar.cents so this corresponds to $10,000.00/hr.
const MAX_WAGE_CENTS = 1_000_000;

interface CallerContext {
  authUserId: string;
  authEmail: string | null;
  accountId: string;
  role: AppRole;
  propertyAccess: string[];
}

async function loadCaller(authUserId: string, authEmail: string | null): Promise<CallerContext | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    authUserId,
    authEmail,
    accountId: data.id,
    role: data.role as AppRole,
    propertyAccess: Array.isArray(data.property_access) ? data.property_access : [],
  };
}

/**
 * Only owners, general managers, and Staxis admins can see or edit
 * wages. canManageTeam() admits the same set today, but we name the
 * predicate explicitly here so a future expansion of canManageTeam
 * (e.g., adding "front_desk_lead" to the team-management role list)
 * doesn't accidentally widen the wage gate too.
 */
function canEditWages(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

function callerHasPropertyAccess(caller: CallerContext, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  return caller.propertyAccess.includes(propertyId) || caller.propertyAccess.includes('*');
}

function normalizeWageInput(v: unknown): { error?: string; value?: number | null } {
  // Explicit null = "clear the wage." Anything else has to be an
  // integer in [0, MAX_WAGE_CENTS].
  if (v === null) return { value: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { error: 'newWageCents must be a number or null' };
  }
  if (!Number.isInteger(v)) {
    return { error: 'newWageCents must be a whole number of cents' };
  }
  if (v < 0 || v > MAX_WAGE_CENTS) {
    return { error: `newWageCents must be between 0 and ${MAX_WAGE_CENTS}` };
  }
  return { value: v };
}

// ───────────────────────────────────────────────────────────────────────
// GET — read current wage + recent audit history
// ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canEditWages(caller.role)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffIdV = validateUuid(url.searchParams.get('staffId'), 'staffId');
  if (staffIdV.error) return err(staffIdV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  if (!callerHasPropertyAccess(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Confirm the staff row belongs to this property — prevents an owner
  // from reading another property's wage by knowing a UUID.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, hourly_wage_cents, hourly_wage, property_id')
    .eq('id', staffIdV.value)
    .maybeSingle();
  if (staffErr || !staffRow) {
    return err('Staff record not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (staffRow.property_id !== pidV.value) {
    log.warn('[staff/wage:GET] cross-property attempt blocked', {
      requestId, callerId: caller.accountId, pid: pidV.value, staffId: staffIdV.value,
    });
    return err('Staff record not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { data: history } = await supabaseAdmin
    .from('wage_changes')
    .select('id, old_wage_cents, new_wage_cents, actor_email, actor_role, reason, changed_at')
    .eq('property_id', pidV.value)
    .eq('staff_id', staffIdV.value)
    .order('changed_at', { ascending: false })
    .limit(10);

  return ok({
    wageCents: staffRow.hourly_wage_cents,
    // Surface the legacy column too so the UI can fall back gracefully
    // for staff whose wage was only ever set via the old bulk update
    // path. Migration 0229's backfill should make this redundant in
    // most cases, but defensive read is cheap.
    legacyWageDollars: staffRow.hourly_wage,
    name: staffRow.name,
    history: history ?? [],
  }, { requestId });
}

// ───────────────────────────────────────────────────────────────────────
// PATCH — write a new wage (audit-logged)
// ───────────────────────────────────────────────────────────────────────

interface PatchBody {
  propertyId?: unknown;
  staffId?: unknown;
  newWageCents?: unknown;
  reason?: unknown;
}

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => null) as PatchBody | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canEditWages(caller.role)) {
    log.warn('[staff/wage:PATCH] role gate rejected request', {
      requestId, callerId: caller.accountId, role: caller.role,
    });
    return err('Only owners and general managers can edit wages', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffIdV = validateUuid(body.staffId, 'staffId');
  if (staffIdV.error) return err(staffIdV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerHasPropertyAccess(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const wageV = normalizeWageInput(body.newWageCents);
  if (wageV.error) return err(wageV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 500)
    : null;

  // Rate limit (per property) — owner editing wages shouldn't hammer
  // this endpoint.
  const rl = await checkAndIncrementRateLimit('staff-wage-write', pidV.value!);
  if (!rl.allowed) {
    return err('Too many wage updates — try again shortly', {
      requestId, status: 429, code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  // Load + scope-check the staff row.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, hourly_wage_cents, property_id')
    .eq('id', staffIdV.value)
    .maybeSingle();
  if (staffErr || !staffRow) {
    return err('Staff record not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (staffRow.property_id !== pidV.value) {
    log.warn('[staff/wage:PATCH] cross-property attempt blocked', {
      requestId, callerId: caller.accountId, pid: pidV.value, staffId: staffIdV.value,
    });
    return err('Staff record not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const oldWageCents = staffRow.hourly_wage_cents ?? null;
  const newWageCents = wageV.value!;

  // No-op short-circuit: same value as before. Don't write a wage_changes
  // row for these — the audit table is for ACTUAL changes.
  if (oldWageCents === newWageCents) {
    return ok({
      wageChangeId: null,
      newWageCents,
      noOp: true,
    }, { requestId });
  }

  // Audit row FIRST (adversarial review C3). The spec requires every
  // wage change to land an audit row; if the audit insert fails, we
  // must NOT update the wage. Otherwise the wage moves silently with
  // no trail. Order: audit insert → staff update → if update fails,
  // delete the audit row (best-effort) so the trail doesn't claim
  // a change that didn't happen.
  const { data: auditRow, error: auditErr } = await supabaseAdmin
    .from('wage_changes')
    .insert({
      property_id: pidV.value,
      staff_id: staffIdV.value,
      staff_name_at_change: staffRow.name,
      actor_account_id: caller.accountId,
      actor_email: caller.authEmail,
      actor_role: caller.role,
      old_wage_cents: oldWageCents,
      new_wage_cents: newWageCents,
      reason,
    })
    .select('id')
    .single();
  if (auditErr || !auditRow) {
    log.error('[staff/wage:PATCH] audit row insert failed — refusing wage change', {
      requestId, callerId: caller.accountId, pid: pidV.value, staffId: staffIdV.value,
      err: auditErr?.message,
    });
    return err('Failed to record wage change audit — wage NOT updated', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Now apply the actual wage change.
  const { error: updateErr } = await supabaseAdmin
    .from('staff')
    .update({ hourly_wage_cents: newWageCents })
    .eq('id', staffIdV.value);
  if (updateErr) {
    log.error('[staff/wage:PATCH] update failed — rolling back audit row', {
      requestId, callerId: caller.accountId, err: updateErr.message,
      auditRowId: auditRow.id,
    });
    // Best-effort rollback so the audit doesn't lie about a change
    // that never landed. wage_changes has cascade on property_id, not
    // on staff_id, so this delete is safe.
    await supabaseAdmin.from('wage_changes').delete().eq('id', auditRow.id);
    return err('Failed to update wage', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Generic admin_audit_log entry too, for the per-hotel timeline UI.
  await writeAudit({
    action: 'staff.wage_changed',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail ?? undefined,
    targetType: 'staff',
    targetId: staffIdV.value!,
    hotelId: pidV.value!,
    metadata: {
      oldWageCents,
      newWageCents,
      staffName: staffRow.name,
      requestId,
    },
  });

  return ok({
    wageChangeId: auditRow?.id ?? null,
    newWageCents,
  }, { requestId });
}
