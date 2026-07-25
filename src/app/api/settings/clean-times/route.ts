/**
 * GET  /api/settings/clean-times?propertyId=…
 *   Returns the property's standard cleaning times — one entry per editable
 *   cleaning_type, falling back to the industry defaults for any type without
 *   a row yet (so the page works on day one / before the migration is applied
 *   to this environment). Also returns the per-housekeeper shift length and
 *   `canEdit` (management roles only).
 *
 * PUT  /api/settings/clean-times
 *   Body: { propertyId, standards: [{ cleaningType, baseMinutes }], shiftMinutes? }
 *   Upserts the all-rooms (room_type NULL) standard for each provided type.
 *   These times drive the housekeeping workload estimates on the Auto-Assign
 *   Board / Timeline for newly-created tasks.
 *
 *   `shiftMinutes` (optional) writes properties.shift_minutes — how much
 *   cleaning fits in one housekeeper's day. This is the ONLY editor for that
 *   value in the app. It moved here on 2026-07-24 from a gear icon on the
 *   Housekeeping board, which wrote `properties` through the anon browser
 *   client: UPDATE on properties is admin-only RLS, and an UPDATE filtered to
 *   zero rows is not a Postgres error, so a general manager got a green
 *   "Settings saved" toast and no saved setting. The write below goes through
 *   supabaseAdmin and reports the rows it actually touched.
 *
 * Auth: requireSession + property access on every call.
 *
 *   - The cleaning-time STANDARDS are gated on the per-hotel
 *     `manage_clean_times` capability, which defaults to every role (an admin
 *     can switch a role off from the Access tab).
 *   - `shiftMinutes` additionally requires a MANAGEMENT role (admin / owner /
 *     general_manager). It has to: before it moved here it lived behind
 *     admin-only RLS on `properties`, so nobody below an admin could change
 *     it at all. Landing it on an everyone-by-default capability would have
 *     quietly handed a housekeeper the number that drives every capacity bar,
 *     Over-cap pill, "Recommended N HK" and forecast headcount in the app.
 *     GET reports this as `canEditShift` so the page can hide the field
 *     instead of failing the save.
 *
 * supabaseAdmin throughout: this table is service-role only (migration 0244),
 * so the browser never reads it directly.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, sessionGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { isValidRole, type AppRole } from '@/lib/roles';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  EDITABLE_CLEANING_TYPES,
  CLEAN_TIME_DEFAULT_MINUTES,
  MIN_CLEAN_MINUTES,
  MAX_CLEAN_MINUTES,
  MIN_SHIFT_MINUTES,
  MAX_SHIFT_MINUTES,
  DEFAULT_SHIFT_MINUTES,
  isEditableCleaningType,
  isValidBaseMinutes,
  isValidShiftMinutes,
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

/**
 * Who may change the hotel's shift length. Deliberately a ROLE check and not
 * a capability: `manage_clean_times` is granted to every role by default, and
 * this one number sets the whole hotel's labor math. See the header.
 */
function canEditShiftLength(account: CallerAccount): boolean {
  return account.role === 'admin'
    || account.role === 'owner'
    || account.role === 'general_manager';
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

/**
 * Current per-housekeeper shift length for a property.
 *
 * THROWS if the row can't be read, on purpose. Returning the default on a read
 * failure would be the same bug in a new costume: the page would render 7h,
 * the manager would hit Save without touching the field, and a hotel running
 * 9-hour shifts would be quietly reset to 7. A thrown error 500s the GET, the
 * page shows its load-failed state, and Save stays blocked. The default is
 * only for a genuinely unset (NULL) or out-of-range stored value.
 */
async function fetchShiftMinutes(propertyId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('shift_minutes')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`property ${propertyId} not found`);
  const raw = (data as { shift_minutes: number | null }).shift_minutes;
  return isValidShiftMinutes(raw) ? raw : DEFAULT_SHIFT_MINUTES;
}

export const GET = defineRoute({
  resolve: (req) => sessionGate(req),
  handler: async (ctx) => {
    const url = new URL(ctx.req.url);
    const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const account = await resolveCallerAccount(ctx.userId);
    if (!account) return ctx.err('Account not found', { status: 404, code: ApiErrorCode.NotFound });
    if (!callerHasPropertyAccess(account, pidV.value!)) {
      return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });
    }

    const rows = await fetchCleanTimeStandards(pidV.value!);
    const standards = shapeStandards(rows);
    const shiftMinutes = await fetchShiftMinutes(pidV.value!);
    const capabilityDecision = await capabilityDecisionForProperty(
      { role: account.role },
      'manage_clean_times',
      pidV.value!,
    );
    if (capabilityDecision === 'unavailable') {
      return capabilityUnavailableResponse(ctx.requestId);
    }

    return ctx.ok({
      standards,
      defaults: CLEAN_TIME_DEFAULT_MINUTES,
      canEdit: capabilityDecision === 'allowed',
      // Separate from canEdit on purpose — see the header. The page shows the
      // shift length to everyone who can see the times, but only a manager
      // gets an editable field.
      canEditShift: capabilityDecision === 'allowed' && canEditShiftLength(account),
      min: MIN_CLEAN_MINUTES,
      max: MAX_CLEAN_MINUTES,
      shiftMinutes,
    });
  },
});

export const PUT = defineRoute({
  resolve: (req) => sessionGate(req),
  handler: async (ctx) => {
    const body = (await ctx.req.json().catch(() => null)) as {
      propertyId?: unknown;
      standards?: unknown;
      shiftMinutes?: unknown;
    } | null;
    if (!body) return ctx.err('Invalid JSON body', { status: 400, code: ApiErrorCode.ValidationFailed });

    const pidV = validateUuid(body.propertyId, 'propertyId');
    if (pidV.error) return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const account = await resolveCallerAccount(ctx.userId);
    if (!account) return ctx.err('Account not found', { status: 404, code: ApiErrorCode.NotFound });
    if (!callerHasPropertyAccess(account, pidV.value!)) {
      return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });
    }
    // Writes honor the per-hotel manage_clean_times capability (default: every
    // role; an admin can switch a role OFF for this hotel from the Access tab).
    const capabilityDecision = await capabilityDecisionForProperty(
      { role: account.role },
      'manage_clean_times',
      pidV.value!,
    );
    if (capabilityDecision === 'unavailable') {
      return capabilityUnavailableResponse(ctx.requestId);
    }
    if (capabilityDecision === 'denied') {
      return ctx.err('Only managers can change cleaning times', {
        status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    if (!Array.isArray(body.standards) || body.standards.length === 0) {
      return ctx.err('standards must be a non-empty array', { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    // Optional — omitted means "leave the shift length alone".
    let nextShiftMinutes: number | null = null;
    if (body.shiftMinutes !== undefined) {
      if (!canEditShiftLength(account)) {
        return ctx.err('Only an owner or general manager can change the shift length', {
          status: 403, code: ApiErrorCode.Forbidden,
        });
      }
      if (!isValidShiftMinutes(body.shiftMinutes)) {
        return ctx.err(
          `shiftMinutes must be a whole number ${MIN_SHIFT_MINUTES}–${MAX_SHIFT_MINUTES}`,
          { status: 400, code: ApiErrorCode.ValidationFailed },
        );
      }
      nextShiftMinutes = body.shiftMinutes;
    }

    const updates: Array<{ cleaning_type: string; base_minutes: number }> = [];
    const seen = new Set<string>();
    for (const raw of body.standards) {
      if (!raw || typeof raw !== 'object') {
        return ctx.err('Each standard must be an object', { status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const { cleaningType, baseMinutes } = raw as { cleaningType?: unknown; baseMinutes?: unknown };
      if (!isEditableCleaningType(cleaningType)) {
        return ctx.err(`Unknown cleaning type: ${String(cleaningType)}`, { status: 400, code: ApiErrorCode.ValidationFailed });
      }
      if (seen.has(cleaningType)) {
        return ctx.err(`Duplicate cleaning type: ${cleaningType}`, { status: 400, code: ApiErrorCode.ValidationFailed });
      }
      if (!isValidBaseMinutes(baseMinutes)) {
        return ctx.err(`Minutes for ${cleaningType} must be a whole number ${MIN_CLEAN_MINUTES}–${MAX_CLEAN_MINUTES}`, {
          status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      seen.add(cleaningType);
      updates.push({ cleaning_type: cleaningType, base_minutes: baseMinutes });
    }

    const result = await upsertCleanTimeStandards(pidV.value!, updates, account.id);
    if (!result.ok) {
      log.error('[settings/clean-times:PUT] upsert failed', { requestId: ctx.requestId, err: result.error });
      return ctx.err('Failed to save cleaning times', { status: 500, code: ApiErrorCode.InternalError });
    }

    if (nextShiftMinutes !== null) {
      // `.select('id')` is load-bearing, not decoration: it makes the write
      // report the rows it touched. That is exactly what the old browser-side
      // save could not do — see the header note.
      const { data: touched, error: shiftErr } = await supabaseAdmin
        .from('properties')
        .update({ shift_minutes: nextShiftMinutes })
        .eq('id', pidV.value!)
        .select('id');
      if (shiftErr || !touched || touched.length === 0) {
        log.error('[settings/clean-times:PUT] shift_minutes update failed', {
          requestId: ctx.requestId, err: shiftErr, rows: touched?.length ?? 0,
        });
        return ctx.err('Failed to save the shift length', { status: 500, code: ApiErrorCode.InternalError });
      }
    }

    // Echo the canonical persisted state (re-read so the client reflects the
    // table exactly, including any concurrent edit).
    const standards = shapeStandards(await fetchCleanTimeStandards(pidV.value!));
    const shiftMinutes = await fetchShiftMinutes(pidV.value!);
    return ctx.ok({
      standards, shiftMinutes, canEdit: true,
      canEditShift: canEditShiftLength(account),
    });
  },
});
