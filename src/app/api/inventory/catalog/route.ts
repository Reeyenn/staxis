// GET /api/inventory/catalog?pid=<uuid> — the global starter catalog (for the
// "import starter catalog" onboarding action). Management-only. pid is used for
// the access gate only; the catalog itself is global (non-tenant).

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { listCatalogItems } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireOrderingAccess(req, pid);
  if (!gate.ok) return gate.response;

  const rl = await checkAndIncrementRateLimit('inventory-catalog-read', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const items = await listCatalogItems();
    return ok({ items }, { requestId: gate.requestId });
  } catch {
    return err('failed to list catalog', { requestId: gate.requestId, status: 500, code: 'list_failed' });
  }
}
