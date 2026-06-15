/**
 * GET /api/admin/access/matrix?propertyId=<uuid>
 *
 * Admin-only. Returns everything the Access-tab grid needs for one hotel: the
 * capability list (grouped, bilingual), the hotel roles (columns), which
 * capabilities are live-enforced today, and the hotel's current restrictions.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireAdmin } from '@/lib/admin-auth';
import { loadOverridesForProperty } from '@/lib/capabilities/server';
import {
  CAPABILITY_LIST,
  CAPABILITY_GROUPS,
  GROUP_LABELS,
  HOTEL_ROLES,
  isLiveCapability,
} from '@/lib/capabilities/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const idCheck = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err('propertyId is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const overrides = await loadOverridesForProperty(idCheck.value);

  return ok(
    {
      hotelRoles: HOTEL_ROLES,
      groups: CAPABILITY_GROUPS.map((g) => ({ key: g, label_en: GROUP_LABELS[g].en, label_es: GROUP_LABELS[g].es })),
      capabilities: CAPABILITY_LIST.map((m) => ({
        key: m.key,
        adminOnly: m.adminOnly,
        live: isLiveCapability(m.key),
        group: m.group,
        label_en: m.label_en,
        label_es: m.label_es,
        desc_en: m.desc_en,
        desc_es: m.desc_es,
      })),
      overrides,
    },
    { requestId },
  );
}
