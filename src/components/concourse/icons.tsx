'use client';

// Concourse shell icon set — 24×24 stroke paths lifted verbatim from the
// design reference (Lucide-style, 1.8 stroke, round caps/joins). Kept as raw
// paths rather than lucide-react imports so the housekeeping broom (custom,
// not in Lucide) and the rest render pixel-identically to the handoff.

import React from 'react';
import type { AppSection } from '@/lib/sections/registry';

export const CX_ICON_PATHS: Record<string, string> = {
  staxis: 'M12 3l1.9 5.7 5.8 1.9-5.8 1.9L12 18.2l-1.9-5.7-5.8-1.9 5.8-1.9L12 3z',
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 12h7v8h-7zM4 15h7v5H4z',
  housekeeping: 'M3 7v11M3 14h18v4M3 11h11a4 4 0 0 1 4 4M7.5 9.5a1.5 1.5 0 1 0-.01 0',
  communications: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  maintenance: 'M21 6.8a5 5 0 0 1-6.6 6.6L8 19.8a2.1 2.1 0 0 1-3-3l6.4-6.4A5 5 0 0 1 18 3.9l-3 3 2.1 2.1 3-3z',
  inventory: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v9',
  staff: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM22 21v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8',
  financials: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1',
  mic: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM19 10v1a7 7 0 0 1-14 0v-1M12 18v4',
  back: 'M19 12H5M12 19l-7-7 7-7',
  // Admin isn't in the handoff (it has no tile/pill there) — shield keeps it
  // visually consistent with the set.
  admin: 'M12 3l7 3v5c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V6l7-3z',
};

export function CxIcon({ name, size = 16 }: { name: AppSection | keyof typeof CX_ICON_PATHS; size?: number }) {
  const d = CX_ICON_PATHS[name as string];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The Staxis chevron logomark — same path as Header's ChevronMark. */
export function CxLogo({ size = 21, color = '#1A1F1B' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M18 28 L26 20 M18 38 L38 18 M28 38 L38 28 M28 48 L46 30"
        stroke={color}
        strokeWidth={4.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
