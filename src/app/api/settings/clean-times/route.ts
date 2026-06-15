/**
 * GET  /api/settings/clean-times?propertyId=…
 *   Returns the property's standard cleaning times — one entry per editable
 *   cleaning_type, falling back to the industry defaults for any type without
 *   a row yet (so the page works on day one / before the migration is applied
 *   to this environment). Also returns `canEdit` (management roles only).
 *
 * PUT  /api/settings/clean-times
 *   Body: { propertyId, standards: [{ cleaningType, baseMinutes }] }
 *   Upserts the all-rooms (room_type NULL) standard for each provided type.
 *   These times drive the housekeeping workload estimates on the Auto-Assign
 *   Board / Timeline for newly-created tasks.
 *
 * Auth: requireSession. Reads require property access; WRITES additionally
 * require a management role (admin / owner / general_manager) — matches the
 * gate in /api/settings/users. supabaseAdmin throughout: this table is
 * service-role only (migration 0244), so the browser never reads it directly.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { isValidRole, type AppRole } from '@/lib/roles';
import { canForProperty } from '@/lib/capabilities/server';
import {
  EDITABLE_CLEANING_TYPES,
  CLEAN_TIME_DEFAULT_MINUTES,
  MIN_CLEAN_MINUTES,
  MAX_CLEAN_MINUTES,
  isEditableCleaningType,
  isValidBaseMinutes,
  type CleanTimeStandardRow,
} from '@/lib/clean-time-standards';
import {
  fetchCleanTimeStandards,
  upsertCleanTimeStandards,
} from '@/lib/clean-time-standards-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CallerAccount {
  id: string;
  property_access: string[];
  role: AppRole;
}

async function resolveCallerAccount(authUserId: string): Promise<CallerAccount | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, property_access, role')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    property_access: Array.isArray(data.property_access) ? data.property_access : [],
    role: (isValidRole(data.role) ? data.role : 'staff') as AppRole,
  };
}

function callerHasPropertyAccess(account: CallerAccount, propertyId: string): boolean {
  if (account.role === 'admin') return true;
  if (account.property_access.includes('*')) return true;
  return account.property_access.includes(propertyId);
}

/**
 * Build the API response shape: one entry per editable cleaning_type, using
 * the property's all-rooms (room_type NULL) row when present, else the
 * industry default. `isDefault` is true when the property has no saved row
 * for that type yet (the table is not pre-seeded — see migration 0244).
 */
function shapeStandards(rows: CleanTimeStandardRow[]) {
  const byType = new Map<string, number>();
  for (const r of rows) {
    if (r.room_type == null && isEditableCleaningType(r.cleaning_type)) {
      byType.set(r.cleaning_type, r.base_minutes);
    }
  }
  return EDITABLE_CLEANING_TYPES.map((cleaningType) => {
    const stored = byType.get(cleaningType);
    return {
      cleaningType,
      baseMinutes: stored ?? CLEAN_TIME_DEFAULT_MINUTES[cleaningType],
      isDefault: stored == null,
    };
  });
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const account = await resolveCallerAccount(session.userId);
  if (!account) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!callerHasPropertyAccess(account, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rows = await fetchCleanTimeStandards(pidV.value!);
  const standards = shapeStandards(rows);

  return ok(
    {
      standards,
      defaults: CLEAN_TIME_DEFAULT_MINUTES,
      canEdit: await canForProperty({ role: account.role }, 'manage_clean_times', pidV.value!),
      min: MIN_CLEAN_MINUTES,
      max: MAX_CLEAN_MINUTES,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as {
    propertyId?: unknown;
    standards?: unknown;
  } | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const account = await resolveCallerAccount(session.userId);
  if (!account) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!callerHasPropertyAccess(account, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  // Writes honor the per-hotel manage_clean_times capability (default: every
  // role; an admin can switch a role OFF for this hotel from the Access tab).
  if (!(await canForProperty({ role: account.role }, 'manage_clean_times', pidV.value!))) {
    return err('Only managers can change cleaning times', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  if (!Array.isArray(body.standards) || body.standards.length === 0) {
    return err('standards must be a non-empty array', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const updates: Array<{ cleaning_type: string; base_minutes: number }> = [];
  const seen = new Set<string>();
  for (const raw of body.standards) {
    if (!raw || typeof raw !== 'object') {
      return err('Each standard must be an object', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const { cleaningType, baseMinutes } = raw as { cleaningType?: unknown; baseMinutes?: unknown };
    if (!isEditableCleaningType(cleaningType)) {
      return err(`Unknown cleaning type: ${String(cleaningType)}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (seen.has(cleaningType)) {
      return err(`Duplicate cleaning type: ${cleaningType}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (!isValidBaseMinutes(baseMinutes)) {
      return err(`Minutes for ${cleaningType} must be a whole number ${MIN_CLEAN_MINUTES}–${MAX_CLEAN_MINUTES}`, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    seen.add(cleaningType);
    updates.push({ cleaning_type: cleaningType, base_minutes: baseMinutes });
  }

  const result = await upsertCleanTimeStandards(pidV.value!, updates, account.id);
  if (!result.ok) {
    log.error('[settings/clean-times:PUT] upsert failed', { requestId, err: result.error });
    return err('Failed to save cleaning times', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Echo the canonical persisted state (re-read so the client reflects the
  // table exactly, including any concurrent edit).
  const standards = shapeStandards(await fetchCleanTimeStandards(pidV.value!));
  return ok({ standards, canEdit: true }, { requestId });
}
