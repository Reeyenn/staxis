'use client';

// Client-side capability gate. Reads the signed-in user (useAuth) and the
// ACTIVE SCOPE (PropertyContext) and returns a `can(capability)` checker backed
// by the same pure can() the server uses — so a gated button and the server
// route it calls always agree.
//
// TWO SCOPES, ONE GATE.
//   hotel scope    the hotel's own override map decides, exactly as before.
//   company scope  the company hat decides, and hotel mutation is off.
//
// Before company mode this hook took a required propertyId and returned
// all-false without one, so every one of its consumers went dark the moment the
// app was pointed at a company. It now answers the company question instead of
// refusing it, and refuses only a genuinely unresolved scope.

import { useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  resolveViewerCompanyStanding,
  resolveViewerHotelStanding,
} from '@/lib/authorization/domain';
import { legacyRoleForHat } from '@/lib/company/roles';
import { can, type CapabilityOverrideMap } from './can';
import type { CapabilityKey } from './registry';
import type { AppRole } from '@/lib/roles';

/** No per-hotel restriction exists at company scope: overrides belong to a hotel. */
const NO_OVERRIDES: CapabilityOverrideMap = {};

export interface ActiveScopeStanding {
  scopeKind: 'unresolved' | 'hotel' | 'company';
  role: AppRole | null;
  hotelMutationAllowed: boolean;
  seesFinancials: boolean;
  ready: boolean;
}

const CLOSED: ActiveScopeStanding = {
  scopeKind: 'unresolved',
  role: null,
  hotelMutationAllowed: false,
  seesFinancials: false,
  ready: false,
};

export function useActiveHotelStanding(): {
  role: AppRole | null;
  hotelMutationAllowed: boolean;
  seesFinancials: boolean;
  ready: boolean;
} {
  const { activePropertyId } = useProperty();
  const {
    user,
    authorizationChecked,
    platformAdmin,
    propertyStandings,
  } = useAuth();
  if (!user || !authorizationChecked || !activePropertyId) {
    return {
      role: null,
      hotelMutationAllowed: false,
      seesFinancials: false,
      ready: false,
    };
  }
  // One shared rule for "what is this viewer's standing at this hotel", so a
  // platform admin is never offered less here than the server will honour.
  const standing = resolveViewerHotelStanding({
    platformAdmin: platformAdmin && user.role === 'admin',
    standings: propertyStandings,
    propertyId: activePropertyId,
  });
  return {
    role: standing?.operationalRole ?? null,
    hotelMutationAllowed: standing?.hotelMutationAllowed === true,
    seesFinancials: standing?.seesFinancials === true,
    ready: Boolean(standing),
  };
}

/**
 * The viewer's standing at whatever the app is currently pointed at.
 *
 * At company scope this is the company hat's standing across every hotel in the
 * scope (see resolveViewerCompanyStanding): a GM who holds one building gains
 * nothing by landing on a company URL, and `hotelMutationAllowed` is false for
 * everybody because company scope has no hotel to write to.
 */
export function useActiveScopeStanding(): ActiveScopeStanding {
  const { activeScope, activeCompany, activePropertyId } = useProperty();
  const {
    user,
    authorizationChecked,
    platformAdmin,
    propertyStandings,
  } = useAuth();
  if (!user || !authorizationChecked) return CLOSED;

  if (activeScope.kind === 'company') {
    const standing = resolveViewerCompanyStanding({
      platformAdmin: platformAdmin && user.role === 'admin',
      standings: propertyStandings,
      organizationId: activeScope.scope.organizationId,
      propertyIds: activeScope.scope.propertyIds,
      companyRole: activeCompany ? legacyRoleForHat(activeCompany.companyRole) : null,
    });
    return {
      scopeKind: 'company',
      role: standing?.operationalRole ?? null,
      hotelMutationAllowed: false,
      seesFinancials: standing?.seesFinancials === true,
      ready: Boolean(standing),
    };
  }

  if (activeScope.kind === 'hotel' && activePropertyId) {
    const standing = resolveViewerHotelStanding({
      platformAdmin: platformAdmin && user.role === 'admin',
      standings: propertyStandings,
      propertyId: activePropertyId,
    });
    return {
      scopeKind: 'hotel',
      role: standing?.operationalRole ?? null,
      hotelMutationAllowed: standing?.hotelMutationAllowed === true,
      seesFinancials: standing?.seesFinancials === true,
      ready: Boolean(standing),
    };
  }

  return CLOSED;
}

/**
 * Returns `(capability) => boolean` for the current user at the current scope.
 *
 * Fails closed until the answer is confirmed for the exact signed-in viewer and
 * the exact scope. At hotel scope that means the override map has landed for
 * that viewer and that hotel; at company scope there is no per-hotel override to
 * wait for, so readiness is the company standing itself. The server re-checks
 * every request, but client controls must not flicker enabled or stay enabled
 * after a capability read times out merely because the default map is permissive.
 */
export function useCan(): (capability: CapabilityKey) => boolean {
  const {
    activeScope,
    activePropertyId,
    activePropertyViewerKey,
    capabilityOverrides,
    capabilityOverridesPropertyId,
    capabilityOverridesStatus,
    capabilityOverridesViewerKey,
  } = useProperty();
  const standing = useActiveScopeStanding();
  const role = standing.role;
  const viewerKey = activePropertyViewerKey;
  const companyScope = activeScope.kind === 'company';
  const ready = companyScope
    ? standing.ready
    : Boolean(
      viewerKey
      && capabilityOverridesStatus === 'ready'
      && capabilityOverridesPropertyId === activePropertyId
      && capabilityOverridesViewerKey === viewerKey
    );
  const overrides = companyScope ? NO_OVERRIDES : capabilityOverrides;
  return useCallback(
    (capability: CapabilityKey) => (
      ready
      && standing.ready
      && can(role ? { role } : null, capability, overrides)
    ),
    [role, ready, standing.ready, overrides],
  );
}
