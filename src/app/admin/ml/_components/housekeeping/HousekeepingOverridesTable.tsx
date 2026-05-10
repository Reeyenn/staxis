'use client';

import React from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { HKOverrideRow } from '@/app/api/admin/ml/housekeeping/cockpit-data/route';

interface Props {
  mode: 'single' | 'fleet';
  rows: HKOverrideRow[];
}

/**
 * Recent overrides — when Maria manually changed the optimizer's
 * recommended headcount. Each override is a training signal: the gap
 * between recommendation and actual choice tells the model where it's
 * miscalibrated. Fleet mode adds a "Hotel" column.
 */
export function HousekeepingOverridesTable({ mode, rows }: Props) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {mode === 'single' ? 'Recent overrides' : 'Recent overrides — network'}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Days when the manager changed the optimizer’s recommended headcount.
        </p>
      </div>

      {rows.length === 0 ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
          background: '#f7fafb', borderRadius: '8px',
        }}>
          No overrides yet. (Empty until the optimizer activates and starts making recommendations.)
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <Th>Date</Th>
                {mode === 'fleet' && <Th>Hotel</Th>}
                <Th align="right">AI recommended</Th>
                <Th align="right">Manager picked</Th>
                <Th align="right">Delta</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const delta = r.manualHeadcount - r.optimizerRecommendation;
                const deltaColor = delta > 0 ? '#00a050' : delta < 0 ? '#dc3545' : '#7a8a9e';
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
                    <Td>{new Date(r.date).toLocaleDateString()}</Td>
                    {mode === 'fleet' && <Td>{r.propertyName}</Td>}
                    <Td align="right">{r.optimizerRecommendation}</Td>
                    <Td align="right">{r.manualHeadcount}</Td>
                    <Td align="right">
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        color: deltaColor, fontWeight: 600,
                      }}>
                        {delta > 0 && <ArrowUpRight size={12} />}
                        {delta < 0 && <ArrowDownRight size={12} />}
                        {delta > 0 ? `+${delta}` : delta}
                      </span>
                    </Td>
                    <Td>{r.overrideReason ?? <span style={{ color: '#cdd5dd' }}>—</span>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '8px 12px',
      textAlign: align ?? 'left',
      color: '#7a8a9e',
      fontWeight: 500,
      fontSize: '11px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>{children}</th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '8px 12px', textAlign: align ?? 'left', color: '#1b1c19' }}>{children}</td>;
}
