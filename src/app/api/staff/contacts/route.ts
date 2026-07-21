/**
 * Staff phone directory — management only.
 *
 * `staff.phone` is intentionally absent from the browser Supabase roster
 * projection. Row-level security can scope rows, but cannot keep a sensitive
 * column away from line-staff browsers that legitimately need the rest of the
 * roster. Managers hydrate phone numbers through this service-role route.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validatePhone, validateUuid } from '@/lib/api-validate';
import { verifyTeamManager, callerCan } from '@/lib/team-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) {
    return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const propertyCheck = validateUuid(
    new URL(req.url).searchParams.get('propertyId'),
    'propertyId',
  );
  if (propertyCheck.error) {
    return err(propertyCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const propertyId = propertyCheck.value!;
  if (!(await callerCan(caller, 'manage_team', propertyId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data, error: queryError } = await supabaseAdmin
    .from('staff')
    .select('id, phone')
    .eq('property_id', propertyId);
  if (queryError) {
    log.error('[staff/contacts:GET] query failed', {
      requestId,
      msg: errToString(queryError),
    });
    return err('Failed to load staff contacts', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  const contacts: Record<string, string | null> = {};
  for (const row of (data ?? []) as Array<{ id: string; phone: string | null }>) {
    contacts[String(row.id)] = row.phone == null ? null : String(row.phone);
  }
  return ok({ contacts }, { requestId });
}

interface PutBody {
  propertyId?: unknown;
  staffId?: unknown;
  phone?: unknown;
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) {
    return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const body = (await req.json().catch(() => null)) as PutBody | null;
  if (!body) {
    return err('Invalid JSON body', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const propertyCheck = validateUuid(body.propertyId, 'propertyId');
  if (propertyCheck.error) {
    return err(propertyCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const propertyId = propertyCheck.value!;
  if (!(await callerCan(caller, 'manage_team', propertyId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const staffCheck = validateUuid(body.staffId, 'staffId');
  if (staffCheck.error) {
    return err(staffCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const phoneCheck = validatePhone(body.phone, 'phone');
  if (phoneCheck.error) {
    return err(phoneCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const phone = phoneCheck.value || null;
  // Keep inbound-SMS reverse lookup in lock-step with the displayed number.
  // This mirrors toStaffRow(): clear both together, otherwise retain the last
  // ten digits so formatted US numbers still match Twilio's E.164 sender.
  const phoneLookup = phone ? phone.replace(/\D/g, '').slice(-10) || null : null;

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('staff')
    .update({ phone, phone_lookup: phoneLookup })
    .eq('id', staffCheck.value!)
    .eq('property_id', propertyId)
    .select('id')
    .maybeSingle();
  if (updateError) {
    log.error('[staff/contacts:PUT] update failed', {
      requestId,
      msg: errToString(updateError),
    });
    return err('Failed to update staff contact', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  if (!updated) {
    return err('Staff member not found for this property', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }

  return ok(
    { staffId: staffCheck.value!, phone },
    { requestId },
  );
}
