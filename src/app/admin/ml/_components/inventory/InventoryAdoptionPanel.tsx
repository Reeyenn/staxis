'use client';

import React from 'react';
import type { CockpitAdoptionRow } from '@/app/api/admin/ml/inventory/cockpit-data/route';

interface Props {
  mode: 'single' | 'fleet';
  rows: CockpitAdoptionRow[];
}

/**
 * Counts per staff (last 30 days). Fleet mode adds a "Hotel" column so
 * Reeyen can see who's counting where across the network.
 */
export function InventoryAdoptionPanel({ mode, rows }: Props) {
  const totalCounts = rows.reduce((s, r) => s + r.countCount, 0);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {mode === 'single'
            ? 'Who’s counting (last 30 days)'
            : 'Top counters across the network (last 30 days)'}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {totalCounts.toLocaleString()} count events across {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </p>
      </div>

      {rows.length === 0 ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
          background: '#f7fafb', borderRadius: '8px',
        }}>
          No counts in the last 30 days.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
              <Th>Counted by</Th>
              {mode === 'fleet' && <Th>Hotel</Th>}
              <Th align="right">Count events</Th>
              <Th align="right">Items touched</Th>
              <Th>Last counted</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.propertyId}|${r.countedBy}`} style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
                <Td>{r.countedBy}</Td>
                {mode === 'fleet' && <Td>{r.propertyName}</Td>}
                <Td align="right">{r.countCount}</Td>
                <Td align="right">{r.itemsTouched}</Td>
                <Td>{r.lastCountedAt ? new Date(r.lastCountedAt).toLocaleString() : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
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
