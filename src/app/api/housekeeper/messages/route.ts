/**
 * POST /api/housekeeper/messages  — Body: { pid, staffId }
 * The floor-staff (housekeeper phone) inbox: their direct conversations +
 * announcements (read-only) + the staff directory to start a new chat.
 * Capability-gated on (pid, staffId) — RLS-safe, supabaseAdmin only. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { listConversationsForStaff, listStaff, getStaffRow, normalizeLang } from '@/lib/comms/core';
import { requirePropertySectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

interface Body { pid?: string; staffId?: string }

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-read');
  if (!gate.ok) return gate.response;
  const sectionGate = await requirePropertySectionEnabled(gate.pid, 'communications', gate);
  if (!sectionGate.ok) return sectionGate.response;

  const staff = await getStaffRow(gate.pid, gate.staffId);
  const dept = staff?.department ?? null;
  const conversations = await listConversationsForStaff(gate.pid, gate.staffId, { isManager: false, dept, floorMode: true });
  const staffList = await listStaff(gate.pid);

  return ok(
    {
      me: { staffId: gate.staffId, name: gate.staffName, lang: normalizeLang(staff?.language) },
      conversations,
      staff: staffList.filter((s) => s.id !== gate.staffId),
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
