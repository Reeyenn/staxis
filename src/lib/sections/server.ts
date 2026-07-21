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
// A genuinely absent section key remains default-ON for backward compatibility.
// Database errors, missing property rows, and malformed stored values fail
// closed so a transient read failure cannot silently bypass a disabled section.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { cache } from 'react';
import type { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  isSectionEnabled,
  isAppSection,
  type AppSection,
  type EnabledSections,
} from './registry';

export class SectionLookupError extends Error {
  constructor(
    message: string,
    public readonly reason: 'database_error' | 'property_not_found' | 'malformed_value',
  ) {
    super(message);
    this.name = 'SectionLookupError';
  }
}

/** Strict server-side decoder. Missing keys are allowed; malformed values are not. */
export function parseStoredEnabledSections(raw: unknown): EnabledSections {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new SectionLookupError('enabled_sections is not valid JSON', 'malformed_value');
    }
  }
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SectionLookupError('enabled_sections must be an object', 'malformed_value');
  }
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!isAppSection(key) || typeof enabled !== 'boolean') {
      throw new SectionLookupError('enabled_sections contains an invalid entry', 'malformed_value');
    }
  }
  return value as EnabledSections;
}

/**
 * Load one hotel's enabled_sections map. Wrapped in React cache() so repeated
 * gate checks within one request share a single read. Only a real NULL column
 * (and keys absent from a valid map) retain the legacy default-ON behaviour.
 */
export const getEnabledSections = cache(async (propertyId: string): Promise<EnabledSections> => {
  if (!propertyId) throw new SectionLookupError('property id is required', 'property_not_found');
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('enabled_sections')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) {
    throw new SectionLookupError('failed to read enabled_sections', 'database_error');
  }
  if (!data) {
    throw new SectionLookupError('property was not found', 'property_not_found');
  }
  return parseStoredEnabledSections((data as { enabled_sections?: unknown }).enabled_sections);
});

/** Is `section` on for `pid`? Lookup failures are deliberately propagated. */
export async function isSectionEnabledForProperty(pid: string, section: AppSection): Promise<boolean> {
  return isSectionEnabled(await getEnabledSections(pid), section);
}

export type SectionGate =
  | { ok: true; userId: string; requestId: string; enabledSections: EnabledSections }
  | { ok: false; response: NextResponse };

export type PropertySectionGate =
  | { ok: true; requestId: string; enabledSections: EnabledSections }
  | { ok: false; response: NextResponse };

async function checkPropertySection(
  pid: string | null | undefined,
  section: AppSection,
  requestId: string,
  headers?: HeadersInit,
): Promise<PropertySectionGate> {
  if (typeof pid !== 'string' || !pid) {
    return { ok: false, response: err('pid required', { requestId, status: 400, code: 'invalid_pid', headers }) };
  }
  try {
    const enabledSections = await getEnabledSections(pid);
    if (!isSectionEnabled(enabledSections, section)) {
      return {
        ok: false,
        response: err(`the ${section} section is turned off for this hotel`, {
          requestId,
          status: 403,
          code: 'section_disabled',
          headers,
        }),
      };
    }
    return { ok: true, requestId, enabledSections };
  } catch (error) {
    log.error('[sections] enabled_sections lookup failed closed', {
      requestId,
      pid,
      section,
      reason: error instanceof SectionLookupError ? error.reason : 'unknown',
    });
    const retryHeaders = new Headers(headers);
    retryHeaders.set('Retry-After', '5');
    return {
      ok: false,
      response: err('section availability is temporarily unavailable', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: retryHeaders,
      }),
    };
  }
}

/**
 * Section-only gate for routes already authenticated by a non-session
 * capability (for example the housekeeper phone workflow).
 */
export async function requirePropertySectionEnabled(
  pid: string | null | undefined,
  section: AppSection,
  opts: { requestId: string; headers?: HeadersInit },
): Promise<PropertySectionGate> {
  return checkPropertySection(pid, section, opts.requestId, opts.headers);
}

/**
 * Section add-on gate. Confirms a valid session and that `section` is ON for
 * `pid`. PAIR IT with the route's existing tenant guard — this does NOT verify
 * property access on its own. Returns 403 `section_disabled` when the section is
 * off; lookup errors return a retryable 503 and never bypass the gate.
 */
export async function requireSectionEnabled(
  req: NextRequest,
  pid: string | null | undefined,
  section: AppSection,
): Promise<SectionGate> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };
  const checked = await checkPropertySection(pid, section, requestId);
  if (!checked.ok) return checked;
  return {
    ok: true,
    userId: session.userId,
    requestId: checked.requestId,
    enabledSections: checked.enabledSections,
  };
}
