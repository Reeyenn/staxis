// ─── GET /api/maintenance/voice-issues ─────────────────────────────────────
//
// List the open + recent housekeeper voice-reported maintenance issues for a
// property. Reads from pms_work_orders_v2 filtered by
// source='housekeeper_voice' — the canonical maintenance table since
// migration 0225 unified voice issues into it (feature #11 follow-up).
//
// Auth: requireSession + property-access check. Manager-tier and maintenance
// roles can read every ticket for a property they have access to; housekeeping
// can only see their own (filtered by voice_metadata->>staff_id) because
// they file these tickets and shouldn't snoop on what other floors reported.
//
// Status enum: pms_work_orders_v2 uses 'open' | 'in_progress' | 'closed' |
// 'deferred' | 'resolved' (the legacy staxis_voice_issues 'cancelled' is
// migrated to 'closed' at backfill time by 0225). The default visibility
// is "open + in_progress" — the maintenance dashboard wants the active
// queue first.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ['open', 'in_progress', 'closed', 'deferred', 'resolved'] as const;

// Shape of a voice_metadata jsonb value as written by createMaintenanceWorkOrder.
// Fields are best-effort — historical rows backfilled from staxis_voice_issues
// have the same shape (migration 0225 jsonb_build_object).
interface VoiceMetadata {
  action?: string;
  item?: string;
  location_detail?: string | null;
  severity?: string;
  note?: string | null;
  original_language?: string | null;
  original_transcription?: string | null;
  voice_clip_path?: string | null;
  staff_id?: string | null;
  account_id?: string | null;
}

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
  // include resolved / closed / deferred.
  //
  // Codex 2026-05-25 adversarial gate (MAJOR fix): we explicitly handle
  // `cancelled` as a back-compat alias for `closed` (the legacy
  // staxis_voice_issues had a `cancelled` status that migration 0225
  // remaps to `closed` at backfill time). Any other unknown value
  // returns 400 instead of silently falling through to the open/
  // in_progress default — a caller passing a typo deserves to know.
  const statusParam = req.nextUrl.searchParams.get('status');
  let statuses: readonly string[] = ['open', 'in_progress'];
  if (statusParam) {
    if (statusParam === 'all') {
      statuses = STATUS_VALUES;
    } else if (statusParam === 'cancelled') {
      // Legacy alias: the old staxis_voice_issues table had `cancelled`;
      // migration 0225 mapped those rows to `closed` in pms_work_orders_v2.
      statuses = ['closed'];
    } else if ((STATUS_VALUES as readonly string[]).includes(statusParam)) {
      statuses = [statusParam];
    } else {
      return NextResponse.json(
        {
          ok: false,
          error: `unknown status "${statusParam}" — valid values: ${STATUS_VALUES.join(', ')}, all, or cancelled (legacy alias for closed)`,
          requestId,
        },
        { status: 400 },
      );
    }
  }

  let query = supabaseAdmin
    .from('pms_work_orders_v2')
    .select(
      'id, property_id, pms_work_order_id, room_number, description, priority, status, ' +
      'reported_by, reported_at, assigned_to, voice_session_id, voice_metadata, ' +
      'created_at, updated_at, resolved_at',
    )
    .eq('property_id', propertyId)
    .eq('source', 'housekeeper_voice')
    .in('status', statuses as string[])
    .order('created_at', { ascending: false })
    .limit(200);

  if (role === 'housekeeping') {
    // Floor-staff scope: only their own tickets. Look up their staff row,
    // then filter by the staff_id we wrote into voice_metadata at insert time.
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
    // jsonb path filter: PostgREST translates voice_metadata->>staff_id to
    // a SQL `voice_metadata->>'staff_id' = $1` predicate.
    query = query.eq('voice_metadata->>staff_id', staffId);
  }

  const { data, error } = await query;
  if (error) {
    log.error('[maintenance.voice-issues] query failed', { requestId, e: error });
    return NextResponse.json(
      { ok: false, error: 'lookup failed', requestId },
      { status: 500 },
    );
  }

  // Flatten voice_metadata into top-level fields for backwards-compat with
  // any consumer that wired up to the old staxis_voice_issues response
  // shape. The maintenance dashboard reads the new shape natively, but
  // older callers (the housekeeper page's VoiceIssueButton status poller,
  // for instance) see the action/item/severity fields they expect.
  //
  // The Supabase JS typed-select can't infer the dynamic column list with
  // a jsonb filter chained on it (it widens to GenericStringError); we
  // shape the row at runtime instead. RLS + the property_id + source
  // filters above are the authoritative gates — this cast is a typing-
  // only concession, not a security gap.
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const issues = rows.map((row) => {
    const meta = (row.voice_metadata ?? {}) as VoiceMetadata;
    return {
      id: row.id as string,
      property_id: row.property_id as string,
      pms_work_order_id: row.pms_work_order_id as string,
      room_number: (row.room_number as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      priority: (row.priority as string | null) ?? null,
      status: row.status as string,
      reported_by: (row.reported_by as string | null) ?? null,
      reported_at: (row.reported_at as string | null) ?? null,
      assigned_to: (row.assigned_to as string | null) ?? null,
      voice_session_id: (row.voice_session_id as string | null) ?? null,
      created_at: row.created_at as string,
      resolved_at: (row.resolved_at as string | null) ?? null,
      // Flattened from voice_metadata for compatibility.
      action: meta.action ?? null,
      item: meta.item ?? null,
      location_detail: meta.location_detail ?? null,
      severity: meta.severity ?? null,
      note: meta.note ?? null,
      original_language: meta.original_language ?? null,
      original_transcription: meta.original_transcription ?? null,
      voice_clip_path: meta.voice_clip_path ?? null,
      staff_id: meta.staff_id ?? null,
    };
  });

  return NextResponse.json({
    ok: true,
    data: { issues },
    requestId,
  });
}
