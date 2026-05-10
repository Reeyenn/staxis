'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { CockpitAnomalyRow } from '@/app/api/admin/ml/inventory/cockpit-data/route';

interface Props {
  mode: 'single' | 'fleet';
  rows: CockpitAnomalyRow[];
}

/**
 * Recent inventory anomalies. Fleet mode shows a "Hotel" column so the
 * user can see which property each anomaly belongs to.
 */
export function InventoryRecentAnomaliesTable({ mode, rows }: Props) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {mode === 'single' ? 'Recent anomalies' : 'Recent anomalies — network'}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Items where observed usage diverged from prediction by more than 50%.
        </p>
      </div>

      {rows.length === 0 ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
          background: '#f7fafb', borderRadius: '8px',
        }}>
          No anomalies fired. (None to flag yet — anomaly checks need a count after a prediction has been generated for the same item.)
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <Th>Severity</Th>
                <Th>Item</Th>
                {mode === 'fleet' && <Th>Hotel</Th>}
                <Th>Reason</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const color = r.severity === 'critical' ? '#dc3545' : r.severity === 'warn' ? '#f0ad4e' : '#0066cc';
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
                    <Td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        color, fontWeight: 600,
                      }}>
                        <AlertTriangle size={12} />
                        {r.severity.toUpperCase()}
                      </span>
                    </Td>
                    <Td>{r.itemName}</Td>
                    {mode === 'fleet' && <Td>{r.propertyName}</Td>}
                    <Td>{r.reason}</Td>
                    <Td>{new Date(r.ts).toLocaleString()}</Td>
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      padding: '8px 12px',
      textAlign: 'left',
      color: '#7a8a9e',
      fontWeight: 500,
      fontSize: '11px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>{children}</th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: '8px 12px', color: '#1b1c19' }}>{children}</td>;
}
