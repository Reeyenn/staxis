'use client';


export const dynamic = 'force-dynamic';
import React, { Suspense } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useProperty } from '@/contexts/PropertyContext';
import { InventoryShell } from './_components/InventoryShell';

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
  const { activePropertyId, loading } = useProperty();
  if (loading || !activePropertyId) return <InventoryLoading />;
  // A key makes every hotel switch a clean inventory session: no prior rows,
  // overlays, timers, or drafts can survive into the newly selected hotel.
  return <InventoryShell key={activePropertyId} />;
}

function InventoryLoading() {
  return (
    <div style={{ padding: '64px 24px', textAlign: 'center', color: '#5C625C' }}>
      Loading inventory…
    </div>
  );
}
