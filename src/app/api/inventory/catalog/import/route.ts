// POST /api/inventory/catalog/import { pid } — seed this property's inventory
// from the global starter catalog. Idempotent (skips items already present by
// name+category). Management-only. The 300+-hotel onboarding accelerator.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { importCatalog } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid json', { requestId: 'pre-auth', status: 400, code: 'validation_failed' });
  }

  const gate = await requireOrderingAccess(req, body.pid);
  if (!gate.ok) return gate.response;

  const rl = await checkAndIncrementRateLimit('inventory-catalog-import', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const result = await importCatalog(gate.pid);
    return ok(result, { requestId: gate.requestId });
  } catch {
    return err('failed to import catalog', { requestId: gate.requestId, status: 500, code: 'import_failed' });
  }
}
