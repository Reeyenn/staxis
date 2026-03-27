'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
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
} from '@/lib/firestore';
import { getDefaultPublicAreas, getDefaultLaundryCategories } from '@/lib/defaults';
import { format } from 'date-fns';
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
  const [activePropertyId, setActivePropertyIdState] = useState<string | null>(null);
  const [activeProperty, setActiveProperty] = useState<Property | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);
  const [laundryConfig, setLaundryConfig] = useState<LaundryCategory[]>([]);
  const [loading, setLoading] = useState(true);

  const setActivePropertyId = (id: string) => {
    setActivePropertyIdState(id);
    localStorage.setItem('hotelops-active-property', id);
  };

  // Load properties list
  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const props = await getProperties(user.uid);
        setProperties(props);

        const stored = localStorage.getItem('hotelops-active-property');
        const pid = stored && props.find(p => p.id === stored) ? stored : props[0]?.id ?? null;
        setActivePropertyIdState(pid);
      } catch (err) {
        console.error('PropertyContext: failed to load properties', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  // Load active property data.
  // Staff is loaded via onSnapshot (real-time) so it updates when the network
  // response arrives after a cache miss — preventing the intermittent "no staff"
  // bug caused by getDocs returning an empty cached snapshot.
  useEffect(() => {
    if (!user || !activePropertyId) {
      setActiveProperty(null);
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
      // Load property separately so a failure here doesn't kill staff.
      try {
        const prop = await getProperty(user.uid, activePropertyId);
        if (!cancelled) setActiveProperty(prop);
      } catch (err) {
        console.error('PropertyContext: failed to load property', err);
      }

      // Load areas + laundry config in a separate try/catch so a migration
      // failure never affects staff loading.
      try {
        const [areas, laundry] = await Promise.all([
          getPublicAreas(user.uid, activePropertyId),
          getLaundryConfig(user.uid, activePropertyId),
        ]);

        if (cancelled) return;

        // Seed defaults if empty
        if (areas.length === 0) {
          const defaults = getDefaultPublicAreas().map(a => ({ ...a, id: generateId() }));
          await bulkSetPublicAreas(user.uid, activePropertyId!, defaults);
          if (!cancelled) setPublicAreas(defaults);
        } else {
          setPublicAreas(areas);
        }

        // Migrate bad laundry defaults: if any category has minutesPerLoad >= 60,
        // it was seeded with the old incorrect values — reset to fixed defaults.
        const laundryNeedsMigration = laundry.length === 0 || laundry.some(c => c.minutesPerLoad >= 60);
        if (laundryNeedsMigration) {
          const defaults = getDefaultLaundryCategories().map(c => ({ ...c, id: generateId() }));
          await Promise.all(defaults.map(c => setLaundryCategory(user.uid, activePropertyId!, c)));
          if (!cancelled) setLaundryConfig(defaults);
        } else {
          if (!cancelled) setLaundryConfig(laundry);
        }

        // Migrate bad public area defaults: if all non-daily areas have today as startDate,
        // they were seeded without staggering — reset to fixed defaults.
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const nonDailyAreas = areas.filter(a => a.frequencyDays > 1 && !a.onlyWhenRented);
        const areasNeedMigration = areas.length > 0 && nonDailyAreas.length > 0 &&
          nonDailyAreas.every(a => a.startDate === todayStr);
        if (areasNeedMigration) {
          const defaults = getDefaultPublicAreas().map(a => ({ ...a, id: generateId() }));
          await bulkSetPublicAreas(user.uid, activePropertyId!, defaults);
          if (!cancelled) setPublicAreas(defaults);
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
    setActiveProperty(prop);
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
