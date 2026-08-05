'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { AppLayout } from '@/components/layout/AppLayout';

// These destinations intentionally own their own full-screen entry/redirect
// state and did not render AppLayout before route grouping.
const SHELL_FREE_HOTEL_DESTINATIONS = new Set(['/property-selector', '/inventory/ai']);

export default function HotelRouteLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (SHELL_FREE_HOTEL_DESTINATIONS.has(pathname)) return children;
  return <AppLayout>{children}</AppLayout>;
}
