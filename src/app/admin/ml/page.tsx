'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { getProperty } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { HotelSidebar, type HotelSidebarEntry } from './_components/HotelSidebar';
import { InventoryTimeline } from './_components/inventory/InventoryTimeline';
import { InventoryDataFuelGauge } from './_components/inventory/InventoryDataFuelGauge';
import { InventoryPipelineHealth } from './_components/inventory/InventoryPipelineHealth';
import { InventoryRecentAnomaliesTable } from './_components/inventory/InventoryRecentAnomaliesTable';
import { InventoryAdoptionPanel } from './_components/inventory/InventoryAdoptionPanel';
import { HousekeepingTimeline } from './_components/housekeeping/HousekeepingTimeline';
import { HousekeepingDataFuelGauge } from './_components/housekeeping/HousekeepingDataFuelGauge';
import { HousekeepingSystemHealth } from './_components/housekeeping/HousekeepingSystemHealth';
import { HousekeepingOverridesTable } from './_components/housekeeping/HousekeepingOverridesTable';
import { HousekeepingAdoption } from './_components/housekeeping/HousekeepingAdoption';

/**
 * /admin/ml — Owner-only ML cockpit.
 *
 * Two tabs: Housekeeping + Inventory. Both share the same layout pattern:
 *   • Default = network view aggregating across every platform property
 *   • Right sidebar lists hotels with status pips; click to drill in
 *   • URL ?propertyId=<uuid> drives single-hotel mode
 *
 * Both tabs are admin-only via API-side requireAdmin (page-level owner gate
 * provides defense-in-depth).
 */

type Tab = 'housekeeping' | 'inventory';

// ─── Inventory cockpit data shape (matches /api/admin/ml/inventory/cockpit-data) ──
interface InventoryCockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: Array<{
    id: string; name: string; brand: string | null;
    daysSinceFirstCount: number; itemsTotal: number; itemsGraduated: number;
    status: 'healthy' | 'warming' | 'issue';
    lastTrainingAt: string | null; lastPredictionAt: string | null;
    countsLast7d: number;
    countsLast1h: number;
    joinedAt: string | null;
    isTest: boolean;
  }>;
  aggregate: {
    hotelCount: number; totalCounts: number; totalCountsLast7d: number;
    totalCountsLast24h: number; totalCountsLast1h: number;
    totalItems: number; totalItemsGraduated: number;
    totalItemsLearning: number; fleetMedianDay: number;
    daysOfHistoryRange: { min: number; max: number };
    healthCounts: { healthy: number; warming: number; issue: number };
    daysToNextMilestoneMedian: number | null;
    nextMilestoneLabel: string;
    phaseHistogram: Array<{ phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }>;
    dailyCountSeries: Array<{ date: string; recorded: number }>;
    lastTrainingRunAt: string | null; lastInferenceWriteAt: string | null;
    lastAnomalyFiredAt: string | null;
    predictionsLast24h: number; activeItemModelCount: number;
    nextTrainingAt: string;
    nextPredictionAt: string;
  };
  recentAnomalies: Array<{
    id: string; itemId: string | null; itemName: string;
    reason: string; severity: 'info' | 'warn' | 'critical';
    ts: string; propertyId: string; propertyName: string;
  }>;
  topCounters: Array<{
    countedBy: string; countCount: number; itemsTouched: number;
    lastCountedAt: string | null; propertyId: string; propertyName: string;
  }>;
}

// ─── Housekeeping cockpit data shape ──
interface HKCockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: Array<{
    id: string; name: string; brand: string | null;
    daysSinceFirstEvent: number; staffActive: number; modelsActive: number;
    status: 'healthy' | 'warming' | 'issue';
    lastTrainingAt: string | null; lastInferenceAt: string | null;
    eventsLast7d: number;
    eventsLast1h: number;
    joinedAt: string | null;
    isTest: boolean;
  }>;
  aggregate: {
    hotelCount: number; totalEvents: number; totalEventsLast7d: number;
    totalEventsLast24h: number; totalEventsLast1h: number; totalDiscardedEvents: number;
    distinctStaff: number; distinctRooms: number;
    fleetMedianDay: number; daysOfHistoryRange: { min: number; max: number };
    healthCounts: { healthy: number; warming: number; issue: number };
    daysToNextMilestoneMedian: number | null;
    nextMilestoneLabel: string;
    phaseHistogram: Array<{ phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }>;
    dailyEventSeries: Array<{ date: string; recorded: number; discarded: number }>;
    lastTrainingRunAt: string | null; lastInferenceWriteAt: string | null;
    lastOverrideAt: string | null;
    predictionsLast24h: number; activeModelRunCount: number;
    optimizerActive: boolean;
    nextTrainingAt: string;
    nextPredictionAt: string;
  };
  recentOverrides: Array<{
    id: string; date: string; optimizerRecommendation: number; manualHeadcount: number;
    overrideReason: string | null; propertyId: string; propertyName: string;
  }>;
  topAdoption: Array<{
    staffId: string; staffName: string; roomsAssigned: number; roomsWithEvent: number;
    adoptionPct: number; propertyId: string; propertyName: string;
  }>;
}

// Format an ISO date as "Joined N days ago" or null if no date.
function joinedAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return null;
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'Joined today';
  if (days < 30) return `Joined ${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Joined ${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `Joined ${years} year${years === 1 ? '' : 's'} ago`;
}

export default function MLPage() {
  return (
    <Suspense fallback={
      <AppLayout>
        <div style={{ padding: '32px', textAlign: 'center', color: '#454652' }}>Loading…</div>
      </AppLayout>
    }>
      <MLPageInner />
    </Suspense>
  );
}

function MLPageInner() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = tabParam === 'inventory' ? 'inventory' : 'housekeeping';
  const propertyIdParam = searchParams.get('propertyId');

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [invCockpit, setInvCockpit] = useState<InventoryCockpitData | null>(null);
  const [hkCockpit, setHkCockpit] = useState<HKCockpitData | null>(null);
  const [cockpitLoading, setCockpitLoading] = useState(true);
  const [cockpitErr, setCockpitErr] = useState<string | null>(null);

  // Owner gating
  useEffect(() => {
    if (authLoading || propLoading || !user || !activePropertyId) return;
    (async () => {
      try {
        const prop = await getProperty(user.uid, activePropertyId);
        if (!prop) { setIsOwner(false); return; }
        const { data, error } = await supabase
          .from('properties')
          .select('owner_id')
          .eq('id', activePropertyId)
          .maybeSingle();
        if (error || !data) { setIsOwner(false); return; }
        const ownerId = String(data.owner_id);
        setIsOwner(ownerId === user.uid);
      } catch (err) {
        console.error('MLPage owner check failed:', err);
        setIsOwner(false);
      }
    })();
  }, [user, activePropertyId, authLoading, propLoading]);

  // Redirects
  useEffect(() => {
    if (!authLoading && !user) router.replace('/signin');
  }, [user, authLoading, router]);
  useEffect(() => {
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Fetch cockpit data — branch on tab
  useEffect(() => {
    if (isOwner !== true) return;
    let cancelled = false;
    (async () => {
      setCockpitLoading(true);
      setCockpitErr(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const base = tab === 'inventory'
          ? '/api/admin/ml/inventory/cockpit-data'
          : '/api/admin/ml/housekeeping/cockpit-data';
        const url = propertyIdParam ? `${base}?propertyId=${propertyIdParam}` : base;
        const res = await fetch(url, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (!cancelled) {
          if (tab === 'inventory') setInvCockpit(json.data);
          else setHkCockpit(json.data);
        }
      } catch (e) {
        if (!cancelled) setCockpitErr((e as Error).message ?? 'failed');
      } finally {
        if (!cancelled) setCockpitLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, isOwner, propertyIdParam]);

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'housekeeping') params.delete('tab');
    else params.set('tab', next);
    params.delete('propertyId');     // drop hotel selection on tab switch
    router.replace(`/admin/ml${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  // Loading / not-owner gates
  if (authLoading || propLoading || isOwner === null) {
    return (
      <AppLayout>
        <div style={{ padding: '32px', textAlign: 'center', color: '#454652' }}>Loading...</div>
      </AppLayout>
    );
  }
  if (!isOwner) {
    return (
      <AppLayout>
        <div style={{ padding: '32px', textAlign: 'center', color: '#454652' }}>
          <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Page not found</div>
          <div style={{ fontSize: '14px', color: '#7a8a9e' }}>
            The page you are looking for does not exist.
          </div>
        </div>
      </AppLayout>
    );
  }

  // Sidebar entries based on the active tab's data. Each tab generates its
  // own volumeLabel + activeNowLabel since the units differ (events vs counts).
  const sidebarEntries: HotelSidebarEntry[] = tab === 'inventory'
    ? (invCockpit?.properties.map((p) => ({
        id: p.id, name: p.name, brand: p.brand, status: p.status,
        isTest: p.isTest,
        volumeLabel: `${p.countsLast7d.toLocaleString()} count${p.countsLast7d === 1 ? '' : 's'} / 7d`,
        activeNowLabel: p.countsLast1h > 0 ? `${p.countsLast1h} counting now` : null,
        joinedLabel: joinedAgo(p.joinedAt),
      })) ?? [])
    : (hkCockpit?.properties.map((p) => ({
        id: p.id, name: p.name, brand: p.brand, status: p.status,
        isTest: p.isTest,
        volumeLabel: `${p.eventsLast7d.toLocaleString()} clean${p.eventsLast7d === 1 ? '' : 's'} / 7d`,
        activeNowLabel: p.eventsLast1h > 0 ? `${p.eventsLast1h} working now` : null,
        joinedLabel: joinedAgo(p.joinedAt),
      })) ?? []);
  // Network count = number of NON-test hotels (matches what the fleet
  // aggregate covers). The sidebar still lists test hotels but they're
  // dimmed and tagged.
  const totalNetworkCount = sidebarEntries.filter((e) => !e.isTest).length;

  return (
    <AppLayout>
      <div style={{ padding: '32px', maxWidth: '1920px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '20px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
            ML Cockpit
          </h1>
          <p style={{ fontSize: '14px', color: '#7a8a9e', marginTop: '4px' }}>
            Monitor model health, predictions, and system state.
          </p>
        </div>

        {/* Tab selector */}
        <div
          role="tablist"
          aria-label="ML Cockpit sections"
          style={{
            display: 'inline-flex',
            background: '#f0f4f7',
            border: '1px solid rgba(78,90,122,0.12)',
            borderRadius: '10px',
            padding: '4px',
            marginBottom: '24px',
            gap: '4px',
          }}
        >
          {[
            { id: 'housekeeping' as Tab, label: 'Housekeeping' },
            { id: 'inventory' as Tab, label: 'Inventory' },
          ].map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '8px 18px',
                  background: active ? '#ffffff' : 'transparent',
                  color: active ? '#004b4b' : '#454652',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: active ? 600 : 500,
                  cursor: 'pointer',
                  boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Two-column layout for both tabs (panels left, sidebar right) */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 280px',
          gap: '24px',
          alignItems: 'flex-start',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {cockpitLoading ? (
              <div style={{ padding: '32px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px' }}>
                Loading cockpit data…
              </div>
            ) : cockpitErr ? (
              <div style={{
                padding: '14px 16px',
                background: 'rgba(220,52,69,0.06)',
                border: '1px solid rgba(220,52,69,0.20)',
                borderRadius: '10px',
                color: '#b21e2f',
                fontSize: '13px',
              }}>
                Failed to load cockpit: {cockpitErr}
              </div>
            ) : tab === 'inventory' && invCockpit ? (
              <InventoryPanels cockpit={invCockpit} />
            ) : tab === 'housekeeping' && hkCockpit ? (
              <HousekeepingPanels cockpit={hkCockpit} />
            ) : null}
          </div>

          <HotelSidebar
            properties={sidebarEntries}
            selectedPropertyId={propertyIdParam}
            totalNetworkCount={totalNetworkCount}
            activeTab={tab}
          />
        </div>
      </div>
    </AppLayout>
  );
}

// ─── Inventory panels (existing, unchanged) ──

function InventoryPanels({ cockpit }: { cockpit: InventoryCockpitData }) {
  const { mode, selectedProperty, aggregate, recentAnomalies, topCounters, properties } = cockpit;

  if (mode === 'single') {
    const sp = selectedProperty;
    const me = sp ? properties.find((p) => p.id === sp.id) : null;
    if (!sp || !me) {
      return (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>
          Selected hotel not found.
        </div>
      );
    }
    return (
      <>
        <InventoryTimeline
          mode="single"
          day={me.daysSinceFirstCount}
          itemsTotal={me.itemsTotal}
          itemsGraduated={me.itemsGraduated}
          countsLast1h={me.countsLast1h}
          daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
          nextMilestoneLabel={aggregate.nextMilestoneLabel}
          aiMode="auto"
          hotelName={sp.name}
        />
        <InventoryDataFuelGauge
          mode="single"
          totalCounts={aggregate.totalCounts}
          countsLast7d={aggregate.totalCountsLast7d}
          countsLast24h={aggregate.totalCountsLast24h}
          itemsTracked={aggregate.totalItems}
          dailyCountSeries={aggregate.dailyCountSeries}
          daysOfHistory={me.daysSinceFirstCount}
          hotelName={sp.name}
        />
        <InventoryPipelineHealth
          mode="single"
          lastTrainingRunAt={aggregate.lastTrainingRunAt}
          lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
          lastAnomalyFiredAt={aggregate.lastAnomalyFiredAt}
          activeItemModelCount={aggregate.activeItemModelCount}
          predictionsLast24h={aggregate.predictionsLast24h}
          nextTrainingAt={aggregate.nextTrainingAt}
          nextPredictionAt={aggregate.nextPredictionAt}
          hotelName={sp.name}
        />
        <InventoryRecentAnomaliesTable mode="single" rows={recentAnomalies} />
        <InventoryAdoptionPanel mode="single" rows={topCounters} />
      </>
    );
  }

  return (
    <>
      <InventoryTimeline
        mode="fleet"
        fleetMedianDay={aggregate.fleetMedianDay}
        hotelCount={aggregate.hotelCount}
        itemsLearningTotal={aggregate.totalItemsLearning}
        itemsGraduatedTotal={aggregate.totalItemsGraduated}
        totalCountsLast1h={aggregate.totalCountsLast1h}
        daysToNextMilestoneMedian={aggregate.daysToNextMilestoneMedian}
        nextMilestoneLabel={aggregate.nextMilestoneLabel}
        phaseHistogram={aggregate.phaseHistogram}
      />
      <InventoryDataFuelGauge
        mode="fleet"
        totalCounts={aggregate.totalCounts}
        countsLast7d={aggregate.totalCountsLast7d}
        countsLast24h={aggregate.totalCountsLast24h}
        itemsTracked={aggregate.totalItems}
        dailyCountSeries={aggregate.dailyCountSeries}
        hotelCount={aggregate.hotelCount}
        daysOfHistoryRange={aggregate.daysOfHistoryRange}
      />
      <InventoryPipelineHealth
        mode="fleet"
        lastTrainingRunAt={aggregate.lastTrainingRunAt}
        lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
        lastAnomalyFiredAt={aggregate.lastAnomalyFiredAt}
        activeItemModelCount={aggregate.activeItemModelCount}
        predictionsLast24h={aggregate.predictionsLast24h}
        nextTrainingAt={aggregate.nextTrainingAt}
        nextPredictionAt={aggregate.nextPredictionAt}
        hotelCount={aggregate.hotelCount}
        healthCounts={aggregate.healthCounts}
      />
      <InventoryRecentAnomaliesTable mode="fleet" rows={recentAnomalies} />
      <InventoryAdoptionPanel mode="fleet" rows={topCounters} />
    </>
  );
}

// ─── Housekeeping panels (new — mirror inventory pattern) ──

function HousekeepingPanels({ cockpit }: { cockpit: HKCockpitData }) {
  const { mode, selectedProperty, aggregate, recentOverrides, topAdoption, properties } = cockpit;

  if (mode === 'single') {
    const sp = selectedProperty;
    const me = sp ? properties.find((p) => p.id === sp.id) : null;
    if (!sp || !me) {
      return (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>
          Selected hotel not found.
        </div>
      );
    }
    return (
      <>
        <HousekeepingTimeline
          mode="single"
          day={me.daysSinceFirstEvent}
          staffActive={me.staffActive}
          modelsActive={me.modelsActive}
          eventsLast1h={me.eventsLast1h}
          daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
          nextMilestoneLabel={aggregate.nextMilestoneLabel}
          hotelName={sp.name}
          optimizerActive={aggregate.optimizerActive}
        />
        <HousekeepingDataFuelGauge
          mode="single"
          totalEvents={aggregate.totalEvents}
          eventsLast7d={aggregate.totalEventsLast7d}
          eventsLast24h={aggregate.totalEventsLast24h}
          eventsLast1h={aggregate.totalEventsLast1h}
          totalDiscardedEvents={aggregate.totalDiscardedEvents}
          distinctStaff={aggregate.distinctStaff}
          distinctRooms={aggregate.distinctRooms}
          dailyEventSeries={aggregate.dailyEventSeries}
          daysOfHistory={me.daysSinceFirstEvent}
          hotelName={sp.name}
        />
        <HousekeepingSystemHealth
          mode="single"
          lastTrainingRunAt={aggregate.lastTrainingRunAt}
          lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
          lastOverrideAt={aggregate.lastOverrideAt}
          activeModelRunCount={aggregate.activeModelRunCount}
          predictionsLast24h={aggregate.predictionsLast24h}
          optimizerActive={aggregate.optimizerActive}
          nextTrainingAt={aggregate.nextTrainingAt}
          nextPredictionAt={aggregate.nextPredictionAt}
          hotelName={sp.name}
        />
        <HousekeepingOverridesTable mode="single" rows={recentOverrides} />
        <HousekeepingAdoption mode="single" rows={topAdoption} />
      </>
    );
  }

  return (
    <>
      <HousekeepingTimeline
        mode="fleet"
        fleetMedianDay={aggregate.fleetMedianDay}
        hotelCount={aggregate.hotelCount}
        totalStaff={aggregate.distinctStaff}
        totalModelsActive={aggregate.activeModelRunCount}
        totalEventsLast1h={aggregate.totalEventsLast1h}
        daysToNextMilestoneMedian={aggregate.daysToNextMilestoneMedian}
        nextMilestoneLabel={aggregate.nextMilestoneLabel}
        phaseHistogram={aggregate.phaseHistogram}
        optimizerActive={aggregate.optimizerActive}
      />
      <HousekeepingDataFuelGauge
        mode="fleet"
        totalEvents={aggregate.totalEvents}
        eventsLast7d={aggregate.totalEventsLast7d}
        eventsLast24h={aggregate.totalEventsLast24h}
        eventsLast1h={aggregate.totalEventsLast1h}
        totalDiscardedEvents={aggregate.totalDiscardedEvents}
        distinctStaff={aggregate.distinctStaff}
        distinctRooms={aggregate.distinctRooms}
        dailyEventSeries={aggregate.dailyEventSeries}
        hotelCount={aggregate.hotelCount}
        daysOfHistoryRange={aggregate.daysOfHistoryRange}
      />
      <HousekeepingSystemHealth
        mode="fleet"
        lastTrainingRunAt={aggregate.lastTrainingRunAt}
        lastInferenceWriteAt={aggregate.lastInferenceWriteAt}
        lastOverrideAt={aggregate.lastOverrideAt}
        activeModelRunCount={aggregate.activeModelRunCount}
        predictionsLast24h={aggregate.predictionsLast24h}
        optimizerActive={aggregate.optimizerActive}
        nextTrainingAt={aggregate.nextTrainingAt}
        nextPredictionAt={aggregate.nextPredictionAt}
        hotelCount={aggregate.hotelCount}
        healthCounts={aggregate.healthCounts}
      />
      <HousekeepingOverridesTable mode="fleet" rows={recentOverrides} />
      <HousekeepingAdoption mode="fleet" rows={topAdoption} />
    </>
  );
}
