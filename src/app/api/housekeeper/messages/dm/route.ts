/**
 * POST /api/housekeeper/messages/dm  — Body: { pid, staffId, otherStaffId }
 * Floor staff start (or reuse) a 1:1 chat with a teammate or manager.
 * Capability-gated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { getStaffRow, ensureDmConversation } from '@/lib/comms/core';
import { requirePropertySectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { pid?: string; staffId?: string; otherStaffId?: string }

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-send');
  if (!gate.ok) return gate.response;
  const sectionGate = await requirePropertySectionEnabled(gate.pid, 'communications', gate);
  if (!sectionGate.ok) return sectionGate.response;

  const otherV = validateUuid(gate.body.otherStaffId, 'otherStaffId');
  if (otherV.error) return err(otherV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  if (otherV.value === gate.staffId) return err('cannot message yourself', { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });

  const other = await getStaffRow(gate.pid, otherV.value!);
  if (!other) return err('Not found', { requestId: gate.requestId, status: 404, code: ApiErrorCode.NotFound, headers: gate.headers });

  const conversationId = await ensureDmConversation(gate.pid, gate.staffId, otherV.value!);
  return ok({ conversationId }, { requestId: gate.requestId, headers: gate.headers });
}
