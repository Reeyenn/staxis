/**
 * POST /api/onboarding/complete
 *
 * After /signup creates the auth user + property in 'trial' status, the
 * GM lands on /onboarding to fill in:
 *   - services_enabled overrides (toggle off housekeeping for extended-stay)
 *   - housekeepers (name + phone + language) — populates staff table
 *
 * Submitting this route saves the answers and redirects them to
 * /property-selector. The PMS connection is a separate step (handled by
 * /settings/pms) — keeping it out of this route lets the GM use the
 * dashboard immediately and connect the PMS later when they have creds.
 *
 * Body:
 *   {
 *     propertyId,                            // UUID of their property
 *     servicesEnabled: { housekeeping: bool, laundry: bool, … },
 *     staff: [{ name, phone, language: 'en' | 'es', role? }, …],
 *   }
 *
 * Returns: { ok: true }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const SERVICE_KEYS = [
  'housekeeping',
  'laundry',
  'maintenance',
  'deep_cleaning',
  'public_areas',
  'inventory',
  'equipment',
] as const;

type StaffEntry = {
  name?: unknown;
  phone?: unknown;
  language?: unknown;
  role?: unknown;
};

interface Body {
  propertyId?: unknown;
  servicesEnabled?: unknown;
  staff?: unknown;
}

const PHONE_RX = /^[+()\d\s.\-]{7,20}$/;
const LANG_VALUES = ['en', 'es'] as const;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Capability — caller owns this property.
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('id, owner_id')
    .eq('id', pidV.value!)
    .maybeSingle();
  if (!property) return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // ─── services_enabled ───────────────────────────────────────────────────
  // Build a clean object — silently drop unknown keys.
  const services: Record<string, boolean> = {};
  if (body.servicesEnabled && typeof body.servicesEnabled === 'object') {
    for (const k of SERVICE_KEYS) {
      const v = (body.servicesEnabled as Record<string, unknown>)[k];
      if (typeof v === 'boolean') services[k] = v;
    }
  }

  // ─── staff entries ──────────────────────────────────────────────────────
  const staffRaw = Array.isArray(body.staff) ? body.staff : [];
  if (staffRaw.length > 200) {
    return err('Too many staff entries (max 200)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const staffToInsert: Array<{
    property_id: string;
    name: string;
    phone_number: string | null;
    language: 'en' | 'es';
    role: string;
    is_active: boolean;
  }> = [];

  for (const [idx, raw] of staffRaw.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as StaffEntry;

    const nameV = validateString(s.name, { max: 100, label: `staff[${idx}].name` });
    if (nameV.error) {
      return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    let phone: string | null = null;
    if (typeof s.phone === 'string' && s.phone.trim()) {
      if (!PHONE_RX.test(s.phone.trim())) {
        return err(`staff[${idx}].phone: invalid format`, {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      phone = s.phone.trim();
    }

    const langV = validateEnum(s.language ?? 'en', LANG_VALUES, `staff[${idx}].language`);
    if (langV.error || !langV.value) {
      return err(langV.error ?? 'invalid language', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }

    const role = typeof s.role === 'string' && s.role.trim() ? s.role.trim() : 'housekeeper';

    staffToInsert.push({
      property_id: pidV.value!,
      name: nameV.value!.trim(),
      phone_number: phone,
      language: langV.value,
      role,
      is_active: true,
    });
  }

  // ─── Apply ──────────────────────────────────────────────────────────────
  // services_enabled: atomic merge via the staxis_merge_services Postgres
  // function (migration 0036). Avoids the read-modify-write race that
  // could otherwise lose a concurrent toggle.
  if (Object.keys(services).length > 0) {
    const { error: mergeErr } = await supabaseAdmin.rpc('staxis_merge_services', {
      p_property_id: pidV.value!,
      p_patch: services,
    });
    if (mergeErr) {
      // Fall back to read-modify-write if the RPC isn't available
      // (older deploys, migration not applied). Log loudly so we
      // notice and fix the migration drift.
      console.warn('[onboarding/complete] staxis_merge_services rpc failed — falling back', mergeErr.message);
      const { data: cur } = await supabaseAdmin
        .from('properties')
        .select('services_enabled')
        .eq('id', pidV.value!)
        .maybeSingle();
      const merged = { ...(cur?.services_enabled as Record<string, boolean> ?? {}), ...services };
      await supabaseAdmin
        .from('properties')
        .update({ services_enabled: merged })
        .eq('id', pidV.value!);
    }
  }

  // staff: insert in bulk. Skip duplicates by (property_id, name).
  if (staffToInsert.length > 0) {
    const { data: existing } = await supabaseAdmin
      .from('staff')
      .select('name')
      .eq('property_id', pidV.value!);
    const existingNames = new Set(
      (existing ?? []).map((r) => (r.name as string).toLowerCase()),
    );
    const fresh = staffToInsert.filter((s) => !existingNames.has(s.name.toLowerCase()));
    if (fresh.length > 0) {
      const { error: insertErr } = await supabaseAdmin.from('staff').insert(fresh);
      if (insertErr) {
        return err(`Could not save staff: ${insertErr.message}`, {
          requestId, status: 500, code: ApiErrorCode.InternalError,
        });
      }
    }
  }

  return ok({ propertyId: pidV.value!, staffSaved: staffToInsert.length }, { requestId });
}
