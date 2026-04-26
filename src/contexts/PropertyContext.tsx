'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
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
  loading: boolean;
  setActivePropertyId: (id: string) => void;
  refreshProperty: () => Promise<void>;
  refreshStaff: () => Promise<void>;
  refreshPublicAreas: () => Promise<void>;
  refreshLaundryConfig: () => Promise<void>;
}

const PropertyContext = createContext<PropertyContextType>({
  properties: [],
  activeProperty: null,
  activePropertyId: null,
  staff: [],
  staffLoaded: false,
  publicAreas: [],
  laundryConfig: [],
  loading: true,
  setActivePropertyId: () => {},
  refreshProperty: async () => {},
  refreshStaff: async () => {},
  refreshPublicAreas: async () => {},
  refreshLaundryConfig: async () => {},
});

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
  const [loading, setLoading] = useState(true);

  // Derived from properties list - no async needed, always in sync
  const activeProperty = useMemo(
    () => properties.find(p => p.id === activePropertyId) ?? null,
    [properties, activePropertyId]
  );

  const setActivePropertyId = (id: string) => {
    setActivePropertyIdState(id);
    localStorage.setItem('hotelops-active-property', id);
  };

  // Load properties list.
  // After sign-in there may be a brief delay before the RLS context
  // (auth.uid() in Postgres) catches up with the Supabase client's JWT —
  // typically a few hundred ms. If the first attempt fails with a permission
  // error, retry with a short backoff so the user isn't greeted by a
  // spurious "No properties found" screen during that window.
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

    (async () => {
      setLoading(true);
      await loadProps();
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [user]);

  // Load active property data.
  // Staff is loaded via onSnapshot (real-time) so it updates when the network
  // response arrives after a cache miss - preventing the intermittent "no staff"
  // bug caused by getDocs returning an empty cached snapshot.
  useEffect(() => {
    if (!user || !activePropertyId) {
      setStaff([]);
      setStaffLoaded(false);
      return;
    }

    let cancelled = false;

    // ── Real-time staff listener ───────────────────────────────────────────
    // Fires immediately with whatever is in the local cache (possibly empty),
    // then fires again when the server response arrives. This eliminates the
    // race where getDocs resolves from cache before data is on the server.
    const unsubStaff = subscribeToStaff(user.uid, activePropertyId, staffList => {
      if (!cancelled) {
        setStaff(staffList);
        setStaffLoaded(true);
      }
    });

    // ── Rest of property data (one-time fetch) ─────────────────────────────
    (async () => {
      // Load areas + laundry config in a separate try/catch so a load
      // failure never affects staff loading.
      try {
        const [areas, laundry] = await Promise.all([
          getPublicAreas(user.uid, activePropertyId),
          getLaundryConfig(user.uid, activePropertyId),
        ]);

        if (cancelled) return;

        // First-time seed only. If the property has zero rows of either kind,
        // we treat it as a brand-new property and lay down the defaults once.
        // Otherwise we trust whatever's in the DB — the user owns their data.
        //
        // History: there used to be auto-"migration" passes here that
        // re-seeded defaults if a row's minutesPerLoad >= 60 or if all
        // non-daily areas had today as startDate. Both used `generateId()`
        // for every default and called `setLaundryCategory` /
        // `bulkSetPublicAreas` (both upserts on `id`). Because the IDs were
        // fresh on every load, the upserts were effectively INSERTs and
        // every page load duplicated the seed. Result: a property with 3
        // canonical laundry rows had grown to 196 (and 23 areas to 48).
        // The fix is to never auto-write here — initial seeding already
        // happens in scripts/seed-supabase.js.
        if (areas.length === 0) {
          const defaults = getDefaultPublicAreas().map(a => ({ ...a, id: generateId() }));
          await bulkSetPublicAreas(user.uid, activePropertyId!, defaults);
          if (!cancelled) setPublicAreas(defaults);
        } else {
          if (!cancelled) setPublicAreas(areas);
        }

        if (laundry.length === 0) {
          const defaults = getDefaultLaundryCategories().map(c => ({ ...c, id: generateId() }));
          await Promise.all(defaults.map(c => setLaundryCategory(user.uid, activePropertyId!, c)));
          if (!cancelled) setLaundryConfig(defaults);
        } else {
          if (!cancelled) setLaundryConfig(laundry);
        }
      } catch (err) {
        console.error('PropertyContext: failed to load areas/laundry config', err);
      }
    })();

    return () => {
      cancelled = true;
      unsubStaff();
    };
  }, [user, activePropertyId]);

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
        loading,
        setActivePropertyId,
        refreshProperty,
        refreshStaff,
        refreshPublicAreas,
        refreshLaundryConfig,
      }}
    >
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperty() {
  return useContext(PropertyContext);
}
