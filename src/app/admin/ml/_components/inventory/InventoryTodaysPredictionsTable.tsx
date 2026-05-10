'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryTodaysPredictions } from '@/lib/db';
import type { InventoryTodayPrediction } from '@/lib/db/ml-inventory-cockpit';
import { AlertTriangle } from 'lucide-react';

export function InventoryTodaysPredictionsTable() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [rows, setRows] = useState<InventoryTodayPrediction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        const data = await getInventoryTodaysPredictions(activePropertyId, 100);
        setRows(data);
      } catch (err) {
        console.error('InventoryTodaysPredictionsTable: fetch error', err);
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
          Today&rsquo;s predictions
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Sorted most-urgent first (lowest days-until-out).
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{
          padding: '24px', textAlign: 'center', color: '#7a8a9e', fontSize: '13px',
          background: '#f7fafb', borderRadius: '8px',
        }}>
          No predictions yet. The nightly inference cron will populate this once models are trained.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <Th>Item</Th>
                <Th align="right">Predicted rate / day</Th>
                <Th align="right">Predicted current</Th>
                <Th align="right">Reported current</Th>
                <Th align="right">Variance</Th>
                <Th align="right">Days until out</Th>
                <Th>Algorithm</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r) => (
                <tr key={r.itemId} style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
                  <Td>{r.itemName}</Td>
                  <Td align="right">{r.predictedDailyRate.toFixed(2)}</Td>
                  <Td align="right">{r.predictedCurrentStock !== null ? r.predictedCurrentStock.toFixed(1) : '—'}</Td>
                  <Td align="right">{r.currentStockReported !== null ? r.currentStockReported.toFixed(0) : '—'}</Td>
                  <Td align="right">
                    {r.varianceFromReported !== null ? (
                      <span style={{
                        color: Math.abs(r.varianceFromReported) > 5 ? '#dc3545' : '#1b1c19',
                        fontWeight: Math.abs(r.varianceFromReported) > 5 ? 600 : 400,
                      }}>
                        {r.varianceFromReported > 0 ? '+' : ''}{r.varianceFromReported.toFixed(1)}
                      </span>
                    ) : '—'}
                  </Td>
                  <Td align="right">
                    {r.daysUntilOutEstimate !== null ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        color: r.daysUntilOutEstimate < 3 ? '#dc3545' :
                               r.daysUntilOutEstimate < 7 ? '#f0ad4e' : '#1b1c19',
                        fontWeight: r.daysUntilOutEstimate < 3 ? 600 : 400,
                      }}>
                        {r.daysUntilOutEstimate < 3 && <AlertTriangle size={11} />}
                        {r.daysUntilOutEstimate.toFixed(1)}
                      </span>
                    ) : '—'}
                  </Td>
                  <Td>{r.modelAlgorithm ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 && (
            <div style={{ textAlign: 'center', color: '#7a8a9e', fontSize: '11px', marginTop: '8px' }}>
              Showing 50 of {rows.length} items
            </div>
          )}
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
  return (
    <td style={{ padding: '8px 12px', textAlign: align ?? 'left', color: '#1b1c19' }}>{children}</td>
  );
}
