'use client';

/**
 * Small badge that surfaces the property's current SMS dispatch mode.
 *
 *   dry_run: blue 🧪 badge — "SMS mode: Test (no real texts will go out)"
 *   live:    green 📡 badge — "SMS mode: Live"
 *
 * Clicking the badge is intentionally a no-op in this branch — the
 * Settings → Property modal that flips the mode is its own follow-up.
 * The badge still renders as a button so the affordance is right when
 * that page lands.
 */

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';

export interface SmsDryRunIndicatorProps {
  mode: 'dry_run' | 'live' | null;
  onClick?: () => void;
}

export function SmsDryRunIndicator({ mode, onClick }: SmsDryRunIndicatorProps) {
  const { lang } = useLang();

  // Don't render anything until we know the mode — avoids a flash of
  // "live" when the mode is still loading.
  if (mode == null) return null;

  const isLive = mode === 'live';
  const bg = isLive ? 'rgba(0,101,101,0.10)' : 'rgba(54,66,98,0.10)';
  const fg = isLive ? '#006565' : '#364262';
  const border = isLive ? 'rgba(0,101,101,0.30)' : 'rgba(54,66,98,0.30)';
  const icon = isLive ? 'cell_tower' : 'science';

  let label: string;
  if (lang === 'es') {
    label = isLive
      ? 'SMS: En vivo'
      : 'SMS: Prueba (no se enviarán mensajes reales)';
  } else {
    label = isLive
      ? 'SMS mode: Live'
      : 'SMS mode: Test (no real texts will go out)';
  }

  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '6px 14px', borderRadius: '9999px',
        background: bg, color: fg, border: `1px solid ${border}`,
        fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: '12px',
        cursor: onClick ? 'pointer' : 'default',
        letterSpacing: '0.02em',
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
        {icon}
      </span>
      {label}
    </button>
  );
}
