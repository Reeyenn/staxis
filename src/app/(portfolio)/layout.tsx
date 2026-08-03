'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { AppLayout } from '@/components/layout/AppLayout';

// The chooser is intentionally a focused full-page decision surface. The
// portfolio home and section routes retain their existing AppLayout shell.
export default function PortfolioRouteLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/portfolio/choose') return children;
  return <AppLayout hideGlobalAsk>{children}</AppLayout>;
}
