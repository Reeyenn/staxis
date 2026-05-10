'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryAdoption } from '@/lib/db';
import type { InventoryAdoptionRow } from '@/lib/db/ml-inventory-cockpit';

/**
 * Counts per staff member over the last 30 days. Tells Reeyen "are people
 * actually using this?" without a bunch of derived metrics.
 */
export function InventoryAdoptionPanel() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [rows, setRows] = useState<InventoryAdoptionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        setRows(await getInventoryAdoption(activePropertyId, 30));
      } catch (err) {
        console.error('InventoryAdoptionPanel: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

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
          Who&rsquo;s counting (last 30 days)
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {totalCounts.toLocaleString()} total count events across {rows.length} staff
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : rows.length === 0 ? (
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
              <Th align="right">Count events</Th>
              <Th align="right">Items touched</Th>
              <Th>Last counted</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.countedBy} style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
                <Td>{r.countedBy}</Td>
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
