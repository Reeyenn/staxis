/**
 * /api/admin/mission/inbox
 *
 * GET — the "needs your okay" inbox of Mission Control: robots that are
 * stuck — waiting on a 2FA code, parked on their daily cost cap, or in a
 * failed / circuit-broken state. Only things the OWNER can act on belong
 * here; hotels' own pending AI decisions were removed 2026-07-19 (owner:
 * those wait on the hotel's managers, not him).
 *
 * Auth + service-role reads mirror /api/admin/cua-sessions exactly:
 * requireAdminOrCron gate, supabaseAdmin only, envelope via ok()/err().
 *
 * Each robot item carries an `action` the UI can render as a single button
 * or link.
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

type InboxKind = 'needs_2fa' | 'cost_cap' | 'failed';

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

  const { data: sessionRows, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id, status')
    .in('status', ATTENTION_STATES);

  if (sessErr) return err(sessErr.message, { requestId, status: 500, code: 'internal_error' });

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

  return ok(
    {
      items,
      counts: {
        needs2fa,
        costCap,
        failed,
        total: items.length,
      },
    },
    { requestId },
  );
}
