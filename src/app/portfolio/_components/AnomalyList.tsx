'use client';

/**
 * Anomaly list. Plain-English bullet points explaining each deviation,
 * keyed by (propertyId, metric). Empty list collapses the whole
 * section so the page stays clean when there's nothing to investigate.
 */

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { AlertTriangle, AlertOctagon } from 'lucide-react';
import type { PortfolioAnomaly } from '@/lib/portfolio/types';

const sansFont = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  anomalies: PortfolioAnomaly[];
}

export function AnomalyList({ anomalies }: Props) {
  const { lang } = useLang();
  const { switchToProperty } = usePortfolio();
  const ink   = 'var(--snow-ink)';
  const ink2  = 'var(--snow-ink2)';
  const rule  = 'var(--snow-rule)';
  const warm  = 'var(--snow-warm)';

  if (anomalies.length === 0) return null;

  const titleEn = anomalies.length === 1 ? 'Needs attention' : 'Needs attention';
  const titleEs = 'Necesita atención';

  return (
    <div style={{
      margin: '24px clamp(16px, 3vw, 48px)',
      border: `1px solid ${rule}`, borderRadius: '14px',
      background: 'var(--snow-bg)',
      padding: '18px 20px',
      fontFamily: sansFont,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <AlertTriangle size={14} color={warm} />
        <h2 style={{
          fontSize: '13px', fontWeight: 600, color: ink,
          textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0,
        }}>
          {lang === 'es' ? titleEs : titleEn}
        </h2>
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: ink2 }}>
          {anomalies.length} {lang === 'es' ? 'elemento(s)' : 'item(s)'}
        </span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {anomalies.map((a, i) => (
          <li key={`${a.propertyId}-${a.metric}-${i}`}>
            <button
              type="button"
              onClick={() => switchToProperty(a.propertyId, '/housekeeping')}
              style={{
                width: '100%', textAlign: 'left',
                display: 'flex', alignItems: 'flex-start', gap: '10px',
                padding: '10px 12px', borderRadius: '10px',
                background: a.severity === 'red' ? 'rgba(217, 119, 6, 0.08)' : 'rgba(217, 119, 6, 0.04)',
                border: '1px solid ' + (a.severity === 'red' ? 'rgba(217, 119, 6, 0.30)' : 'rgba(217, 119, 6, 0.15)'),
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {a.severity === 'red'
                ? <AlertOctagon size={14} color={warm} style={{ marginTop: '2px', flexShrink: 0 }} />
                : <AlertTriangle size={14} color={warm} style={{ marginTop: '2px', flexShrink: 0 }} />
              }
              <span style={{ fontSize: '13px', color: ink, lineHeight: 1.45 }}>
                {a.explanation}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
