// /api/staff-schedule/templates — whole-day / whole-week staffing templates
// for the unified Schedule tab's Fill modal (manager).
//
//   GET     ?hotelId=…                 → every template for the property
//   POST    { hotelId, scope, name, payload }  → create
//   DELETE  ?hotelId=…&id=…            → remove
//
// scope='day'  payload: [{ staffId, department, startMin, endMin }]
// scope='week' payload: array of exactly 7 day-arrays (Sun..Sat)
//
// Templates capture the whole period — every person and their shift — and
// applying one replaces the target period (see /api/staff-schedule/fill).
// Table is service-role only (no RLS policies); this route is the only door.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateUuid } from '@/lib/api-validate';
import type { StaffDepartment } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DEPTS: StaffDepartment[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
const MAX_SHIFTS_PER_DAY = 60;
const MAX_TEMPLATES = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TemplateShift {
  staffId: string;
  department: StaffDepartment;
  startMin: number;
  endMin: number;
}

function validShiftList(list: unknown): list is TemplateShift[] {
  if (!Array.isArray(list) || list.length > MAX_SHIFTS_PER_DAY) return false;
  return list.every(s =>
    s && typeof s === 'object'
    && UUID_RE.test(String((s as TemplateShift).staffId))
    && VALID_DEPTS.includes((s as TemplateShift).department)
    && Number.isInteger((s as TemplateShift).startMin)
    && Number.isInteger((s as TemplateShift).endMin)
    && (s as TemplateShift).startMin >= 0
    && (s as TemplateShift).endMin <= 24 * 60
    && (s as TemplateShift).endMin > (s as TemplateShift).startMin,
  );
}

async function authedHotelId(req: NextRequest, hotelIdRaw: unknown, requestId: string) {
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return { failure: err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized }) };
  const check = validateUuid(hotelIdRaw as string | null | undefined, 'hotelId');
  if (check.error) return { failure: err(check.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed }) };
  if (!(await callerCan(caller, 'manage_shifts', check.value!))) {
    return { failure: err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized }) };
  }
  return { hotelId: check.value!, caller };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);
  const auth = await authedHotelId(req, searchParams.get('hotelId'), requestId);
  if ('failure' in auth) return auth.failure;

  const { data, error } = await supabaseAdmin
    .from('schedule_templates')
    .select('id, scope, name, payload, created_at')
    .eq('property_id', auth.hotelId)
    .order('created_at', { ascending: true });
  if (error) {
    log.error('[templates:GET] failed', { requestId, msg: errToString(error) });
    return err('Failed to load templates', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({
    templates: (data ?? []).map(r => ({
      id: String(r.id),
      scope: r.scope as 'day' | 'week',
      name: String(r.name),
      payload: r.payload,
      createdAt: r.created_at,
    })),
  }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; scope?: string; name?: string; payload?: unknown;
  };
  const auth = await authedHotelId(req, body.hotelId, requestId);
  if ('failure' in auth) return auth.failure;

  // Section gate: if Staff is turned off for this hotel, block the write.
  const sectionGate = await requireSectionEnabled(req, auth.hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const scope = body.scope;
  if (scope !== 'day' && scope !== 'week') {
    return err('scope must be day | week', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) {
    return err('name required (1–80 chars)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const payload = body.payload;
  const payloadOk = scope === 'day'
    ? validShiftList(payload)
    : Array.isArray(payload) && payload.length === 7 && payload.every(validShiftList);
  if (!payloadOk) {
    return err('payload shape invalid for scope', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { count } = await supabaseAdmin
    .from('schedule_templates').select('id', { count: 'exact', head: true })
    .eq('property_id', auth.hotelId);
  if ((count ?? 0) >= MAX_TEMPLATES) {
    return err('Template limit reached — delete one first', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { data, error } = await supabaseAdmin
    .from('schedule_templates')
    .insert({
      property_id: auth.hotelId,
      scope, name, payload,
      created_by: auth.caller.accountId,
    })
    .select('id, scope, name, payload, created_at')
    .single();
  if (error) {
    log.error('[templates:POST] failed', { requestId, msg: errToString(error) });
    return err('Failed to save template', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({
    template: {
      id: String(data.id),
      scope: data.scope as 'day' | 'week',
      name: String(data.name),
      payload: data.payload,
      createdAt: data.created_at,
    },
  }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);
  const auth = await authedHotelId(req, searchParams.get('hotelId'), requestId);
  if ('failure' in auth) return auth.failure;

  // Section gate: if Staff is turned off for this hotel, block the write.
  const sectionGate = await requireSectionEnabled(req, auth.hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const idCheck = validateUuid(searchParams.get('id'), 'id');
  if (idCheck.error) return err(idCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const { error } = await supabaseAdmin
    .from('schedule_templates').delete()
    .eq('id', idCheck.value!).eq('property_id', auth.hotelId);
  if (error) {
    log.error('[templates:DELETE] failed', { requestId, msg: errToString(error) });
    return err('Failed to delete template', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ ok: true }, { requestId });
}
