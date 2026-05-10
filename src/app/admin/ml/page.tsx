'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { getProperty } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { DataFuelGauge } from './_components/DataFuelGauge';
import { AdoptionPerHK } from './_components/AdoptionPerHK';
import { LayerStatusPanel } from './_components/LayerStatusPanel';
import { ShadowMAEChart } from './_components/ShadowMAEChart';
import { TodaysPredictionsTable } from './_components/TodaysPredictionsTable';
import { PipelineHealth } from './_components/PipelineHealth';
import { ManualTriggers } from './_components/ManualTriggers';
import { RecentOverridesTable } from './_components/RecentOverridesTable';
import { DisagreementHistory } from './_components/DisagreementHistory';
import { InventoryTimeline } from './_components/inventory/InventoryTimeline';
import { InventoryDataFuelGauge } from './_components/inventory/InventoryDataFuelGauge';
import { InventoryPipelineHealth } from './_components/inventory/InventoryPipelineHealth';
import { InventoryRecentAnomaliesTable } from './_components/inventory/InventoryRecentAnomaliesTable';
import { InventoryAdoptionPanel } from './_components/inventory/InventoryAdoptionPanel';
import { InventoryHotelSidebar } from './_components/inventory/InventoryHotelSidebar';

/**
 * /admin/ml — Owner-only ML cockpit.
 *
 * Two tabs: Housekeeping (per-active-property) + Inventory (network-wide
 * with optional drill-down via ?propertyId).
 *
 * Page is gated to property owners. Non-owners see a "Page not found" stub.
 * Inventory tab additionally requires admin role on the API side
 * (`/api/admin/ml/inventory/cockpit-data` uses requireAdmin) so it's
 * protected even if a non-admin owner somehow loaded the page.
 */

type Tab = 'housekeeping' | 'inventory';

// Shape mirrors the API route response. Imported inline to avoid circular
// import noise (route file lives under /app/api).
interface CockpitData {
  mode: 'network' | 'single';
  selectedProperty: { id: string; name: string } | null;
  properties: Array<{
    id: string; name: string; brand: string | null;
    daysSinceFirstCount: number; itemsTotal: number; itemsGraduated: number;
    status: 'healthy' | 'warming' | 'issue';
    lastTrainingAt: string | null; lastPredictionAt: string | null;
    countsLast7d: number;
  }>;
  aggregate: {
    hotelCount: number; totalCounts: number; totalCountsLast7d: number;
    totalCountsLast24h: number; totalItems: number; totalItemsGraduated: number;
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
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = tabParam === 'inventory' ? 'inventory' : 'housekeeping';
  const propertyIdParam = searchParams.get('propertyId');

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [cockpit, setCockpit] = useState<CockpitData | null>(null);
  const [cockpitLoading, setCockpitLoading] = useState(true);
  const [cockpitErr, setCockpitErr] = useState<string | null>(null);

  // ── Owner gating ──
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

  // ── Redirects ──
  useEffect(() => {
    if (!authLoading && !user) router.replace('/signin');
  }, [user, authLoading, router]);
  useEffect(() => {
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // ── Fetch cockpit data when on inventory tab ──
  useEffect(() => {
    if (tab !== 'inventory' || isOwner !== true) return;
    let cancelled = false;
    (async () => {
      setCockpitLoading(true);
      setCockpitErr(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const url = propertyIdParam
          ? `/api/admin/ml/inventory/cockpit-data?propertyId=${propertyIdParam}`
          : '/api/admin/ml/inventory/cockpit-data';
        const res = await fetch(url, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (!cancelled) setCockpit(json.data);
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
    if (next === 'housekeeping') {
      params.delete('tab');
      params.delete('propertyId');     // drop hotel selection when leaving inventory
    } else {
      params.set('tab', next);
    }
    router.replace(`/admin/ml${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  // ── Loading / not-owner gates ──
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

  return (
    <AppLayout>
      <div style={{ padding: '32px', maxWidth: '1920px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '20px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
            ML Cockpit{tab === 'housekeeping' ? ` — ${activeProperty?.name ?? 'Loading...'}` : ''}
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

        {/* Housekeeping tab — single-property panels (unchanged) */}
        {tab === 'housekeeping' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <DataFuelGauge />
            </div>
            <LayerStatusPanel layer="demand" />
            <LayerStatusPanel layer="supply" />
            <div style={{ gridColumn: '1 / -1' }}>
              <LayerStatusPanel layer="optimizer" />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <ShadowMAEChart />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <AdoptionPerHK />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <TodaysPredictionsTable />
            </div>
            <div style={{ gridColumn: '1 / 2' }}>
              <PipelineHealth />
            </div>
            <div style={{ gridColumn: '2 / 3' }}>
              <ManualTriggers />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <RecentOverridesTable />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <DisagreementHistory />
            </div>
          </div>
        )}

        {/* Inventory tab — network default + sidebar drill-down */}
        {tab === 'inventory' && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 280px',
            gap: '24px',
            alignItems: 'flex-start',
          }}>
            {/* Left column — panels */}
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
              ) : cockpit ? (
                <InventoryPanels cockpit={cockpit} />
              ) : null}
            </div>

            {/* Right column — sidebar */}
            <InventoryHotelSidebar
              properties={cockpit?.properties ?? []}
              selectedPropertyId={propertyIdParam}
              totalNetworkCount={cockpit?.properties.length ?? 0}
            />
          </div>
        )}
      </div>
    </AppLayout>
  );
}

/**
 * Renders the 5 inventory panels using the cockpit data slice. Picks
 * fleet-mode vs single-mode based on `cockpit.mode`.
 */
function InventoryPanels({ cockpit }: { cockpit: CockpitData }) {
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
          daysToNextMilestone={aggregate.daysToNextMilestoneMedian}
          nextMilestoneLabel={aggregate.nextMilestoneLabel}
          aiMode="auto"  /* ai_mode is per-property; cockpit-data doesn't return it. Default 'auto' is correct for the vast majority case. */
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
          hotelName={sp.name}
        />
        <InventoryRecentAnomaliesTable mode="single" rows={recentAnomalies} />
        <InventoryAdoptionPanel mode="single" rows={topCounters} />
      </>
    );
  }

  // Network/fleet mode
  return (
    <>
      <InventoryTimeline
        mode="fleet"
        fleetMedianDay={aggregate.fleetMedianDay}
        hotelCount={aggregate.hotelCount}
        itemsLearningTotal={aggregate.totalItemsLearning}
        itemsGraduatedTotal={aggregate.totalItemsGraduated}
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
        hotelCount={aggregate.hotelCount}
        healthCounts={aggregate.healthCounts}
      />
      <InventoryRecentAnomaliesTable mode="fleet" rows={recentAnomalies} />
      <InventoryAdoptionPanel mode="fleet" rows={topCounters} />
    </>
  );
}
