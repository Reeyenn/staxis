/**
 * /api/admin/sections
 *
 * Per-hotel on/off for the 8 top-nav app sections (staxis / dashboard /
 * housekeeping / communications / maintenance / inventory / staff /
 * financials). This is the SAME properties.enabled_sections column the
 * onboarding wizard writes — the admin Live-hotels "Sections" popup is just a
 * second write surface for it.
 *
 *   GET  ?propertyId  → { sections }  — the hotel's map, coalesced to a FULL
 *                       all-8 boolean map (missing / null ⇒ every section ON)
 *                       so the modal always has 8 toggles to render.
 *   POST { propertyId, sections } → { sections } — validates the incoming map
 *                       into a canonical full 8-key boolean map (parseSectionFlags)
 *                       and persists it. Rejects unknown keys / non-booleans.
 *
 * The contract lives in @/lib/sections/registry: default-ON, only an explicit
 * `false` disables. We never write `flags[x] === true`.
 *
 * Auth: requireAdmin (a recognized tenant guard) + supabaseAdmin (service-role).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { getEnabledSections } from '@/lib/sections/server';
import { parseSectionFlags, resolveSections } from '@/lib/sections/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { propertyId?: unknown; sections?: unknown }

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const propertyId = new URL(req.url).searchParams.get('propertyId');
  const idCheck = validateUuid(propertyId, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err(idCheck.error ?? 'propertyId is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Coalesce the stored map (null ⇒ all-on) into a full 8-key boolean map so
  // the modal always renders 8 toggles, never {}.
  const sections = resolveSections(await getEnabledSections(idCheck.value));
  return ok({ sections }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const idCheck = validateUuid(body.propertyId, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err(idCheck.error ?? 'propertyId is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = idCheck.value;

  const parsed = parseSectionFlags(body.sections);
  if (!parsed.ok) {
    return err(parsed.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { error: updErr } = await supabaseAdmin
    .from('properties')
    .update({ enabled_sections: parsed.value })
    .eq('id', propertyId);
  if (updErr) {
    return err(`could not save sections: ${updErr.message}`, { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  return ok({ sections: parsed.value }, { requestId });
}
