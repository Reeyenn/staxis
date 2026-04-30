'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getAdoptionPerHK } from '@/lib/db';
import { ArrowUpDown } from 'lucide-react';

interface HKAdoption {
  staffId: string;
  staffName: string;
  roomsAssigned: number;
  roomsWithEvent: number;
  adoptionPct: number;
}

type SortKey = 'adoption' | 'name' | 'assigned';

export function AdoptionPerHK() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [data, setData] = useState<HKAdoption[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('adoption');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const result = await getAdoptionPerHK(activePropertyId, 7);
        setData(result);
      } catch (err) {
        console.error('AdoptionPerHK: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const sorted = [...data].sort((a, b) => {
    if (sortKey === 'adoption') return b.adoptionPct - a.adoptionPct;
    if (sortKey === 'name') return a.staffName.localeCompare(b.staffName);
    if (sortKey === 'assigned') return b.roomsAssigned - a.roomsAssigned;
    return 0;
  });

  const getAdoptionColor = (pct: number): string => {
    if (pct >= 80) return '#00a050'; // green
    if (pct >= 40) return '#f0ad4e'; // amber
    return '#dc3545'; // red
  };

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Adoption per Housekeeper (Last 7d)
        </h2>
        <p style={{ fontSize: '13px', color: '#7a8a9e', margin: '4px 0 0 0' }}>
          Cleaning events recorded vs assignments
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : data.length === 0 ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>No data available</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '13px',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <th style={{
                  textAlign: 'left',
                  padding: '8px',
                  fontWeight: 600,
                  color: '#454652',
                  cursor: 'pointer',
                }} onClick={() => setSortKey('name')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    Staff Name {sortKey === 'name' && <ArrowUpDown size={12} />}
                  </div>
                </th>
                <th style={{
                  textAlign: 'right',
                  padding: '8px',
                  fontWeight: 600,
                  color: '#454652',
                  cursor: 'pointer',
                }} onClick={() => setSortKey('assigned')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'flex-end' }}>
                    Assigned {sortKey === 'assigned' && <ArrowUpDown size={12} />}
                  </div>
                </th>
                <th style={{
                  textAlign: 'right',
                  padding: '8px',
                  fontWeight: 600,
                  color: '#454652',
                }}>
                  Recorded
                </th>
                <th style={{
                  textAlign: 'center',
                  padding: '8px',
                  fontWeight: 600,
                  color: '#454652',
                  cursor: 'pointer',
                }} onClick={() => setSortKey('adoption')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                    Adoption % {sortKey === 'adoption' && <ArrowUpDown size={12} />}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(hk => (
                <tr key={hk.staffId} style={{
                  borderBottom: '1px solid rgba(78,90,122,0.06)',
                  background: hk.adoptionPct < 40 ? 'rgba(220,52,69,0.04)' : hk.adoptionPct < 80 ? 'rgba(240,173,78,0.04)' : 'transparent',
                }}>
                  <td style={{ padding: '10px 8px', color: '#1b1c19' }}>
                    {hk.staffName || '(unknown)'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#454652' }}>
                    {hk.roomsAssigned}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#454652' }}>
                    {hk.roomsWithEvent}
                  </td>
                  <td style={{
                    padding: '10px 8px',
                    textAlign: 'center',
                    color: getAdoptionColor(hk.adoptionPct),
                    fontWeight: 600,
                  }}>
                    {hk.adoptionPct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
