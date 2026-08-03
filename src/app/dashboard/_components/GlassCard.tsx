'use client';

// Card shell shared by every additive dashboard card (Log Book, Calendar,
// MemoryRecap). Concourse surface: white card, hairline ink border, soft drop
// shadow. Radius / padding / maxWidth are available for compact variants.

import React from 'react';
import { SurfaceCard } from '@/app/_components/ui/SurfaceCard';
import { CONCOURSE_COLORS, UI_SHADOWS } from '@/app/_components/ui/tokens';

export function GlassCard({
  radius = 16,
  padding = '18px 20px',
  maxWidth,
  children,
}: {
  radius?: number;
  padding?: string;
  maxWidth?: number;
  children: React.ReactNode;
}) {
  return <SurfaceCard
    surface={CONCOURSE_COLORS.paper}
    border={`1px solid ${CONCOURSE_COLORS.rule}`}
    radius={radius}
    shadow={UI_SHADOWS.card}
    padding={padding}
    maxWidth={maxWidth}
  >{children}</SurfaceCard>;
}
