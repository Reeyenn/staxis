'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getDemandPredictionForDate } from '@/lib/db';
import type { DemandPrediction } from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';

export function TodaysPredictionsTable() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const today = useTodayStr();

  const [prediction, setPrediction] = useState<DemandPrediction | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        // Get tomorrow's prediction (since the page runs overnight)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const pred = await getDemandPredictionForDate(activePropertyId, tomorrowStr);
        setPrediction(pred);
      } catch (err) {
        console.error('TodaysPredictionsTable: fetch error', err);
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
          Tomorrow's Demand Prediction
        </h2>
        <p style={{ fontSize: '13px', color: '#7a8a9e', margin: 0 }}>
          Layer 1 workload distribution
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : !prediction ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>No prediction available yet</div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: '12px',
        }}>
          {[
            { label: 'P10', value: prediction.predictedMinutesP25 },
            { label: 'P25', value: prediction.predictedMinutesP25 },
            { label: 'P50', value: prediction.predictedMinutesP50 },
            { label: 'P75', value: prediction.predictedMinutesP75 },
            { label: 'P90', value: prediction.predictedMinutesP90 },
          ].map((quantile, i) => (
            <div key={i} style={{
              background: 'rgba(0,101,101,0.04)',
              border: '1px solid rgba(0,101,101,0.1)',
              borderRadius: '8px',
              padding: '16px',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '12px', color: '#7a8a9e', marginBottom: '8px' }}>
                {quantile.label}
              </div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#004b4b' }}>
                {quantile.value ? Math.round(quantile.value) : '—'}
              </div>
              <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '4px' }}>
                minutes
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
