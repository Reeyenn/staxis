'use client';

export const dynamic = 'force-dynamic';

import React from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AiReportShell } from './_components/AiReportShell';

// The Inventory AI "report card" screen. The inventory tab itself is 100%
// manual — no ML numbers. The AI keeps predicting silently in the background;
// this screen is where those predictions are surfaced honestly (what it's
// learned, how accurate it's been, how close each item is to graduating).
//
// Reachable by any signed-in user with inventory access — no extra capability
// gate (matches the /api/inventory/ai-status + ai-report auth model).
export default function InventoryAiPage() {
  return (
    <AppLayout>
      <AiReportShell />
    </AppLayout>
  );
}
