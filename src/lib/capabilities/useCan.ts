'use client';

// Client-side capability gate. Reads the signed-in user (useAuth) and the ACTIVE
// hotel's override map (PropertyContext) and returns a `can(capability)` checker
// backed by the same pure can() the server uses — so a gated button and the
// server route it calls always agree.

import { useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { can } from './can';
import type { CapabilityKey } from './registry';

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
  const { user } = useAuth();
  const role = user?.role ?? null;
  const viewerKey = activePropertyViewerKey;
  const ready = Boolean(
    viewerKey
    && capabilityOverridesStatus === 'ready'
    && capabilityOverridesPropertyId === activePropertyId
    && capabilityOverridesViewerKey === viewerKey
  );
  return useCallback(
    (capability: CapabilityKey) => ready && can(role ? { role } : null, capability, capabilityOverrides),
    [role, ready, capabilityOverrides],
  );
}
