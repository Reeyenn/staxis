/**
 * /api/settings/wages — manage the hourly wages that cost the schedule into
 * the Labor Cost % tile.
 *
 *   GET  ?pid=…  → { roleDefaults, overrides, staff, defaultWageCents }
 *   PUT          → replace this property's role defaults + per-person overrides
 *
 * Both gate on requireSession + userHasPropertyAccess + a management role
 * (admin / owner / general_manager via canViewLaborCost). Wages are sensitive
 * pay data: labor_wage_settings is service-role-only (migration 0245), so every
 * read/write goes through supabaseAdmin here. A non-manager gets 403 and never
 * sees a single wage.
 *
 * Money is integer CENTS (hourly_wage_cents), bounded (0, $2,000]/hr.
 *
 * Save model (bulk replace, mirrors /api/staff-schedule/presets): the PUT body
 * carries the FULL desired set; a role/person omitted (or sent null) is cleared.
 * staff.hourly_wage is never touched — it stays as the third fallback rung.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateInt } from '@/lib/api-validate';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  isLaborRole,
  LABOR_ROLE_DEPARTMENTS,
  DEFAULT_HOURLY_WAGE_CENTS,
  MAX_HOURLY_WAGE_CENTS,
  type LaborRole,
} from '@/lib/labor-cost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StaffRosterRow {
  id: string;
  name: string | null;
  department: string | null;
  hourly_wage: number | null;
  is_active: boolean | null;
}
interface WageSettingRow {
  scope: string;
  role: string | null;
  staff_id: string | null;
  hourly_wage_cents: number | null;
}

interface WageDataPayload {
  roleDefaults: Record<LaborRole, number | null>;
  overrides: Array<{ staffId: string; hourlyWageCents: number }>;
  staff: Array<{
    id: string;
    name: string;
    department: LaborRole | null;
    hourlyWageCents: number | null;
    isActive: boolean;
  }>;
  defaultWageCents: number;
}

/**
 * Authorize a wages request: valid session + property access + management role.
 * Returns the resolved propertyId, or a NextResponse to short-circuit.
 */
async function authorize(
  req: NextRequest,
  pidRaw: string | null,
  requestId: string,
  userId: string,
): Promise<{ ok: true; propertyId: string } | { ok: false; response: NextResponse }> {
  const pidCheck = validateUuid(pidRaw, 'pid');
  if (pidCheck.error) {
    return { ok: false, response: err(pidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed }) };
  }
  const propertyId = pidCheck.value!;
  if (!(await userHasPropertyAccess(userId, propertyId))) {
    return { ok: false, response: err('forbidden — no access to this property', { requestId, status: 403, code: ApiErrorCode.Forbidden }) };
  }
  const { data: accountRow, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('data_user_id', userId)
    .maybeSingle();
  if (accountErr) {
    log.error('wages: accounts lookup failed', { requestId, msg: accountErr.message });
    return { ok: false, response: err('account lookup failed', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure }) };
  }
  const capabilityDecision = await capabilityDecisionForProperty(
    { role: (accountRow?.role as string | undefined) ?? null },
    'view_wages',
    propertyId,
  );
  if (capabilityDecision === 'unavailable') {
    return { ok: false, response: capabilityUnavailableResponse(requestId) };
  }
  if (capabilityDecision === 'denied') {
    return { ok: false, response: err('forbidden — role does not have wage access', { requestId, status: 403, code: ApiErrorCode.Forbidden }) };
  }
  return { ok: true, propertyId };
}

/** Load the full wage-settings payload for the property (used by GET + after PUT). */
async function loadWageData(propertyId: string, requestId: string): Promise<WageDataPayload> {
  const [staffRes, wageRes] = await Promise.all([
    supabaseAdmin
      .from('staff')
      .select('id, name, department, hourly_wage, is_active')
      .eq('property_id', propertyId)
      .order('name', { ascending: true })
      .returns<StaffRosterRow[]>(),
    supabaseAdmin
      .from('labor_wage_settings')
      .select('scope, role, staff_id, hourly_wage_cents')
      .eq('property_id', propertyId)
      .returns<WageSettingRow[]>(),
  ]);

  if (staffRes.error) {
    log.warn('wages: staff roster read failed; returning empty roster', { requestId, msg: staffRes.error.message });
  }
  // labor_wage_settings may not exist before migration 0245 — degrade to "no
  // settings" so the page still renders (with empty defaults) on a DB that
  // hasn't had the migration applied yet.
  if (wageRes.error) {
    log.warn('wages: labor_wage_settings read failed; treating as no settings', { requestId, msg: wageRes.error.message });
  }

  const roleDefaults = Object.fromEntries(
    LABOR_ROLE_DEPARTMENTS.map((d) => [d, null]),
  ) as Record<LaborRole, number | null>;
  const overrides: Array<{ staffId: string; hourlyWageCents: number }> = [];
  for (const w of wageRes.data ?? []) {
    const cents = typeof w.hourly_wage_cents === 'number' ? w.hourly_wage_cents : null;
    if (cents == null || cents <= 0) continue;
    if (w.scope === 'role' && isLaborRole(w.role)) roleDefaults[w.role] = cents;
    else if (w.scope === 'person' && w.staff_id) overrides.push({ staffId: w.staff_id, hourlyWageCents: cents });
  }

  const staff = (staffRes.data ?? []).map((s) => {
    const dollars = s.hourly_wage;
    const hasWage = typeof dollars === 'number' && Number.isFinite(dollars) && dollars > 0;
    return {
      id: s.id,
      name: s.name ?? '',
      department: isLaborRole(s.department) ? (s.department as LaborRole) : null,
      hourlyWageCents: hasWage ? Math.round(dollars * 100) : null,
      isActive: s.is_active !== false, // undefined/null = active
    };
  });

  return { roleDefaults, overrides, staff, defaultWageCents: DEFAULT_HOURLY_WAGE_CENTS };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(req.url);
    const authz = await authorize(req, url.searchParams.get('pid'), requestId, auth.userId);
    if (!authz.ok) return authz.response;
    const data = await loadWageData(authz.propertyId, requestId);
    return ok(data, { requestId });
  } catch (e) {
    log.error('wages GET: unexpected error', { requestId, err: e instanceof Error ? e : new Error(String(e)) });
    return err('failed to load wages', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;
  try {
    const body = (await req.json().catch(() => null)) as
      | { pid?: unknown; roleDefaults?: unknown; overrides?: unknown }
      | null;
    if (!body || typeof body !== 'object') {
      return err('invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const authz = await authorize(req, typeof body.pid === 'string' ? body.pid : null, requestId, auth.userId);
    if (!authz.ok) return authz.response;
    const propertyId = authz.propertyId;

    // Build the full desired row set (jsonb for the atomic replace RPC). Each
    // row is { scope, role|null, staff_id|null, hourly_wage_cents }; the RPC
    // stamps property_id + updated_by.
    const rows: Array<{ scope: 'role' | 'person'; role: string | null; staff_id: string | null; hourly_wage_cents: number }> = [];

    // ── Validate role defaults ────────────────────────────────────────
    const roleDefaults = (body.roleDefaults ?? {}) as Record<string, unknown>;
    if (roleDefaults && typeof roleDefaults === 'object') {
      for (const dept of LABOR_ROLE_DEPARTMENTS) {
        const raw = roleDefaults[dept];
        if (raw == null) continue; // omitted / null → clear this role default
        const v = validateInt(raw, { min: 1, max: MAX_HOURLY_WAGE_CENTS, label: `roleDefaults.${dept}` });
        if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
        rows.push({ scope: 'role', role: dept, staff_id: null, hourly_wage_cents: v.value! });
      }
    }

    // ── Validate per-person overrides ─────────────────────────────────
    // Only accept overrides for staff that belong to THIS property (defends
    // against a cross-property staff_id being slipped into the body).
    const { data: staffIdRows, error: staffIdErr } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('property_id', propertyId)
      .returns<Array<{ id: string }>>();
    if (staffIdErr) {
      log.error('wages PUT: staff id read failed', { requestId, msg: staffIdErr.message });
      return err('failed to validate staff', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
    }
    const validStaffIds = new Set((staffIdRows ?? []).map((r) => r.id));

    const seenStaff = new Set<string>();
    const overrides = Array.isArray(body.overrides) ? body.overrides : [];
    for (const o of overrides) {
      if (!o || typeof o !== 'object') continue;
      const row = o as { staffId?: unknown; hourlyWageCents?: unknown };
      const idCheck = validateUuid(row.staffId, 'overrides.staffId');
      if (idCheck.error) return err(idCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const staffId = idCheck.value!;
      if (row.hourlyWageCents == null) continue; // null → clear that override
      if (!validStaffIds.has(staffId)) {
        return err('override references a staff member not on this property', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      if (seenStaff.has(staffId)) continue; // dedupe extras for the same person
      seenStaff.add(staffId);
      const v = validateInt(row.hourlyWageCents, { min: 1, max: MAX_HOURLY_WAGE_CENTS, label: 'overrides.hourlyWageCents' });
      if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      rows.push({ scope: 'person', role: null, staff_id: staffId, hourly_wage_cents: v.value! });
    }

    // ── Atomic replace (single transaction — see migration 0245) ──────
    const { error: rpcErr } = await supabaseAdmin.rpc('replace_labor_wage_settings', {
      p_property_id: propertyId,
      p_updated_by: auth.userId,
      p_rows: rows,
    });
    if (rpcErr) return upstream(rpcErr, requestId);

    const data = await loadWageData(propertyId, requestId);
    return ok(data, { requestId });
  } catch (e) {
    log.error('wages PUT: unexpected error', { requestId, err: e instanceof Error ? e : new Error(String(e)) });
    return err('failed to save wages', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

function upstream(error: { message: string }, requestId: string): NextResponse {
  log.error('wages PUT: write failed', { requestId, msg: error.message });
  return err('failed to save wages', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
}
