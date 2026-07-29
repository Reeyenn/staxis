import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ApiErrorCode, err, ok } from '@/lib/api-response';
import {
  assertAuthorizationScopeReceipt,
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  resolveAuthorizationScope,
  type AuthoritativePropertyAccess,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';
import {
  propertyStandingsFromAuthorizationReceipt,
  resolveManagementCompanyScopeUncached,
} from '@/lib/company/authoritative-scope';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  HOTEL_ACTING_CONTEXT_VERSION,
  type HotelActingContextV1,
} from '@/lib/portfolio-ui/hotel-acting-contract';
import { standingHasLocalHotelContext } from '@/lib/portfolio-ui/local-hotel-authority';
import { parsePortfolioUiContext } from '@/lib/portfolio-ui/context';
import { selectAuthoritativePortfolioUiScope } from '@/lib/portfolio-ui/scope-selection';
import { APP_SECTIONS, isSectionEnabled } from '@/lib/sections/registry';
import { parseStoredEnabledSections } from '@/lib/sections/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadSessionAccount } from '@/lib/team-auth';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Authorization, Cookie',
};

interface PropertyRow {
  id: string;
  name: string | null;
  region: string | null;
  total_rooms: number | string | null;
  timezone: string | null;
  enabled_sections: unknown;
}

function unavailable(requestId: string, message = 'Hotel access is temporarily unavailable') {
  return err(message, {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
  });
}

function genericDenied(requestId: string) {
  return err('Hotel access was not found', {
    requestId,
    status: 404,
    code: ApiErrorCode.NotFound,
    headers: PRIVATE_HEADERS,
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((propertyId, index) => propertyId === right[index]);
}

function sameStanding(
  left: AuthoritativePropertyStanding | null,
  right: AuthoritativePropertyStanding | null,
): boolean {
  if (!left || !right) return left === right;
  return left.propertyId === right.propertyId
    && left.operationalRole === right.operationalRole
    && left.seesFinancials === right.seesFinancials
    && left.hotelMutationAllowed === right.hotelMutationAllowed
    && left.portfolioIntelligenceRead === right.portfolioIntelligenceRead
    && JSON.stringify(left.entitlements) === JSON.stringify(right.entitlements);
}

function sameAuthorityAtHotel(
  initial: AuthoritativePropertyAccess,
  current: AuthoritativePropertyAccess,
  propertyId: string,
): boolean {
  return initial.all === current.all
    && initial.authorityMode === current.authorityMode
    && initial.authorityVersion === current.authorityVersion
    && initial.effectiveAccessHash === current.effectiveAccessHash
    && sameIds(initial.propertyIds, current.propertyIds)
    && sameStanding(
      authoritativeStandingForProperty(initial, propertyId),
      authoritativeStandingForProperty(current, propertyId),
    );
}

async function readProperty(propertyId: string): Promise<PropertyRow | null> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, region, total_rooms, timezone, enabled_sections')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw new Error(`property read failed: ${error.message}`);
  return data as PropertyRow | null;
}

function totalRooms(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

function sectionAvailability(
  raw: unknown,
  seesFinancials: boolean,
): HotelActingContextV1['sectionAvailability'] {
  const flags = parseStoredEnabledSections(raw);
  return Object.fromEntries(APP_SECTIONS.map((section) => [
    section,
    isSectionEnabled(flags, section) && (section !== 'financials' || seesFinancials),
  ])) as HotelActingContextV1['sectionAvailability'];
}

function localRole(role: AppRole): Exclude<AppRole, 'admin'> {
  return role === 'admin' ? 'owner' : role;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const parsed = parsePortfolioUiContext(req.nextUrl.searchParams);
  if (!parsed.ok
      || parsed.value.context.scope !== 'hotel'
      || parsed.value.filters.length > 0
      || parsed.value.returnTo !== null) {
    return err('The hotel acting context is invalid', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: PRIVATE_HEADERS,
    });
  }

  const account = await loadSessionAccount(session.userId);
  if (!account || account.role === 'admin' || account.reachesAllProperties) {
    return genericDenied(requestId);
  }
  const context = parsed.value.context;
  const propertyId = context.propertyId;

  try {
    let response: HotelActingContextV1;

    if (!context.organizationId) {
      const initialAuthority = await listAuthoritativePropertyAccess(account.accountId);
      if (!initialAuthority) return unavailable(requestId);
      const standing = authoritativeStandingForProperty(initialAuthority, propertyId);
      if (!standing || !standingHasLocalHotelContext(standing)) return genericDenied(requestId);

      const property = await readProperty(propertyId);
      if (!property) return genericDenied(requestId);
      const sections = sectionAvailability(property.enabled_sections, standing.seesFinancials);

      const currentAuthority = await listAuthoritativePropertyAccess(account.accountId);
      if (!currentAuthority) return unavailable(requestId);
      if (!sameAuthorityAtHotel(initialAuthority, currentAuthority, propertyId)) {
        return err('Hotel access changed while the page was opening', {
          requestId,
          status: 409,
          code: 'scope_changed',
          headers: PRIVATE_HEADERS,
        });
      }

      response = {
        version: HOTEL_ACTING_CONTEXT_VERSION,
        verifiedAt: new Date().toISOString(),
        source: 'local',
        organization: null,
        parentScope: null,
        property: {
          id: property.id,
          name: property.name?.trim() || 'This hotel',
          region: property.region?.trim() || null,
          totalRooms: totalRooms(property.total_rooms),
          timezone: property.timezone?.trim() || null,
        },
        standing: {
          operationalRole: localRole(standing.operationalRole),
          localHotelAccess: true,
          hotelDetailRead: true,
          hotelMutationAllowed: standing.hotelMutationAllowed,
          seesFinancials: standing.seesFinancials && sections.financials,
          portfolioIntelligenceRead: standing.portfolioIntelligenceRead,
        },
        portfolioFeatures: { queueAvailable: false },
        sectionAvailability: sections,
      };
    } else {
      const resolved = await resolveManagementCompanyScopeUncached(
        account.accountId,
        context.organizationId,
      );
      if (!resolved.ok) {
        return resolved.reason === 'authorization_unavailable'
          ? unavailable(requestId)
          : genericDenied(requestId);
      }
      const selected = selectAuthoritativePortfolioUiScope({
        organizationId: resolved.access.organizationId,
        organizationName: resolved.access.organizationName,
        propertyIds: resolved.access.propertyIds,
        descriptors: resolved.access.scopeDescriptors,
      }, context);
      if (!selected.ok || selected.scope.requestedHotelId !== propertyId) {
        return genericDenied(requestId);
      }

      const narrowed = await resolveAuthorizationScope({
        accountId: account.accountId,
        organizationId: resolved.access.organizationId,
        selector: selected.scope.selector,
      });
      if (!narrowed.ok) {
        return narrowed.reason === 'store_unavailable'
          ? unavailable(requestId)
          : genericDenied(requestId);
      }
      if (!narrowed.receipt.propertyIds.includes(propertyId)) return genericDenied(requestId);
      const standing = propertyStandingsFromAuthorizationReceipt(narrowed.receipt)
        .find((item) => item.propertyId === propertyId);
      if (!standing || !standing.portfolioIntelligenceRead) return genericDenied(requestId);

      const property = await readProperty(propertyId);
      if (!property) return genericDenied(requestId);
      const sections = sectionAvailability(property.enabled_sections, standing.seesFinancials);

      const asserted = await assertAuthorizationScopeReceipt({
        receiptId: narrowed.receipt.id,
        accountId: account.accountId,
      });
      if (!asserted.ok) {
        return asserted.reason === 'scope_changed'
          || asserted.reason === 'revoked_or_changed'
          || asserted.reason === 'expired'
          ? err('Hotel access changed while the page was opening', {
              requestId,
              status: 409,
              code: 'scope_changed',
              headers: PRIVATE_HEADERS,
            })
          : unavailable(requestId);
      }
      if (asserted.receipt.organizationId !== narrowed.receipt.organizationId
          || asserted.receipt.authorizationHash !== narrowed.receipt.authorizationHash
          || asserted.receipt.scopeHash !== narrowed.receipt.scopeHash
          || !sameIds(asserted.receipt.propertyIds, narrowed.receipt.propertyIds)
          || !sameIds(
            asserted.receipt.authorizedPropertyIds,
            narrowed.receipt.authorizedPropertyIds,
          )) return unavailable(requestId);

      response = {
        version: HOTEL_ACTING_CONTEXT_VERSION,
        verifiedAt: new Date().toISOString(),
        source: 'portfolio',
        organization: {
          id: resolved.access.organizationId,
          name: resolved.access.organizationName,
        },
        parentScope: {
          kind: selected.scope.kind,
          id: selected.scope.id,
          name: selected.scope.name,
        },
        property: {
          id: property.id,
          name: property.name?.trim() || 'This hotel',
          region: property.region?.trim() || null,
          totalRooms: totalRooms(property.total_rooms),
          timezone: property.timezone?.trim() || null,
        },
        standing: {
          operationalRole: standing.operationalRole,
          localHotelAccess: false,
          hotelDetailRead: true,
          hotelMutationAllowed: standing.canManageHotel,
          seesFinancials: standing.seesFinancials && sections.financials,
          portfolioIntelligenceRead: true,
        },
        portfolioFeatures: { queueAvailable: resolved.access.queueAvailable },
        sectionAvailability: sections,
      };
    }

    return ok(response, { requestId, headers: PRIVATE_HEADERS });
  } catch (error) {
    log.error('[portfolio-ui] hotel acting context failed', {
      requestId,
      err: error instanceof Error ? error.message : String(error),
    });
    return unavailable(requestId);
  }
}
