'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import type { CapabilityOverrideMap } from '@/lib/capabilities/can';
import {
  getProperties,
  getProperty,
  getStaff,
  getPublicAreas,
  getLaundryConfig,
  bulkSetPublicAreas,
  setLaundryCategory,
  subscribeToStaff,
} from '@/lib/db';
import { getDefaultPublicAreas, getDefaultLaundryCategories } from '@/lib/defaults';
import { isOnboardingInProgress } from '@/lib/onboarding/state';
import type { Property, StaffMember, PublicArea, LaundryCategory } from '@/types';
import { generateId } from '@/lib/utils';

interface PropertyContextType {
  properties: Property[];
  activeProperty: Property | null;
  activePropertyId: string | null;
  staff: StaffMember[];
  staffLoaded: boolean;
  publicAreas: PublicArea[];
  laundryConfig: LaundryCategory[];
  /** The active hotel's capability restrictions (admin's Access-tab toggles).
   *  Empty = everyone-everything (the default). Drives useCan(). */
  capabilityOverrides: CapabilityOverrideMap;
  loading: boolean;
  setActivePropertyId: (id: string) => void;
  refreshProperty: () => Promise<void>;
  refreshStaff: () => Promise<void>;
  refreshPublicAreas: () => Promise<void>;
  refreshLaundryConfig: () => Promise<void>;
  refreshCapabilities: () => Promise<void>;
}

const PropertyContext = createContext<PropertyContextType>({
  properties: [],
  activeProperty: null,
  activePropertyId: null,
  staff: [],
  staffLoaded: false,
  publicAreas: [],
  laundryConfig: [],
  capabilityOverrides: {},
  loading: true,
  setActivePropertyId: () => {},
  refreshProperty: async () => {},
  refreshStaff: async () => {},
  refreshPublicAreas: async () => {},
  refreshLaundryConfig: async () => {},
  refreshCapabilities: async () => {},
});

/** Read one hotel's capability override map via the service-role-backed route
 *  (the table is deny-all RLS, so a direct browser read would return []). Any
 *  failure falls back to {} = everyone-everything; the server re-checks anyway.
 *
 *  CRITICAL — this MUST fail soft, never force a logout. We pass our OWN
 *  Authorization header, which makes fetchWithAuth treat the call as "caller
 *  opted out of 401 recovery" and RETURN the 401 instead of running its
 *  signOut + redirect-to-/signin path (see api-fetch.ts). Reason: this is a
 *  non-critical UI hint that auto-fires the instant a single-property owner is
 *  authenticated — including the 2FA-trust window during onboarding / a fresh
 *  login, where it transiently 401s `requires_2fa`. With the default
 *  fetchWithAuth recovery, that 401 nuked the session and bounced the owner to
 *  /signin the moment they entered their 2FA code (the access-control feature,
 *  2026-06-14, introduced this call and the regression). Now it just yields {}.
 */
async function fetchOverridesFor(pid: string): Promise<CapabilityOverrideMap> {
  let token: string | null = null;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? null;
  } catch { /* no session → fall through to {} */ }
  if (!token) return {};
  try {
    const res = await fetchWithAuth(`/api/capabilities/overrides?propertyId=${encodeURIComponent(pid)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return {};
    const json = await res.json().catch(() => null);
    return (json?.data?.overrides ?? {}) as CapabilityOverrideMap;
  } catch {
    // SessionEndedError or network — never propagate into a logout.
    return {};
  }
}

export function PropertyProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [properties, setProperties] = useState<Property[]>([]);
  const [activePropertyId, setActivePropertyIdState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('hotelops-active-property');
    return null;
  });
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);
  const [laundryConfig, setLaundryConfig] = useState<LaundryCategory[]>([]);
  const [capabilityOverrides, setCapabilityOverrides] = useState<CapabilityOverrideMap>({});
  const [loading, setLoading] = useState(true);

  // Derived from properties list - no async needed, always in sync
  const activeProperty = useMemo(
    () => properties.find(p => p.id === activePropertyId) ?? null,
    [properties, activePropertyId]
  );

  // Is the active property still in the PRISTINE wizard phase — mid-onboarding
  // AND the wizard has never been left for the app (onboardingPromptShownAt
  // null)? Only then do we skip the capability-override fetch below. Once the
  // owner has dropped into the app on a half-set-up hotel (stamped), it's a
  // normal operable hotel — staff may have joined and the Access tab's
  // restrictions must apply, so overrides MUST be fetched. A primitive (not the
  // property object) so the capabilities effect depends on it without re-firing
  // on unrelated property-data updates.
  const activeOnboardingInProgress = activeProperty
    ? isOnboardingInProgress(activeProperty.onboardingCompletedAt, activeProperty.onboardingState)
      && !activeProperty.onboardingPromptShownAt
    : false;

  const setActivePropertyId = (id: string) => {
    setActivePropertyIdState(id);
    localStorage.setItem('hotelops-active-property', id);
  };

  // Cross-tab sync (audit/concurrency #13). Without this, swapping the
  // active property in Tab A leaves Tab B's dashboard/rooms/staff list
  // pointing at the OLD property until manual reload — confusing in
  // multi-property accounts.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'hotelops-active-property') return;
      const next = e.newValue;
      if (next && next !== activePropertyId) {
        setActivePropertyIdState(next);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [activePropertyId]);

  // Load properties list.
  // After sign-in there may be a brief delay before the RLS context
  // (auth.uid() in Postgres) catches up with the Supabase client's JWT —
  // typically a few hundred ms. If the first attempt fails with a permission
  // error, retry with a short backoff so the user isn't greeted by a
  // spurious "No properties found" screen during that window.
  //
  // ⚠️ The dependency below is INTENTIONALLY narrow (uid + role + access)
  // rather than the full `user` object. Reason: AuthContext's
  // onAuthStateChange handler fires on every Supabase token refresh
  // (~hourly, plus on tab focus/visibility). Each fire creates a NEW
  // appUser object reference even though the data is identical. If this
  // effect depended on `[user]` (the reference), every token refresh
  // would re-run loadProps and flip setLoading(true) — producing a brief
  // 'loading spinner over the dashboard' that the operator sees every
  // time they come back to the tab. Depending only on the identity-
  // bearing primitives makes this effect idempotent across refreshes.
  // The full user object is still in scope inside the effect; we just
  // don't react to its reference identity.
  const userUid           = user?.uid;
  const userRole          = user?.role;
  const userPropertyAccessKey = (user?.propertyAccess ?? []).join(',');
  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const loadProps = async (retries = 3): Promise<void> => {
      try {
        const allProps = await getProperties(user.uid);
        if (cancelled) return;
        // Admin role or wildcard access sees all properties
        const access = user.propertyAccess ?? [];
        const props = user.role === 'admin' || access.includes('*')
          ? allProps
          : allProps.filter(p => access.includes(p.id));
        setProperties(props);

        const stored = localStorage.getItem('hotelops-active-property');
        const pid = stored && props.find(p => p.id === stored) ? stored : props[0]?.id ?? null;
        setActivePropertyIdState(pid);
      } catch (err) {
        if (cancelled) return;
        // Detect Supabase/PostgREST permission errors.
        //   - PGRST301 = JWT-related (missing/invalid/expired auth)
        //   - PGRST116 = no rows returned where one expected (not really perm,
        //     but symptomatic of an auth race where RLS hid the row)
        //   - '42501' = Postgres "insufficient_privilege"
        //   - Text fallbacks for anything that doesn't bubble a code.
        //
        // Firestore-era strings ('permission', 'unauthorized',
        // 'unauthenticated') kept as a safety net but will rarely match
        // Supabase responses.
        const e = err as { code?: string; message?: string } | undefined;
        const code = String(e?.code ?? '').toUpperCase();
        const errStr = String(e?.message ?? err).toLowerCase();
        const isPermErr =
          code === 'PGRST301' ||
          code === 'PGRST116' ||
          code === '42501' ||
          errStr.includes('policy') ||
          errStr.includes('jwt') ||
          errStr.includes('permission') ||
          errStr.includes('unauthorized') ||
          errStr.includes('unauthenticated');
        // Retry with short backoff: 200ms, 500ms, 1s.
        if (retries > 0 && isPermErr) {
          const delay = retries === 3 ? 200 : retries === 2 ? 500 : 1000;
          await new Promise(r => setTimeout(r, delay));
          if (!cancelled) return loadProps(retries - 1);
        }
        console.error('PropertyContext: failed to load properties', err);
      }
    };

    void (async () => {
      setLoading(true);
      await loadProps();
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
    // See note above for why we depend on identity primitives, not `user`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userUid, userRole, userPropertyAccessKey]);

  // Load active property data.
  // Staff is loaded via onSnapshot (real-time) so it updates when the network
  // response arrives after a cache miss - preventing the intermittent "no staff"
  // bug caused by getDocs returning an empty cached snapshot.
  // ── Real-time staff listener ─────────────────────────────────────────────
  // Keyed on the raw activePropertyId so staff load immediately (responsiveness).
  // Fires with the local cache first (possibly empty), then again when the
  // server response arrives — eliminating the cache-vs-server "no staff" race.
  useEffect(() => {
    if (!user || !activePropertyId) {
      setStaff([]);
      setStaffLoaded(false);
      return;
    }
    let cancelled = false;
    const unsubStaff = subscribeToStaff(user.uid, activePropertyId, staffList => {
      if (!cancelled) {
        setStaff(staffList);
        setStaffLoaded(true);
      }
    });
    return () => {
      cancelled = true;
      unsubStaff();
    };
    // Depend on the stable uid (not the object ref) so a token refresh doesn't
    // tear down + recreate the subscription every hour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userUid, activePropertyId]);

  // ── Areas + laundry config (with first-time seed) ────────────────────────
  // Keyed on the RESOLVED active property — i.e. only once the active id is
  // confirmed to exist in the user's loaded `properties` list — NOT the raw
  // remembered id. Why: `activePropertyId` initializes straight from
  // localStorage, so on first paint (before the properties list re-validates it)
  // it can be a STALE/deleted property id. The zero-rows seed path below would
  // then try to INSERT public_areas for a property that no longer exists and
  // FK-violate (`public_areas_property_id_fkey`, 23503) — a harmless-but-noisy
  // console error. Gating on the resolved property means a seed only ever fires
  // for a real property the user has access to, and it still re-runs (and seeds)
  // the moment a genuinely new property resolves. (Fix 2026-06-18.)
  const resolvedPropertyId = activeProperty?.id ?? null;
  useEffect(() => {
    if (!user || !resolvedPropertyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [areas, laundry] = await Promise.all([
          getPublicAreas(user.uid, resolvedPropertyId),
          getLaundryConfig(user.uid, resolvedPropertyId),
        ]);
        if (cancelled) return;

        // First-time seed only (brand-new property with zero rows). Otherwise we
        // trust the DB. (Initial seeding normally happens server-side in
        // scripts/seed-supabase.js / onboarding; this is the client fallback.)
        if (areas.length === 0) {
          const defaults = getDefaultPublicAreas().map(a => ({ ...a, id: generateId() }));
          await bulkSetPublicAreas(user.uid, resolvedPropertyId, defaults);
          if (!cancelled) setPublicAreas(defaults);
        } else {
          if (!cancelled) setPublicAreas(areas);
        }

        if (laundry.length === 0) {
          const defaults = getDefaultLaundryCategories().map(c => ({ ...c, id: generateId() }));
          await Promise.all(defaults.map(c => setLaundryCategory(user.uid, resolvedPropertyId, c)));
          if (!cancelled) setLaundryConfig(defaults);
        } else {
          if (!cancelled) setLaundryConfig(laundry);
        }
      } catch (err) {
        console.error('PropertyContext: failed to load areas/laundry config', err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userUid, resolvedPropertyId]);

  // Load the active hotel's capability overrides whenever the hotel (or the
  // signed-in user) changes, so useCan() resolves from the same restrictions the
  // server enforces. Same identity-primitive dependency reasoning as above — we
  // don't want a token refresh to re-fetch.
  useEffect(() => {
    if (!user || !activePropertyId) {
      setCapabilityOverrides({});
      return;
    }
    // Don't fire this protected call while the property is still mid-onboarding.
    // The owner belongs in the signup wizard (not the app), their 2FA device-
    // trust may still be settling, and overrides default to everyone-everything
    // anyway. Firing it the instant a freshly-created 1-property owner verifies
    // is exactly what raced a `requires_2fa` 401 into a forced logout → /signin.
    if (activeOnboardingInProgress) {
      setCapabilityOverrides({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const map = await fetchOverridesFor(activePropertyId);
        if (!cancelled) setCapabilityOverrides(map);
      } catch {
        if (!cancelled) setCapabilityOverrides({});
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userUid, activePropertyId, activeOnboardingInProgress]);

  const refreshCapabilities = useCallback(async () => {
    if (!activePropertyId) { setCapabilityOverrides({}); return; }
    try { setCapabilityOverrides(await fetchOverridesFor(activePropertyId)); }
    catch { setCapabilityOverrides({}); }
  }, [activePropertyId]);

  const refreshProperty = async () => {
    if (!user || !activePropertyId) return;
    const prop = await getProperty(user.uid, activePropertyId);
    if (prop) {
      setProperties(prev => prev.map(p => p.id === activePropertyId ? prop : p));
    }
  };

  const refreshStaff = async () => {
    if (!user || !activePropertyId) return;
    const list = await getStaff(user.uid, activePropertyId);
    setStaff(list);
  };

  const refreshPublicAreas = async () => {
    if (!user || !activePropertyId) return;
    const areas = await getPublicAreas(user.uid, activePropertyId);
    setPublicAreas(areas);
  };

  const refreshLaundryConfig = async () => {
    if (!user || !activePropertyId) return;
    const config = await getLaundryConfig(user.uid, activePropertyId);
    setLaundryConfig(config);
  };

  return (
    <PropertyContext.Provider
      value={{
        properties,
        activeProperty,
        activePropertyId,
        staff,
        staffLoaded,
        publicAreas,
        laundryConfig,
        capabilityOverrides,
        loading,
        setActivePropertyId,
        refreshProperty,
        refreshStaff,
        refreshPublicAreas,
        refreshLaundryConfig,
        refreshCapabilities,
      }}
    >
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperty() {
  return useContext(PropertyContext);
}
