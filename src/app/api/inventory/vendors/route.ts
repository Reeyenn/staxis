// /api/inventory/vendors — vendor records for a property. Management-only.
//   GET   ?pid=&includeInactive=1  → { vendors }
//   POST  { pid, name, email?, phone?, accountNumber?, notes? } → { vendor }
//   PATCH { pid, vendorId, ...fields, isActive? } → { vendor }
// Soft-delete = PATCH { isActive: false }.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { listVendors, createVendor, updateVendor, type VendorInput } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { isValidEmail, validateString, validateUuid } from '@/lib/api-validate';

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

// Validate the editable fields shared by POST + PATCH. Returns a partial input
// or an error string.
function parseFields(body: Record<string, unknown>, requireName: boolean): { input?: VendorInput; error?: string } {
  const input: Partial<VendorInput> = {};
  if (requireName || body.name !== undefined) {
    const nameV = validateString(body.name, { label: 'name', max: 120, min: 1 });
    if (nameV.error) return { error: nameV.error };
    input.name = nameV.value;
  }
  if (body.email !== undefined) {
    const e = body.email;
    if (e !== null && e !== '' && !isValidEmail(e)) return { error: 'invalid email' };
    input.email = e ? String(e).trim() : null;
  }
  if (body.phone !== undefined) input.phone = body.phone ? String(body.phone).slice(0, 40) : null;
  if (body.accountNumber !== undefined) input.accountNumber = body.accountNumber ? String(body.accountNumber).slice(0, 80) : null;
  if (body.notes !== undefined) input.notes = body.notes ? String(body.notes).slice(0, 1000) : null;
  if (body.isActive !== undefined) input.isActive = Boolean(body.isActive);
  return { input: input as VendorInput };
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

  const parsed = parseFields(body, true);
  if (parsed.error) return err(parsed.error, { requestId: gate.requestId, status: 400, code: 'validation_failed' });

  try {
    const vendor = await createVendor(gate.pid, parsed.input!);
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

  const parsed = parseFields(body, false);
  if (parsed.error) return err(parsed.error, { requestId: gate.requestId, status: 400, code: 'validation_failed' });

  try {
    const vendor = await updateVendor(gate.pid, idV.value!, parsed.input!);
    if (!vendor) return err('vendor not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ vendor }, { requestId: gate.requestId });
  } catch {
    return err('failed to update vendor', { requestId: gate.requestId, status: 500, code: 'update_failed' });
  }
}
