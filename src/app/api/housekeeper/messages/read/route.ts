/**
 * POST /api/housekeeper/messages/read  — Body: { pid, staffId, conversationId }
 * Mark a conversation read (clears the floor inbox badge). Capability-gated.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { getConversation, canAccessConversation, markConversationRead, getStaffRow } from '@/lib/comms/core';
import { requirePropertySectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { pid?: string; staffId?: string; conversationId?: string }

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-read');
  if (!gate.ok) return gate.response;
  const sectionGate = await requirePropertySectionEnabled(gate.pid, 'communications', gate);
  if (!sectionGate.ok) return sectionGate.response;

  const convV = validateUuid(gate.body.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });

  const convo = await getConversation(gate.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: gate.requestId, status: 404, code: ApiErrorCode.NotFound, headers: gate.headers });
  const staff = await getStaffRow(gate.pid, gate.staffId);
  const allowed = await canAccessConversation(gate.pid, gate.staffId, convo, { isManager: false, dept: staff?.department ?? null });
  if (!allowed) return err('Forbidden', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });

  await markConversationRead(gate.pid, convo.id, gate.staffId);
  return ok({ marked: true }, { requestId: gate.requestId, headers: gate.headers });
}
