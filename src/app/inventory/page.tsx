'use client';


export const dynamic = 'force-dynamic';
import React, { Suspense } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useProperty } from '@/contexts/PropertyContext';
import { RouteErrorState, RouteLoadingState } from '@/components/layout/RouteResourceState';
import { InventoryShell } from './_components/InventoryShell';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';

// Snow-styled single-page Inventory built off the Claude Design handoff
// (bundle: ZHhP2JnQX5_pYa-JNTy6Nw, May 2026). Replaces the legacy 4,589-line
// monolith. All ML/AI machinery (predictions, auto-fill, anomaly detection,
// SMS alerts, invoice OCR) is preserved — the rebuild only swaps the UI.

export default function InventoryPage() {
  return (
    <AppLayout>
      <Suspense fallback={<InventoryLoading />}>
        <ActivePropertyInventory />
      </Suspense>
    </AppLayout>
  );
}

function ActivePropertyInventory() {
  const { push } = useReliableNavigation();
  const {
    activePropertyId,
    loading,
    capabilityOverridesStatus,
    capabilityOverridesError,
    refreshCapabilities,
  } = useProperty();
  if (loading) return <InventoryLoading />;
  if (!activePropertyId) {
    return (
      <RouteErrorState
        title="No hotel is selected"
        message="Choose a hotel before opening Inventory."
        retryLabel="Choose a hotel"
        onRetry={() => push('/property-selector')}
      />
    );
  }
  if (capabilityOverridesStatus === 'error') {
    return (
      <RouteErrorState
        title="Inventory access could not be confirmed"
        message={capabilityOverridesError ?? undefined}
        onRetry={() => void refreshCapabilities()}
      />
    );
  }
  if (capabilityOverridesStatus !== 'ready') {
    return <RouteLoadingState title="Checking Inventory access…" />;
  }
  // A key makes every hotel switch a clean inventory session: no prior rows,
  // overlays, timers, or drafts can survive into the newly selected hotel.
  return <InventoryShell key={activePropertyId} />;
}

function InventoryLoading() {
  return <RouteLoadingState title="Loading Inventory…" />;
}
