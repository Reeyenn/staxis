// GET    /api/maintenance/equipment/[id]?pid=…   — asset detail + repair/PM history
// PATCH  /api/maintenance/equipment/[id]          — edit an asset (manager)
// DELETE /api/maintenance/equipment/[id]?pid=…    — delete an asset (manager)
//
// Equipment registry (0249). Service-role-only table → supabaseAdmin behind a
// session + property-access gate; writes additionally require a management role.
// DELETE only unlinks an asset's work orders / PM tasks (FK ON DELETE SET NULL)
// — it never deletes the maintenance history itself.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { capabilityDecisionForUserId } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { getEquipmentDetail, updateEquipment, deleteEquipment } from '@/lib/equipment/store';
import { parseEquipmentPatch } from '@/lib/equipment/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(req.nextUrl.searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Section gate (add-on, on top of the tenant guard above): if Maintenance is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, pid, 'maintenance');
  if (!sectionGate.ok) return sectionGate.response;

  try {
    const detail = await getEquipmentDetail(pid, idV.value!);
    if (!detail) return err('Equipment not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return ok(detail, { requestId });
  } catch (e) {
    log.error('[maintenance/equipment/:id] detail failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Section gate (add-on, on top of the tenant guard above): if Maintenance is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, pid, 'maintenance');
  if (!sectionGate.ok) return sectionGate.response;

  const capabilityDecision = await capabilityDecisionForUserId(
    session.userId,
    'manage_equipment',
    pid,
  );
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (capabilityDecision === 'denied') {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit('equipment-config', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const parsed = parseEquipmentPatch(body);
  if (parsed.error) return err(parsed.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  try {
    const found = await updateEquipment(pid, idV.value!, parsed.value!);
    if (!found) return err('Equipment not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return ok({ id: idV.value }, { requestId });
  } catch (e) {
    log.error('[maintenance/equipment/:id] update failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(req.nextUrl.searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Section gate (add-on, on top of the tenant guard above): if Maintenance is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, pid, 'maintenance');
  if (!sectionGate.ok) return sectionGate.response;

  const capabilityDecision = await capabilityDecisionForUserId(
    session.userId,
    'manage_equipment',
    pid,
  );
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (capabilityDecision === 'denied') {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit('equipment-config', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const found = await deleteEquipment(pid, idV.value!);
    if (!found) return err('Equipment not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return ok({ id: idV.value }, { requestId });
  } catch (e) {
    log.error('[maintenance/equipment/:id] delete failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
