// GET  /api/maintenance/equipment?pid=…           — list a property's assets
// POST /api/maintenance/equipment                  — create an asset (manager)
//
// Equipment registry (0249). The equipment table is service-role-only (RLS bug
// class) so ALL access goes through here with supabaseAdmin. Reads require an
// authenticated session with access to the property; writes additionally
// require a management role (admin / owner / general_manager), matching how
// the Compliance config routes gate writes today.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { canForUserId } from '@/lib/capabilities/server';
import { listEquipment, createEquipment } from '@/lib/equipment/store';
import { parseEquipmentInput } from '@/lib/equipment/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const pidV = validateUuid(req.nextUrl.searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Section gate (add-on, on top of the tenant guard above): if Maintenance is
  // turned off for this hotel, block the equipment list.
  const sectionGate = await requireSectionEnabled(req, pid, 'maintenance');
  if (!sectionGate.ok) return sectionGate.response;

  try {
    const equipment = await listEquipment(pid);
    return ok({ equipment }, { requestId });
  } catch (e) {
    log.error('[maintenance/equipment] list failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (!(await canForUserId(session.userId, 'manage_equipment', pid))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Section gate (add-on, on top of the tenant guard above): if Maintenance is
  // turned off for this hotel, block creating equipment.
  const sectionGate = await requireSectionEnabled(req, pid, 'maintenance');
  if (!sectionGate.ok) return sectionGate.response;

  const rl = await checkAndIncrementRateLimit('equipment-config', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const parsed = parseEquipmentInput(body);
  if (parsed.error) return err(parsed.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  try {
    const created = await createEquipment(pid, parsed.value!);
    return ok({ id: created.id }, { requestId, status: 201 });
  } catch (e) {
    log.error('[maintenance/equipment] create failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
