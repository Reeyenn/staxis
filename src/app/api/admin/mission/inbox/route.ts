/**
 * /api/admin/mission/inbox
 *
 * GET — the "needs your okay" inbox of Mission Control. Aggregates the two
 * things that actually need the owner:
 *   1. Robots that are stuck — waiting on a 2FA code, parked on their daily
 *      cost cap, or in a failed / circuit-broken state.
 *   2. How many AI decisions are still pending across all hotels
 *      (agent_nudges with status='pending').
 *
 * Auth + service-role reads mirror /api/admin/cua-sessions exactly:
 * requireAdminOrCron gate, supabaseAdmin only, envelope via ok()/err().
 *
 * Each robot item carries an `action` the UI can render as a single button
 * or link. Nudges are a count (+ one summary item), not per-row, so the
 * owner sees "3 decisions waiting" rather than a wall of rows.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Real property_sessions statuses that mean "a robot is stuck". Includes
 *  the two failure states (failed_restart, paused_circuit_breaker) alongside
 *  the plain 'failed' the spec names, so the owner sees every broken robot,
 *  not just one flavor of broken. */
const NEEDS_2FA = 'paused_mfa';
const HIT_COST_CAP = 'paused_cost_cap';
const FAILED_STATES = ['failed', 'failed_restart', 'paused_circuit_breaker'] as const;
const ATTENTION_STATES = [NEEDS_2FA, HIT_COST_CAP, ...FAILED_STATES];

type InboxKind = 'needs_2fa' | 'cost_cap' | 'failed' | 'pending_decisions';

/** A single action the UI renders as one control. 'link' navigates;
 *  'reset_cost_cap' / 'restart' POST to /api/admin/cua-sessions. */
type InboxAction =
  | { type: 'link'; href: string; label: string }
  | { type: 'reset_cost_cap'; propertyId: string; label: string }
  | { type: 'restart'; propertyId: string; label: string };

interface InboxItem {
  kind: InboxKind;
  propertyId: string | null;
  propertyName: string | null;
  title: string;
  detail: string;
  action: InboxAction | null;
}

interface SessionRow {
  property_id: string;
  status: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return err('Admin sign-in required.', { requestId, status: 401, code: 'unauthorized' });

  const [
    { data: sessionRows, error: sessErr },
    { count: nudgeCount, error: nudgeErr },
  ] = await Promise.all([
    supabaseAdmin
      .from('property_sessions')
      .select('property_id, status')
      .in('status', ATTENTION_STATES),
    supabaseAdmin
      .from('agent_nudges')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
  ]);

  if (sessErr) return err(sessErr.message, { requestId, status: 500, code: 'internal_error' });
  if (nudgeErr) return err(nudgeErr.message, { requestId, status: 500, code: 'internal_error' });

  const sessions = (sessionRows ?? []) as SessionRow[];

  // Hydrate hotel display names for the stuck robots.
  const propertyIds = sessions.map((s) => s.property_id);
  const nameById = new Map<string, string>();
  if (propertyIds.length > 0) {
    const { data: props } = await supabaseAdmin
      .from('properties')
      .select('id, display_name')
      .in('id', propertyIds);
    for (const p of (props ?? []) as Array<{ id: string; display_name: string | null }>) {
      nameById.set(p.id, p.display_name ?? p.id);
    }
  }

  const items: InboxItem[] = [];
  let needs2fa = 0;
  let costCap = 0;
  let failed = 0;

  for (const s of sessions) {
    const propertyName = nameById.get(s.property_id) ?? s.property_id;
    if (s.status === NEEDS_2FA) {
      needs2fa += 1;
      items.push({
        kind: 'needs_2fa',
        propertyId: s.property_id,
        propertyName,
        title: `${propertyName} needs a 2FA code`,
        detail: 'The robot is waiting for a two-factor code to finish signing in.',
        action: { type: 'link', href: `/admin/mfa-resume/${s.property_id}`, label: 'Enter 2FA code' },
      });
    } else if (s.status === HIT_COST_CAP) {
      costCap += 1;
      items.push({
        kind: 'cost_cap',
        propertyId: s.property_id,
        propertyName,
        title: `${propertyName} hit its $5 daily cap`,
        detail: "It paused to stay under its $5/day AI budget. It resumes on its own at midnight, or reset it now.",
        action: { type: 'reset_cost_cap', propertyId: s.property_id, label: 'Reset cap' },
      });
    } else {
      failed += 1;
      items.push({
        kind: 'failed',
        propertyId: s.property_id,
        propertyName,
        title: `${propertyName}'s robot stopped working`,
        detail: 'The robot ran into a problem and needs a restart to get going again.',
        action: { type: 'restart', propertyId: s.property_id, label: 'Restart' },
      });
    }
  }

  // Pending AI decisions across all hotels — surfaced as one summary line
  // (with a count) rather than one row per nudge.
  const pendingNudges = nudgeCount ?? 0;
  if (pendingNudges > 0) {
    items.push({
      kind: 'pending_decisions',
      propertyId: null,
      propertyName: null,
      title: pendingNudges === 1 ? '1 decision is waiting for you' : `${pendingNudges} decisions are waiting for you`,
      detail: 'The AI assistant has flagged these for a yes/no from a manager.',
      action: null,
    });
  }

  return ok(
    {
      items,
      counts: {
        needs2fa,
        costCap,
        failed,
        pendingNudges,
        total: items.length,
      },
    },
    { requestId },
  );
}
