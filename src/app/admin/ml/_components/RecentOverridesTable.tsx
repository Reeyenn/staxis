'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getRecentOverrides } from '@/lib/db';
import type { PredictionOverride } from '@/lib/db';

export function RecentOverridesTable() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [overrides, setOverrides] = useState<PredictionOverride[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const result = await getRecentOverrides(activePropertyId, 20);
        setOverrides(result);
      } catch (err) {
        console.error('RecentOverridesTable: fetch error', err);
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
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0, marginBottom: '4px' }}>
          Recent Overrides
        </h2>
        <p style={{ fontSize: '13px', color: '#7a8a9e', margin: 0 }}>
          Manual headcount decisions vs optimizer recommendations
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : overrides.length === 0 ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>No overrides yet</div>
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
                <th style={{ textAlign: 'center', padding: '8px', fontWeight: 600, color: '#454652' }}>
                  Optimizer Rec
                </th>
                <th style={{ textAlign: 'center', padding: '8px', fontWeight: 600, color: '#454652' }}>
                  Actual
                </th>
                <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600, color: '#454652' }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {overrides.map(ov => (
                <tr key={ov.id} style={{
                  borderBottom: '1px solid rgba(78,90,122,0.06)',
                  background: ov.manualHeadcount > ov.optimizerRecommendation
                    ? 'rgba(240,173,78,0.04)'
                    : ov.manualHeadcount < ov.optimizerRecommendation
                    ? 'rgba(220,52,69,0.04)'
                    : 'transparent',
                }}>
                  <td style={{ padding: '10px 8px', color: '#1b1c19' }}>
                    {ov.date}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: '#454652', fontWeight: 600 }}>
                    {ov.optimizerRecommendation}
                  </td>
                  <td style={{
                    padding: '10px 8px',
                    textAlign: 'center',
                    color: ov.manualHeadcount > ov.optimizerRecommendation ? '#f0ad4e' : '#dc3545',
                    fontWeight: 600,
                  }}>
                    {ov.manualHeadcount}
                  </td>
                  <td style={{ padding: '10px 8px', color: '#7a8a9e' }}>
                    {ov.overrideReason ?? '—'}
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
