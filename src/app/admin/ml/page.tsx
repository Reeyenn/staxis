'use client';

import React, { Suspense, useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { getProperty } from '@/lib/db';
import { DataFuelGauge } from './_components/DataFuelGauge';
import { AdoptionPerHK } from './_components/AdoptionPerHK';
import { LayerStatusPanel } from './_components/LayerStatusPanel';
import { ShadowMAEChart } from './_components/ShadowMAEChart';
import { TodaysPredictionsTable } from './_components/TodaysPredictionsTable';
import { PipelineHealth } from './_components/PipelineHealth';
import { ManualTriggers } from './_components/ManualTriggers';
import { RecentOverridesTable } from './_components/RecentOverridesTable';
import { DisagreementHistory } from './_components/DisagreementHistory';
import { InventoryDataFuelGauge } from './_components/inventory/InventoryDataFuelGauge';
import { InventoryLayerStatusPanel } from './_components/inventory/InventoryLayerStatusPanel';
import { InventoryShadowMAEChart } from './_components/inventory/InventoryShadowMAEChart';
import { InventoryTodaysPredictionsTable } from './_components/inventory/InventoryTodaysPredictionsTable';
import { InventoryPipelineHealth } from './_components/inventory/InventoryPipelineHealth';
import { InventoryManualTriggers } from './_components/inventory/InventoryManualTriggers';
import { InventoryRecentAnomaliesTable } from './_components/inventory/InventoryRecentAnomaliesTable';
import { InventoryAdoptionPanel } from './_components/inventory/InventoryAdoptionPanel';

/**
 * /admin/ml — Owner-only ML cockpit (split into Housekeeping + Inventory tabs).
 *
 * The page is gated to the property owner only (Reeyen for Comfort Suites
 * Beaumont). Non-owners see a "Page not found" stub — we don't render any
 * content or redirect, so they don't even know the page exists.
 *
 * RLS policies on all ML tables further protect data: even if a non-owner
 * somehow loaded this page, Supabase RLS would deny all queries.
 *
 * Tab selection is URL-driven (`?tab=inventory` or default housekeeping)
 * so direct links (e.g. an alert email) can deep-link into a tab.
 */

type Tab = 'housekeeping' | 'inventory';

/**
 * Outer page component — wraps the inner content in a Suspense boundary so
 * useSearchParams() doesn't bail out of static rendering. Required by
 * Next.js 16; otherwise the build errors with "useSearchParams() should
 * be wrapped in a suspense boundary".
 */
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

  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  // ── Owner gating: check that user.uid matches property.owner_id ──
  useEffect(() => {
    if (authLoading || propLoading || !user || !activePropertyId) {
      return;
    }

    (async () => {
      try {
        const prop = await getProperty(user.uid, activePropertyId);
        if (!prop) {
          setIsOwner(false);
          return;
        }

        const { data, error } = await (
          require('@/lib/supabase').supabase
            .from('properties')
            .select('owner_id')
            .eq('id', activePropertyId)
            .maybeSingle()
        );

        if (error || !data) {
          setIsOwner(false);
          return;
        }

        const ownerId = String(data.owner_id);
        setIsOwner(ownerId === user.uid);
      } catch (err) {
        console.error('MLPage owner check failed:', err);
        setIsOwner(false);
      }
    })();
  }, [user, activePropertyId, authLoading, propLoading]);

  // ── Redirect to signin if not authenticated ──
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/signin');
    }
  }, [user, authLoading, router]);

  // ── Redirect to onboarding if no property selected ──
  useEffect(() => {
    if (!authLoading && !propLoading && user && !activePropertyId) {
      router.replace('/onboarding');
    }
  }, [user, authLoading, propLoading, activePropertyId, router]);

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'housekeeping') params.delete('tab');
    else params.set('tab', next);
    router.replace(`/admin/ml${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  // ── Loading state ──
  if (authLoading || propLoading || isOwner === null) {
    return (
      <AppLayout>
        <div style={{ padding: '32px', textAlign: 'center', color: '#454652' }}>
          Loading...
        </div>
      </AppLayout>
    );
  }

  // ── Non-owner: show "Page not found" stub ──
  if (!isOwner) {
    return (
      <AppLayout>
        <div style={{ padding: '32px', textAlign: 'center', color: '#454652' }}>
          <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
            Page not found
          </div>
          <div style={{ fontSize: '14px', color: '#7a8a9e' }}>
            The page you are looking for does not exist.
          </div>
        </div>
      </AppLayout>
    );
  }

  // ── Owner view: render tabs + cockpit ──
  return (
    <AppLayout>
      <div style={{ padding: '32px', maxWidth: '1920px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '20px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
            ML Cockpit — {activeProperty?.name ?? 'Loading...'}
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

        {/* Housekeeping tab — original 9-panel grid, unchanged */}
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

        {/* Inventory tab — 8 mirroring panels */}
        {tab === 'inventory' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <InventoryDataFuelGauge />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <InventoryLayerStatusPanel />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <InventoryTodaysPredictionsTable />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <InventoryShadowMAEChart />
            </div>
            <div style={{ gridColumn: '1 / 2' }}>
              <InventoryPipelineHealth />
            </div>
            <div style={{ gridColumn: '2 / 3' }}>
              <InventoryManualTriggers />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <InventoryRecentAnomaliesTable />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <InventoryAdoptionPanel />
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
