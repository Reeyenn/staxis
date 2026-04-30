'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getRecentDisagreements } from '@/lib/db';
import type { PredictionDisagreement } from '@/lib/db';
import { AlertTriangle } from 'lucide-react';

export function DisagreementHistory() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [disagreements, setDisagreements] = useState<PredictionDisagreement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const result = await getRecentDisagreements(activePropertyId, 20);
        setDisagreements(result);
      } catch (err) {
        console.error('DisagreementHistory: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const getSeverityColor = (pct: number): string => {
    if (pct > 50) return '#dc3545'; // high
    if (pct > 20) return '#f0ad4e'; // medium
    return '#7a8a9e'; // low
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
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0, marginBottom: '4px' }}>
          L1↔L2 Disagreement Detection
        </h2>
        <p style={{ fontSize: '13px', color: '#7a8a9e', margin: 0 }}>
          When Layer 1 total drifts from Layer 2 sum
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : disagreements.length === 0 ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>No disagreements detected</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '12px',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600, color: '#454652' }}>Date</th>
                <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600, color: '#454652' }}>
                  L1 Total P50
                </th>
                <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600, color: '#454652' }}>
                  L2 Sum P50
                </th>
                <th style={{ textAlign: 'center', padding: '8px', fontWeight: 600, color: '#454652' }}>
                  Disagreement %
                </th>
                <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600, color: '#454652' }}>Severity</th>
              </tr>
            </thead>
            <tbody>
              {disagreements.map(d => {
                const severityColor = getSeverityColor(d.disagreementPct);
                let severityLabel = 'Low';
                if (d.disagreementPct > 50) severityLabel = 'High';
                else if (d.disagreementPct > 20) severityLabel = 'Medium';

                return (
                  <tr key={d.id} style={{
                    borderBottom: '1px solid rgba(78,90,122,0.06)',
                    background: d.disagreementPct > 50 ? 'rgba(220,52,69,0.04)' : d.disagreementPct > 20 ? 'rgba(240,173,78,0.04)' : 'transparent',
                  }}>
                    <td style={{ padding: '10px 8px', color: '#1b1c19' }}>
                      {d.date}
                    </td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#454652' }}>
                      {Math.round(d.layer1TotalP50)}
                    </td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#454652' }}>
                      {Math.round(d.layer2SummedP50)}
                    </td>
                    <td style={{
                      padding: '10px 8px',
                      textAlign: 'center',
                      color: severityColor,
                      fontWeight: 600,
                    }}>
                      {d.disagreementPct.toFixed(1)}%
                    </td>
                    <td style={{
                      padding: '10px 8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      color: severityColor,
                    }}>
                      {d.disagreementPct > 20 && <AlertTriangle size={12} />}
                      <span>{severityLabel}</span>
                    </td>
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
