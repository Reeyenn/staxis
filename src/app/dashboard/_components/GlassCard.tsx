'use client';

// Card shell shared by every additive dashboard card (Worklist, Log Book,
// Calendar, MemoryRecap, WhatStaxisKnows). Concourse surface: white card,
// hairline ink border, soft drop shadow. Radius / padding / maxWidth vary
// only on the compact "What Staxis knows" box.

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
