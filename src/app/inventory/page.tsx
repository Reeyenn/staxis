'use client';

import React, { Suspense } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { InventoryShell } from './_components/InventoryShell';

// Snow-styled single-page Inventory built off the Claude Design handoff
// (bundle: ZHhP2JnQX5_pYa-JNTy6Nw, May 2026). Replaces the legacy 4,589-line
// monolith. All ML/AI machinery (predictions, auto-fill, anomaly detection,
// SMS alerts, invoice OCR) is preserved — the rebuild only swaps the UI.

export default function InventoryPage() {
  return (
    <AppLayout>
      <Suspense fallback={null}>
        <InventoryShell />
      </Suspense>
    </AppLayout>
  );
}
