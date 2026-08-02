'use client';

// Card shell shared by every additive dashboard card (Log Book, Calendar,
// MemoryRecap). Concourse surface: white card, hairline ink border, soft drop
// shadow. Radius / padding / maxWidth are available for compact variants.

import React from 'react';

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
  return (
    <div
      style={{
        background: '#FFFFFF',
        border: '1px solid rgba(31,35,28,0.08)',
        borderRadius: radius,
        boxShadow: '0 6px 16px -14px rgba(31,42,32,0.35)',
        padding,
        ...(maxWidth !== undefined ? { maxWidth } : {}),
      }}
    >
      {children}
    </div>
  );
}
