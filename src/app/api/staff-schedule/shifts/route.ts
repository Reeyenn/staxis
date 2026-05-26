// /api/staff-schedule/shifts — week-grid cell mutations (manager).
//
//   POST  body: { hotelId, shift: { id?, staffId?, department, shiftDate,
//                                    startTime, endTime, kind?, presetId?,
//                                    note?, reason? } }
//     Upsert a single cell. If `id` is set, update; otherwise insert. New
//     rows default to status='draft' (until Publish). Open shifts pass
//     kind='open' + staffId=null. The DB exclusion constraint enforces
//     "one assigned shift per (staff, date)" automatically.
//
//   DELETE  ?hotelId=…&id=…
//     Remove a single cell. Used to clear an assignment or retract an
//     open shift.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { validateUuid } from '@/lib/api-validate';
import { fromScheduledShiftRow } from '@/lib/db-mappers';
import type { StaffDepartment, ScheduledShiftKind } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DEPTS: StaffDepartment[] = [
  'housekeeping','front_desk','maintenance','breakfast','houseman','other',
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ShiftInput {
  id?: string;
  staffId?: string | null;
  department: StaffDepartment;
  shiftDate: string;
  startTime: string;
  endTime: string;
  kind?: ScheduledShiftKind;
  presetId?: string | null;
  note?: string | null;
  reason?: string | null;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as { hotelId?: string; shift?: ShiftInput };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const s = body.shift;
  if (!s) return err('shift required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!VALID_DEPTS.includes(s.department)) return err('Invalid department', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!DATE_RE.test(s.shiftDate)) return err('Invalid shiftDate (YYYY-MM-DD)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!TIME_RE.test(s.startTime) || !TIME_RE.test(s.endTime)) {
    return err('Invalid time format (HH:MM)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const kind: ScheduledShiftKind = s.kind ?? 'shift';

  // Validate staff_id belongs to this property when present.
  if (s.staffId) {
    const sidCheck = validateUuid(s.staffId, 'staffId');
    if (sidCheck.error) return err(sidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const { data: staffRow } = await supabaseAdmin
      .from('staff').select('id, property_id').eq('id', sidCheck.value!).maybeSingle();
    if (!staffRow || staffRow.property_id !== hotelId) {
      return err('Staff record not in this hotel', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
  }
  if (s.presetId) {
    const pidCheck = validateUuid(s.presetId, 'presetId');
    if (pidCheck.error) return err(pidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const row = {
    property_id: hotelId,
    staff_id:    kind === 'open' ? null : (s.staffId ?? null),
    department:  s.department,
    shift_date:  s.shiftDate,
    start_time:  s.startTime,
    end_time:    s.endTime,
    kind,
    preset_id:   s.presetId ?? null,
    note:        s.note ?? null,
    reason:      s.reason ?? null,
  };

  let savedId: string | null = null;
  if (s.id) {
    const idCheck = validateUuid(s.id, 'id');
    if (idCheck.error) return err(idCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const { data, error } = await supabaseAdmin
      .from('scheduled_shifts').update(row).eq('id', idCheck.value!)
      .eq('property_id', hotelId).select('*').single();
    if (error) {
      log.error('[shifts:POST] update failed', { requestId, msg: errToString(error) });
      return err(error.message || 'Failed to update shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    savedId = String(data.id);
    return ok({ shift: fromScheduledShiftRow(data) }, { requestId });
  } else {
    // INSERT with conflict handling on the exclusion constraint. If
    // there's already an assigned shift for this (staff, date) we update
    // instead, to keep the "click to overwrite" UX intuitive.
    const { data, error } = await supabaseAdmin
      .from('scheduled_shifts').insert(row).select('*').single();
    if (error) {
      // Exclusion-constraint conflict → 23P01; retry as an update of the
      // existing row to make the API call idempotent for the manager.
      if (error.code === '23P01' && row.kind === 'shift' && row.staff_id) {
        const { data: upd, error: upErr } = await supabaseAdmin
          .from('scheduled_shifts').update(row)
          .eq('property_id', hotelId).eq('staff_id', row.staff_id).eq('shift_date', row.shift_date)
          .eq('kind', 'shift').select('*').single();
        if (upErr) {
          log.error('[shifts:POST] conflict-retry update failed', { requestId, msg: errToString(upErr) });
          return err('Failed to upsert shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
        }
        savedId = String(upd.id);
        return ok({ shift: fromScheduledShiftRow(upd) }, { requestId });
      }
      log.error('[shifts:POST] insert failed', { requestId, msg: errToString(error) });
      return err(error.message || 'Failed to create shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    savedId = String(data.id);
    return ok({ shift: fromScheduledShiftRow(data) }, { requestId });
  }
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const idCheck = validateUuid(searchParams.get('id'), 'id');
  if (idCheck.error) return err(idCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const { error } = await supabaseAdmin
    .from('scheduled_shifts').delete()
    .eq('id', idCheck.value!).eq('property_id', hotelId);
  if (error) {
    log.error('[shifts:DELETE] failed', { requestId, msg: errToString(error) });
    return err('Failed to delete shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ ok: true }, { requestId });
}
