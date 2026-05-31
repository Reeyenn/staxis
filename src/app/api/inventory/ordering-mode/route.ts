// GET  /api/inventory/ordering-mode?pid=<uuid>  → { mode: 'simple' | 'pro' }
// POST /api/inventory/ordering-mode { pid, mode } → set it. Management-only.
// 'simple' = reorder cart emails the vendor + Sent/Received tracking.
// 'pro'    = orders need approval before send; PO numbers shown prominently.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { getOrderingMode, setOrderingMode } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { validateEnum } from '@/lib/api-validate';
import type { OrderingMode } from '@/lib/ordering/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireOrderingAccess(req, pid);
  if (!gate.ok) return gate.response;

  const rl = await checkAndIncrementRateLimit('inventory-ordering-mode', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const mode = await getOrderingMode(gate.pid);
    return ok({ mode }, { requestId: gate.requestId });
  } catch {
    return err('failed to read ordering mode', { requestId: gate.requestId, status: 500, code: 'read_failed' });
  }
}

interface Body {
  pid?: string;
  mode?: string;
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
  const { requestId } = gate;

  const modeV = validateEnum<OrderingMode>(body.mode, ['simple', 'pro'], 'mode');
  if (modeV.error) return err(modeV.error, { requestId, status: 400, code: 'validation_failed' });

  const rl = await checkAndIncrementRateLimit('inventory-ordering-mode', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    await setOrderingMode(gate.pid, modeV.value!);
    return ok({ mode: modeV.value }, { requestId });
  } catch {
    return err('failed to set ordering mode', { requestId, status: 500, code: 'write_failed' });
  }
}
