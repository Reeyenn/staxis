// /api/inventory/vendors — vendor records for a property. Management-only.
//   GET   ?pid=&includeInactive=1  → { vendors }
//   POST  { pid, name, email?, phone?, accountNumber?, notes? } → { vendor }
//   PATCH { pid, vendorId, ...fields, isActive? } → { vendor }
// Soft-delete = PATCH { isActive: false }.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { listVendors, createVendor, updateVendor } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { validateUuid } from '@/lib/api-validate';
import { parseInventoryVendorFields } from '@/lib/inventory-vendor-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireOrderingAccess(req, pid);
  if (!gate.ok) return gate.response;

  const rl = await checkAndIncrementRateLimit('inventory-vendors', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1';
  try {
    const vendors = await listVendors(gate.pid, includeInactive);
    return ok({ vendors }, { requestId: gate.requestId });
  } catch {
    return err('failed to list vendors', { requestId: gate.requestId, status: 500, code: 'list_failed' });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('invalid json', { requestId: 'pre-auth', status: 400, code: 'validation_failed' });
  }
  const gate = await requireOrderingAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const rl = await checkAndIncrementRateLimit('inventory-vendors', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const parsed = parseInventoryVendorFields(body, true);
  if (parsed.error) return err(parsed.error, { requestId: gate.requestId, status: 400, code: 'validation_failed' });

  try {
    const vendor = await createVendor(gate.pid, parsed.input!, {
      userId: gate.userId,
      name: gate.name,
    });
    return ok({ vendor }, { requestId: gate.requestId, status: 201 });
  } catch {
    return err('failed to create vendor', { requestId: gate.requestId, status: 500, code: 'create_failed' });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('invalid json', { requestId: 'pre-auth', status: 400, code: 'validation_failed' });
  }
  const gate = await requireOrderingAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idV = validateUuid(body.vendorId, 'vendorId');
  if (idV.error) return err(idV.error, { requestId: gate.requestId, status: 400, code: 'validation_failed' });

  const rl = await checkAndIncrementRateLimit('inventory-vendors', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const parsed = parseInventoryVendorFields(body, false);
  if (parsed.error) return err(parsed.error, { requestId: gate.requestId, status: 400, code: 'validation_failed' });
  if (Object.keys(parsed.input ?? {}).length === 0) {
    return err('nothing to update', { requestId: gate.requestId, status: 400, code: 'validation_failed' });
  }

  try {
    const vendor = await updateVendor(gate.pid, idV.value!, parsed.input!, {
      userId: gate.userId,
      name: gate.name,
    });
    if (!vendor) return err('vendor not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ vendor }, { requestId: gate.requestId });
  } catch {
    return err('failed to update vendor', { requestId: gate.requestId, status: 500, code: 'update_failed' });
  }
}
