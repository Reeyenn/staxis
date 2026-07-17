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

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getEnabledSections } from '@/lib/sections/server';
import { parseSectionFlags, resolveSections } from '@/lib/sections/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { propertyId?: unknown; sections?: unknown }

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
    const propertyId = new URL(ctx.req.url).searchParams.get('propertyId');
    const idCheck = validateUuid(propertyId, 'propertyId');
    if (idCheck.error || !idCheck.value) {
      return ctx.err(idCheck.error ?? 'propertyId is required', { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    // Coalesce the stored map (null ⇒ all-on) into a full 8-key boolean map so
    // the modal always renders 8 toggles, never {}.
    const sections = resolveSections(await getEnabledSections(idCheck.value));
    return ctx.ok({ sections });
  },
});

export const POST = defineRoute({
  body: 'empty',
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
    const body = ctx.body as Body;
    const idCheck = validateUuid(body.propertyId, 'propertyId');
    if (idCheck.error || !idCheck.value) {
      return ctx.err(idCheck.error ?? 'propertyId is required', { status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const propertyId = idCheck.value;

    const parsed = parseSectionFlags(body.sections);
    if (!parsed.ok) {
      return ctx.err(parsed.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const { error: updErr } = await supabaseAdmin
      .from('properties')
      .update({ enabled_sections: parsed.value })
      .eq('id', propertyId);
    if (updErr) {
      return ctx.err(`could not save sections: ${updErr.message}`, { status: 500, code: ApiErrorCode.UpstreamFailure });
    }

    return ctx.ok({ sections: parsed.value });
  },
});
