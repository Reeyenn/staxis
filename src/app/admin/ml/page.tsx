'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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

/**
 * /admin/ml — Owner-only ML cockpit
 *
 * This page is gated to the property owner only (Reeyen for Comfort Suites
 * Beaumont). Non-owners see a "Page not found" stub — we don't render any
 * content or redirect, so they don't even know the page exists.
 *
 * RLS policies on all ML tables further protect data: even if a non-owner
 * somehow loaded this page, Supabase RLS would deny all queries.
 */

export default function MLPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [ownerCheckError, setOwnerCheckError] = useState<string | null>(null);

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

        // Fetch the raw property row from Supabase to get owner_id (not in the
        // mapped Property type). We read with the authenticated user's JWT — RLS
        // will only return this row if they're the owner.
        const { data, error } = await (
          require('@/lib/supabase').supabase
            .from('properties')
            .select('owner_id')
            .eq('id', activePropertyId)
            .maybeSingle()
        );

        if (error || !data) {
          // Either an RLS denial (they're not the owner) or the property
          // doesn't exist. Either way, deny access.
          setIsOwner(false);
          return;
        }

        const ownerId = String(data.owner_id);
        const userMatches = ownerId === user.uid;
        setIsOwner(userMatches);
      } catch (err) {
        console.error('MLPage owner check failed:', err);
        setOwnerCheckError('Failed to verify access');
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

  // ── Owner view: render the ML cockpit ──
  return (
    <AppLayout>
      <div style={{ padding: '32px', maxWidth: '1920px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
            ML Cockpit — {activeProperty?.name ?? 'Loading...'}
          </h1>
          <p style={{ fontSize: '14px', color: '#7a8a9e', marginTop: '4px' }}>
            Monitor model health, predictions, and system state.
          </p>
        </div>

        {/* Main grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
          {/* Data Fuel Gauge */}
          <div style={{ gridColumn: '1 / -1' }}>
            <DataFuelGauge />
          </div>

          {/* Layer Status: Demand */}
          <LayerStatusPanel layer="demand" />
          {/* Layer Status: Supply */}
          <LayerStatusPanel layer="supply" />

          {/* Layer Status: Optimizer */}
          <div style={{ gridColumn: '1 / -1' }}>
            <LayerStatusPanel layer="optimizer" />
          </div>

          {/* Shadow MAE Chart */}
          <div style={{ gridColumn: '1 / -1' }}>
            <ShadowMAEChart />
          </div>

          {/* Adoption per HK */}
          <div style={{ gridColumn: '1 / -1' }}>
            <AdoptionPerHK />
          </div>

          {/* Today's Predictions */}
          <div style={{ gridColumn: '1 / -1' }}>
            <TodaysPredictionsTable />
          </div>

          {/* Pipeline Health */}
          <div style={{ gridColumn: '1 / 2' }}>
            <PipelineHealth />
          </div>

          {/* Manual Triggers */}
          <div style={{ gridColumn: '2 / 3' }}>
            <ManualTriggers />
          </div>

          {/* Recent Overrides */}
          <div style={{ gridColumn: '1 / -1' }}>
            <RecentOverridesTable />
          </div>

          {/* Disagreement History */}
          <div style={{ gridColumn: '1 / -1' }}>
            <DisagreementHistory />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
