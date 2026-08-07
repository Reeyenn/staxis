/**
 * POST /api/housekeeper/messages/thread. Body: { pid, staffId, conversationId, before?, beforeId? }
 * Messages in one conversation, auto-translated into the housekeeper's saved
 * language. Opening marks it read. Capability-gated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateIsoTimestamp, validateUuid } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { getConversation, canAccessConversation, getMessages, markConversationRead, getStaffRow, normalizeLang } from '@/lib/comms/core';
import { requirePropertySectionEnabled } from '@/lib/sections/server';
import { findAuthoritativeManagerAccount } from '@/lib/authorization/server';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Matches /api/comms/messages: inside this route's 30s ceiling with room for
 *  the response to be written. Translation of a fresh thread fans out. */
const TRANSLATION_BUDGET_MS = 24_000;

interface Body { pid?: string; staffId?: string; conversationId?: string; before?: string; beforeId?: string }

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-read');
  if (!gate.ok) return gate.response;
  const sectionGate = await requirePropertySectionEnabled(gate.pid, 'communications', gate);
  if (!sectionGate.ok) return sectionGate.response;

  const convV = validateUuid(gate.body.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  const beforeV = gate.body.before === undefined ? { value: undefined } : validateIsoTimestamp(gate.body.before, 'before');
  if (beforeV.error) return err(beforeV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  const beforeIdV = gate.body.beforeId === undefined ? { value: undefined } : validateUuid(gate.body.beforeId, 'beforeId');
  if (beforeIdV.error) return err(beforeIdV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  if (gate.body.before === undefined && gate.body.beforeId !== undefined) {
    return err('before is required when beforeId is provided', { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  }

  const staff = await getStaffRow(gate.pid, gate.staffId);
  const dept = staff?.department ?? null;
  const lang = normalizeLang(staff?.language);

  const convo = await getConversation(gate.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: gate.requestId, status: 404, code: ApiErrorCode.NotFound, headers: gate.headers });
  const allowed = await canAccessConversation(gate.pid, gate.staffId, convo, { isManager: false, dept, floorMode: true });
  if (!allowed) return err('Forbidden', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });

  // ── The model calls this read can make, and who pays for them ────────────
  //
  // `getMessages` translates any message the reader has no cached translation
  // for, one provider call each. Its two signed-in siblings (/api/comms/messages
  // and /api/comms/thread) have always passed a ledger and a deadline. This one
  // never did, so every cache miss on the housekeeper floor screen was a real
  // charge with no row in the books, no deadline, and no cancellation when the
  // phone walked away from the wifi.
  //
  // A housekeeper has no `accounts` row, and `agent_costs.user_id` is NOT NULL,
  // so the spend is booked to the hotel's authoritative manager — the same
  // answer the nightly background callers give for the same question. A hotel
  // with no manager account books nothing rather than inventing an owner: the
  // translation still happens, the books are just thinner, and that is stated
  // rather than silent.
  const costAccountId = await findAuthoritativeManagerAccount(gate.pid);
  if (!costAccountId) {
    log.warn('[housekeeper/thread] translation spend not booked, this hotel has no manager account', {
      requestId: gate.requestId, propertyId: gate.pid,
    });
  }
  const page = await getMessages(gate.pid, convo.id, gate.staffId, lang, {
    withReceipts: false,
    before: beforeV.value,
    beforeId: beforeIdV.value,
    ai: {
      deadlineAt: Date.now() + TRANSLATION_BUDGET_MS,
      abortSignal: req.signal,
      ledger: costAccountId
        ? {
          userId: costAccountId,
          propertyId: gate.pid,
          requestId: gate.requestId,
          feature: 'communications.message_translation',
        }
        : undefined,
    },
  });
  await markConversationRead(gate.pid, convo.id, gate.staffId);

  return ok(
    {
      conversation: { id: convo.id, kind: convo.kind, title: convo.title },
      messages: page.messages,
      pagination: page.pagination,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
