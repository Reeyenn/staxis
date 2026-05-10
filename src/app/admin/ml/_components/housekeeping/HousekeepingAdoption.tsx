'use client';

import React from 'react';
import type { HKAdoptionRow } from '@/app/api/admin/ml/housekeeping/cockpit-data/route';

interface Props {
  mode: 'single' | 'fleet';
  rows: HKAdoptionRow[];
}

/**
 * Per-housekeeper adoption — fraction of assigned rooms that got a Done-tap
 * over the last 30 days. Fleet mode adds a Hotel column so Reeyen can see
 * who's tapping where across the network.
 */
export function HousekeepingAdoption({ mode, rows }: Props) {
  const totalRoomsTouched = rows.reduce((s, r) => s + r.roomsWithEvent, 0);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {mode === 'single' ? 'Who’s working (last 30 days)' : 'Top housekeepers — network (last 30 days)'}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {totalRoomsTouched.toLocaleString()} rooms cleaned across {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </p>
      </div>

      {rows.length === 0 ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
          background: '#f7fafb', borderRadius: '8px',
        }}>
          No housekeeper activity in the last 30 days.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
              <Th>Staff</Th>
              {mode === 'fleet' && <Th>Hotel</Th>}
              <Th align="right">Rooms cleaned</Th>
              <Th align="right">Rooms assigned</Th>
              <Th align="right">Adoption</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.propertyId}|${r.staffId}`} style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
                <Td>{r.staffName}</Td>
                {mode === 'fleet' && <Td>{r.propertyName}</Td>}
                <Td align="right">{r.roomsWithEvent}</Td>
                <Td align="right">{r.roomsAssigned > 0 ? r.roomsAssigned : '—'}</Td>
                <Td align="right">
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    color: r.adoptionPct >= 80 ? '#00a050' : r.adoptionPct >= 50 ? '#f0ad4e' : '#dc3545',
                    fontWeight: 600,
                  }}>
                    {r.adoptionPct}%
                    <div style={{ width: '40px', height: '4px', background: '#eef1f4', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(100, r.adoptionPct)}%`,
                        height: '100%',
                        background: r.adoptionPct >= 80 ? '#00a050' : r.adoptionPct >= 50 ? '#f0ad4e' : '#dc3545',
                      }} />
                    </div>
                  </span>
                </Td>
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
