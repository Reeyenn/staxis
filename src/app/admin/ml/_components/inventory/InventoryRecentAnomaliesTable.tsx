'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryAnomalies } from '@/lib/db';
import type { InventoryAnomalyRow } from '@/lib/db/ml-inventory-cockpit';
import { AlertTriangle } from 'lucide-react';

export function InventoryRecentAnomaliesTable() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [rows, setRows] = useState<InventoryAnomalyRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        setRows(await getInventoryAnomalies(activePropertyId, 30));
      } catch (err) {
        console.error('InventoryRecentAnomaliesTable: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Recent anomalies
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Items where observed usage diverged from prediction by more than 50%.
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
          background: '#f7fafb', borderRadius: '8px',
        }}>
          No anomalies fired. (Anomaly detection arrives in session 2 — until then this stays empty.)
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <Th>Severity</Th>
                <Th>Item</Th>
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
