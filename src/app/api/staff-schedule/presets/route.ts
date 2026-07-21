// /api/staff-schedule/presets — property shift presets (manager-defined
// named shift templates, e.g. "Morning HK: 8a–4p").
//
//   GET  ?hotelId=…
//     List all presets for the property. Visible to anyone with property
//     access (the staff-side My Shifts view needs these to label open
//     shifts, and the manager picker needs them too).
//
//   PUT  body: { hotelId, presets: [{ id?, name, department, startTime,
//                                     endTime, sortOrder }, …] }
//     Replace the property's preset set in one shot. Any preset not in
//     the array is deleted (cascade: scheduled_shifts.preset_id falls
//     to NULL). Manager-only.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSession } from '@/lib/api-auth';
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateUuid } from '@/lib/api-validate';
import { fromShiftPresetRow } from '@/lib/db-mappers';
import type { StaffDepartment } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DEPTS: StaffDepartment[] = ['housekeeping','front_desk','maintenance','other'];
const MAX_PRESETS = 50;
const MAX_PRESET_NAME = 80;

// 'HH:MM' or 'HH:MM:SS'. Postgres `time` accepts both.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  // RLS would block cross-property reads, but we also use supabaseAdmin
  // here (skipping RLS) so we sanity-check via the account's property_access.
  const { data: acct } = await supabaseAdmin
    .from('accounts').select('property_access, role')
    .eq('data_user_id', session.userId).maybeSingle();
  const access = (acct?.property_access ?? []) as string[];
  const isAdmin = acct?.role === 'admin';
  if (!isAdmin && !access.includes(hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data, error } = await supabaseAdmin
    .from('property_shift_presets').select('*')
    .eq('property_id', hotelId)
    .order('department', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) {
    log.error('[presets:GET] query failed', { requestId, msg: errToString(error) });
    return err('Failed to load presets', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ presets: (data ?? []).map(fromShiftPresetRow) }, { requestId });
}

interface PresetInput {
  id?: string;
  name: string;
  department: StaffDepartment;
  startTime: string;
  endTime: string;
  sortOrder?: number;
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as { hotelId?: string; presets?: PresetInput[] };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  if (!(await callerCan(caller, 'manage_shifts', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const presets = Array.isArray(body.presets) ? body.presets : [];
  if (presets.length > MAX_PRESETS) {
    return err(`presets must contain at most ${MAX_PRESETS} entries`, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  // Validate every preset before any DB write.
  for (const p of presets) {
    if (!p.name?.trim() || p.name.trim().length > MAX_PRESET_NAME) {
      return err(`Preset name required (1–${MAX_PRESET_NAME} chars)`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (p.id && validateUuid(p.id, 'preset id').error) {
      return err('Invalid preset id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (!VALID_DEPTS.includes(p.department)) return err('Invalid department', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    if (!TIME_RE.test(p.startTime) || !TIME_RE.test(p.endTime)) {
      return err('Invalid time format (HH:MM)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (p.startTime.slice(0, 5) === p.endTime.slice(0, 5)) {
      return err('Preset start and end times must differ', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
  }

  // Strategy: load current → diff by id → upsert kept + insert new + delete missing.
  // Simpler approach (one less round-trip) is "delete all, insert all", but that
  // would null out scheduled_shifts.preset_id for kept presets too. So do the
  // diff manually.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('property_shift_presets').select('id').eq('property_id', hotelId);
  if (existingErr) {
    log.error('[presets:PUT] existing query failed', { requestId, msg: errToString(existingErr) });
    return err('Failed to read presets', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  const existingIds = new Set((existing ?? []).map(r => String(r.id)));
  const keepIds = new Set<string>();
  const toUpdate: { id: string; row: Record<string, unknown> }[] = [];
  const toInsert: Record<string, unknown>[] = [];

  presets.forEach((p, i) => {
    const row = {
      property_id: hotelId,
      name:        p.name.trim(),
      department:  p.department,
      start_time:  p.startTime,
      end_time:    p.endTime,
      sort_order:  typeof p.sortOrder === 'number' ? p.sortOrder : i,
    };
    if (p.id && existingIds.has(p.id)) {
      keepIds.add(p.id);
      toUpdate.push({ id: p.id, row });
    } else {
      toInsert.push(row);
    }
  });
  const toDelete = [...existingIds].filter(id => !keepIds.has(id));

  for (const u of toUpdate) {
    const { error } = await supabaseAdmin
      .from('property_shift_presets').update(u.row).eq('id', u.id).eq('property_id', hotelId);
    if (error) {
      log.error('[presets:PUT] update failed', { requestId, msg: errToString(error) });
      return err('Failed to update preset', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }
  if (toInsert.length) {
    const { error } = await supabaseAdmin
      .from('property_shift_presets').insert(toInsert);
    if (error) {
      log.error('[presets:PUT] insert failed', { requestId, msg: errToString(error) });
      return err('Failed to create presets', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }
  // Delete last so a failed update/insert cannot wipe working presets.
  if (toDelete.length) {
    const { error } = await supabaseAdmin
      .from('property_shift_presets').delete()
      .eq('property_id', hotelId)
      .in('id', toDelete);
    if (error) {
      log.error('[presets:PUT] delete failed', { requestId, msg: errToString(error) });
      return err('Failed to remove presets', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }

  return ok({ ok: true, deleted: toDelete.length, updated: toUpdate.length, inserted: toInsert.length }, { requestId });
}
