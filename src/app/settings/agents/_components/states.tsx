'use client';

// Snow-styled loading / empty / error blocks reused across the Agents screens.

import React from 'react';
import { T, fonts, Caps, Btn } from './_tokens';
import { s, type Lang } from '../_lib/strings';

export function Loading({ lang }: { lang: Lang }) {
  return (
    <div style={{ padding: '18px 4px' }}>
      <Caps>{s(lang, 'loading')}</Caps>
    </div>
  );
}

export function ErrorBanner({ message, onRetry, lang }: { message: string; onRetry?: () => void; lang: Lang }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '10px 14px', background: T.redDim, border: `1px solid ${T.red}40`,
        borderRadius: 12, color: T.red, fontFamily: fonts.sans, fontSize: 13,
      }}
    >
      <span>{message}</span>
      {onRetry && (
        <Btn variant="ghost" size="sm" onClick={onRetry}>
          {s(lang, 'retry')}
        </Btn>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div style={{
      textAlign: 'center', padding: '40px 24px',
      border: `1px dashed ${T.rule}`, borderRadius: 18, background: T.paper,
    }}>
      <div style={{ fontFamily: fonts.serif, fontSize: 22, color: T.ink, fontStyle: 'italic', lineHeight: 1.15 }}>
        {title}
      </div>
      {body && (
        <p style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, maxWidth: 460, margin: '8px auto 0', lineHeight: 1.5 }}>
          {body}
        </p>
      )}
      {action && <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>{action}</div>}
    </div>
  );
}
