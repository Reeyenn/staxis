'use client';

/**
 * Money tab — placeholder for Phase 1.
 *
 * Phase 8 fills this with: revenue panel (lights up when billing flips
 * on), expenses panel with manual input + auto-pulled Claude API spend,
 * and per-hotel revenue vs cost cards.
 */

import React from 'react';
import { ExternalLink } from 'lucide-react';

export function MoneyTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        padding: '14px 16px',
        background: 'rgba(212,144,64,0.08)',
        border: '1px solid rgba(212,144,64,0.2)',
        borderRadius: '10px',
      }}>
        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>
          Pilot mode
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          All hotels are free. Billing flips on when you're ready. Until then this
          tab is a pass-through to Stripe and the Claude console.
        </p>
      </div>

      <a
        href="https://console.anthropic.com/cost"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px',
          background: 'var(--surface-primary)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          textDecoration: 'none',
          color: 'inherit',
          fontSize: '13px',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, marginBottom: '2px' }}>Claude API spend</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            console.anthropic.com/cost — actual numbers, never estimated
          </div>
        </div>
        <ExternalLink size={14} color="var(--text-muted)" />
      </a>

      <a
        href="https://dashboard.stripe.com/dashboard"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px',
          background: 'var(--surface-primary)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          textDecoration: 'none',
          color: 'inherit',
          fontSize: '13px',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, marginBottom: '2px' }}>Stripe dashboard</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Subscriptions, invoices, payouts — until billing flips on
          </div>
        </div>
        <ExternalLink size={14} color="var(--text-muted)" />
      </a>

      <div style={{
        padding: '20px',
        background: 'var(--surface-secondary)',
        border: '1px dashed var(--border)',
        borderRadius: '10px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
          Money widgets coming in Phase 8
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: '480px', margin: '0 auto' }}>
          Revenue list, expenses with manual input, Claude API spend with token-level
          instrumentation, and per-hotel revenue vs cost cards.
        </p>
      </div>
    </div>
  );
}
