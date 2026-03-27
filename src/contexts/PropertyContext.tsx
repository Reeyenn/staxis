'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import {
  getProperties,
  getProperty,
  getStaff,
  getPublicAreas,
  getLaundryConfig,
  bulkSetPublicAreas,
  setLaundryCategory,
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
      const props = await getProperties(user.uid);
      setProperties(props);

      const stored = localStorage.getItem('hotelops-active-property');
      const pid = stored && props.find(p => p.id === stored) ? stored : props[0]?.id ?? null;
      setActivePropertyIdState(pid);
      setLoading(false);
    })();
  }, [user]);

  // Load active property data
  useEffect(() => {
    if (!user || !activePropertyId) {
      setActiveProperty(null);
      return;
    }
    (async () => {
      try {
        const [prop, staffList, areas, laundry] = await Promise.all([
          getProperty(user.uid, activePropertyId),
          getStaff(user.uid, activePropertyId),
          getPublicAreas(user.uid, activePropertyId),
          getLaundryConfig(user.uid, activePropertyId),
        ]);

        setActiveProperty(prop);
        setStaff(staffList);

        // Seed defaults if empty
        if (areas.length === 0) {
          const defaults = getDefaultPublicAreas().map(a => ({ ...a, id: generateId() }));
          await bulkSetPublicAreas(user.uid, activePropertyId, defaults);
          setPublicAreas(defaults);
        } else {
          setPublicAreas(areas);
        }

        // Migrate bad laundry defaults: if any category has minutesPerLoad >= 60,
        // it was seeded with the old incorrect values — reset to fixed defaults.
        const laundryNeedsMigration = laundry.length === 0 || laundry.some(c => c.minutesPerLoad >= 60);
        if (laundryNeedsMigration) {
          const defaults = getDefaultLaundryCategories().map(c => ({ ...c, id: generateId() }));
          await Promise.all(defaults.map(c => setLaundryCategory(user.uid, activePropertyId!, c)));
          setLaundryConfig(defaults);
        } else {
          setLaundryConfig(laundry);
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
          setPublicAreas(defaults);
        }
      } catch (err) {
        console.error('PropertyContext: failed to load property data', err);
      }
    })();
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
