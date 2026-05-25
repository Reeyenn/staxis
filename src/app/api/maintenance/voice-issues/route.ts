// ─── GET /api/maintenance/voice-issues ─────────────────────────────────────
//
// List the open + recent housekeeper voice-reported maintenance issues for a
// property. Created as a stub so a future maintenance dashboard has a stable
// read path the moment one of these tickets lands — see the migration 0214
// comment for the rationale on keeping them out of pms_work_orders_v2.
//
// Auth: requireSession + property-access check. Manager-tier and maintenance
// roles can read every ticket for a property they have access to; housekeeping
// can only see their own (filtered by staff_id) because they file these
// tickets and shouldn't snoop on what other floors reported.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ['open', 'in_progress', 'resolved', 'cancelled'] as const;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const propertyId = req.nextUrl.searchParams.get('propertyId');
  if (!propertyId || !UUID_RX.test(propertyId)) {
    return NextResponse.json(
      { ok: false, error: 'propertyId must be a valid UUID', requestId },
      { status: 400 },
    );
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
  if (!hasAccess) {
    return NextResponse.json(
      { ok: false, error: 'no access to this property', requestId },
      { status: 403 },
    );
  }

  // Resolve role to decide visibility scope. Housekeeping sees only their
  // own tickets; manager/maintenance/owner/admin sees the whole property.
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, role')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (!account) {
    return NextResponse.json(
      { ok: false, error: 'account not found', requestId },
      { status: 404 },
    );
  }
  const role = ((account.role as string) ?? 'staff') as AppRole;

  // Optional status filter — defaults to "open" + "in_progress" which is
  // what a maintenance dashboard wants to show first. Pass ?status=all to
  // include resolved/cancelled.
  const statusParam = req.nextUrl.searchParams.get('status');
  let statuses: readonly string[] = ['open', 'in_progress'];
  if (statusParam === 'all') {
    statuses = STATUS_VALUES;
  } else if (statusParam && (STATUS_VALUES as readonly string[]).includes(statusParam)) {
    statuses = [statusParam];
  }

  let query = supabaseAdmin
    .from('staxis_voice_issues')
    .select(
      'id, property_id, staff_id, room_number, action, item, location_detail, severity, note, ' +
      'original_language, original_transcription, status, assigned_to, created_at, resolved_at',
    )
    .eq('property_id', propertyId)
    .in('status', statuses as string[])
    .order('created_at', { ascending: false })
    .limit(200);

  if (role === 'housekeeping') {
    // Floor-staff scope: only their own tickets. Look up their staff row.
    const { data: staffRow } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('auth_user_id', auth.userId)
      .eq('property_id', propertyId)
      .maybeSingle();
    const staffId = (staffRow?.id as string) ?? null;
    if (!staffId) {
      // No staff link → they shouldn't see any tickets (matches the "you
      // can only see your own" rule for floor staff).
      return NextResponse.json({ ok: true, data: { issues: [] }, requestId });
    }
    query = query.eq('staff_id', staffId);
  }

  const { data, error } = await query;
  if (error) {
    log.error('[maintenance.voice-issues] query failed', { requestId, e: error });
    return NextResponse.json(
      { ok: false, error: 'lookup failed', requestId },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: { issues: data ?? [] },
    requestId,
  });
}
