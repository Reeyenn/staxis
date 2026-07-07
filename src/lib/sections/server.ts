// ═══════════════════════════════════════════════════════════════════════════
// Section gating — server side. Reads a hotel's enabled_sections map (via
// supabaseAdmin, cached per request) and exposes the requireSectionEnabled gate.
//
// requireSectionEnabled is an ADD-ON layered on top of a route's EXISTING tenant
// guard (requireSession + userHasPropertyAccess, or requireFinanceAccess). It
// checks ONLY whether the section is on for the property, so it is NOT a
// substitute for the tenant check and is intentionally NOT registered in the
// tenant-scope audit — every gated route keeps its own recognized guard.
//
// Fail-soft everywhere: any error / missing row / unparseable value ⇒ the
// section is treated as ENABLED, so a read hiccup never hides a live section.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { cache } from 'react';
import type { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  isSectionEnabled,
  normalizeSectionFlags,
  type AppSection,
  type EnabledSections,
} from './registry';

/**
 * Load one hotel's enabled_sections map. Wrapped in React cache() so repeated
 * gate checks within one request share a single read. FAIL-SOFT: any error,
 * missing row, or unparseable value ⇒ null ⇒ every section ON. Never throws.
 */
export const getEnabledSections = cache(async (propertyId: string): Promise<EnabledSections> => {
  if (!propertyId) return null;
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('enabled_sections')
    .eq('id', propertyId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeSectionFlags((data as { enabled_sections?: unknown }).enabled_sections);
});

/** Is `section` on for `pid`? Fail-soft to true. */
export async function isSectionEnabledForProperty(pid: string, section: AppSection): Promise<boolean> {
  return isSectionEnabled(await getEnabledSections(pid), section);
}

export type SectionGate =
  | { ok: true; userId: string; requestId: string }
  | { ok: false; response: NextResponse };

/**
 * Section add-on gate. Confirms a valid session and that `section` is ON for
 * `pid`. PAIR IT with the route's existing tenant guard — this does NOT verify
 * property access on its own. Returns 403 `section_disabled` when the section is
 * off; fail-soft to ENABLED on any read error.
 */
export async function requireSectionEnabled(
  req: NextRequest,
  pid: string | null | undefined,
  section: AppSection,
): Promise<SectionGate> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };
  if (typeof pid !== 'string' || !pid) {
    return { ok: false, response: err('pid required', { requestId, status: 400, code: 'invalid_pid' }) };
  }
  if (!(await isSectionEnabledForProperty(pid, section))) {
    return {
      ok: false,
      response: err(`the ${section} section is turned off for this hotel`, {
        requestId,
        status: 403,
        code: 'section_disabled',
      }),
    };
  }
  return { ok: true, userId: session.userId, requestId };
}
