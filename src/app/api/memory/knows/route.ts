/**
 * Dashboard "What Staxis knows about your hotel" + impact — MANAGEMENT ONLY, service-role.
 *
 * GET ?propertyId=<uuid>
 *   → { ok, data: {
 *        stats: { totalKnown, patternsThisMonth, issuesCaughtEarly },
 *        taught:  [{id,topic,content}],   // facts a manager set explicitly
 *        noticed: [{id,topic,content}],   // patterns Staxis observed in operations
 *        learned: [{id,topic,content}],   // facts from conversations
 *      } }
 *   The full active PROPERTY knowledge, grouped by where it came from, plus honest
 *   impact counts (real numbers only — dollar ROI is surfaced by the client as a
 *   "starts when live data flows" state; we never fabricate $).
 *
 * Auth: requireSession + canManageTeam + caller must manage the property. All
 * reads via supabaseAdmin behind the gate (agent_memory is deny-all to browser).
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { listMemory, type MemoryRow } from '@/lib/db/agent-memory';
import { insightSeverityFromTopic } from '@/lib/agent/operational-signals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Caller {
  role: AppRole;
  propertyAccess: string[];
}

async function loadCaller(authUserId: string): Promise<Caller | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    role: (data as { role: string }).role as AppRole,
    propertyAccess: Array.isArray((data as { property_access?: unknown }).property_access)
      ? (data as { property_access: string[] }).property_access
      : [],
  };
}

function callerManagesProperty(caller: Caller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}

const slim = (r: MemoryRow) => ({ id: r.id, topic: r.topic, content: r.content });

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageTeam(caller.role)) return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // All active HOTEL-wide knowledge (property scope). User-scope personal prefs
  // are excluded — this panel is "what Staxis knows about the hotel".
  const rows = await listMemory(pidV.value!, { scope: 'property', limit: 200 });

  const taught = rows.filter((r) => r.source === 'explicit_user' || r.source === 'correction');
  const noticed = rows.filter((r) => r.source === 'operational');
  const learned = rows.filter((r) => r.source === 'consolidation');

  const monthAgo = Date.now() - 30 * 86400_000;
  const patternsThisMonth = noticed.filter((r) => new Date(r.updatedAt).getTime() >= monthAgo).length;
  // "Issues flagged early" — the downtime-preventing patterns (recurring
  // maintenance / repeat inspection fails / out-of-range compliance / complaint
  // clusters). The real ROI story, no $ fabricated.
  const issuesCaughtEarly = noticed.filter((r) => insightSeverityFromTopic(r.topic) === 'attention').length;

  return ok(
    {
      stats: { totalKnown: rows.length, patternsThisMonth, issuesCaughtEarly },
      taught: taught.map(slim),
      noticed: noticed.map(slim),
      learned: learned.map(slim),
    },
    { requestId },
  );
}
