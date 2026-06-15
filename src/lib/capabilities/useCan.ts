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
 * While the override map is still loading it is undefined → can() falls back to
 * the everyone-everything default (admin-only caps stay closed). The server
 * re-checks on every request, so a brief optimistic "allowed" can never leak
 * data — at worst a button flickers, then the route 403s.
 */
export function useCan(): (capability: CapabilityKey) => boolean {
  const { user } = useAuth();
  const { capabilityOverrides } = useProperty();
  const role = user?.role ?? null;
  return useCallback(
    (capability: CapabilityKey) => can(role ? { role } : null, capability, capabilityOverrides),
    [role, capabilityOverrides],
  );
}
