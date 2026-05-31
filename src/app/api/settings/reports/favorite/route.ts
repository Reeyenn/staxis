/**
 * POST /api/settings/reports/favorite
 * Body: { propertyId: UUID, reportKey: string }
 *
 * Toggles a report favorite for the calling user + property. Returns the new
 * state. Auth: manager/owner/admin + property access.
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { validateString, validateUuid } from '@/lib/api-validate';
import { reportKeys } from '@/lib/reports/catalog';
import { gateReportsAccess } from '@/lib/reports/catalog/gate';
import { toggleFavorite } from '@/lib/reports/catalog/store';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const body = (await req.json().catch(() => ({}))) as { propertyId?: unknown; reportKey?: unknown };

    const pidV = validateUuid(body.propertyId, 'propertyId');
    if (pidV.error) return err(pidV.error ?? 'invalid propertyId', { requestId, status: 400, code: 'validation_failed' });
    const propertyId = pidV.value!;

    const keyV = validateString(body.reportKey, { label: 'reportKey', max: 100 });
    if (keyV.error) return err(keyV.error ?? 'invalid reportKey', { requestId, status: 400, code: 'validation_failed' });
    if (!reportKeys().includes(keyV.value!)) {
      return err('Unknown report.', { requestId, status: 404, code: 'unknown_report' });
    }

    const gate = await gateReportsAccess(req, propertyId);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    const result = await toggleFavorite(gate.caller.accountId, propertyId, keyV.value!);
    return ok(result, { requestId });
  } catch (e) {
    log.error('reports favorite failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to update favorite.', { requestId, status: 500, code: 'internal_error' });
  }
}
