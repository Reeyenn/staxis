'use client';

// Frosted-glass card shell shared by every additive dashboard card
// (Worklist, Log Book, Calendar, MemoryRecap, WhatStaxisKnows). Exact
// shipped surface: rgba-white glass + 20px blur + hairline white border.
// Radius / padding / maxWidth vary only on the compact "What Staxis knows"
// box.

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
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: radius,
        padding,
        ...(maxWidth !== undefined ? { maxWidth } : {}),
      }}
    >
      {children}
    </div>
  );
}
