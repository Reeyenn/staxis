'use client';

// Client-side capability gate. Reads the signed-in user (useAuth) and the ACTIVE
// hotel's override map (PropertyContext) and returns a `can(capability)` checker
// backed by the same pure can() the server uses — so a gated button and the
// server route it calls always agree.

import { useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { resolveViewerHotelStanding } from '@/lib/authorization/domain';
import { can } from './can';
import type { CapabilityKey } from './registry';
import type { AppRole } from '@/lib/roles';

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
 * Returns `(capability) => boolean` for the current user at the active hotel.
 * Fails closed until the override map is confirmed for the exact signed-in
 * viewer and selected hotel. The server re-checks every request, but client
 * controls must not flicker enabled or remain enabled after a capability read
 * times out merely because the default map is permissive.
 */
export function useCan(): (capability: CapabilityKey) => boolean {
  const {
    activePropertyId,
    activePropertyViewerKey,
    capabilityOverrides,
    capabilityOverridesPropertyId,
    capabilityOverridesStatus,
    capabilityOverridesViewerKey,
  } = useProperty();
  const standing = useActiveHotelStanding();
  const role = standing.role;
  const viewerKey = activePropertyViewerKey;
  const ready = Boolean(
    viewerKey
    && capabilityOverridesStatus === 'ready'
    && capabilityOverridesPropertyId === activePropertyId
    && capabilityOverridesViewerKey === viewerKey
  );
  return useCallback(
    (capability: CapabilityKey) => (
      ready
      && standing.ready
      && can(role ? { role } : null, capability, capabilityOverrides)
    ),
    [role, ready, standing.ready, capabilityOverrides],
  );
}
