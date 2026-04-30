'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getRollingShadowMAE } from '@/lib/db';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';

export function ShadowMAEChart() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [demandData, setDemandData] = useState<Array<{ date: string; demandMAE: number }>>([]);
  const [supplyData, setSupplyData] = useState<Array<{ date: string; supplyMAE: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const [demand, supply] = await Promise.all([
          getRollingShadowMAE(activePropertyId, 'demand', 14),
          getRollingShadowMAE(activePropertyId, 'supply', 14),
        ]);

        // Merge by date
        const merged = new Map<string, { date: string; demandMAE?: number; supplyMAE?: number }>();
        demand.forEach(d => {
          merged.set(d.date, { date: d.date, demandMAE: d.mae });
        });
        supply.forEach(d => {
          const existing = merged.get(d.date) ?? { date: d.date };
          existing.supplyMAE = d.mae;
          merged.set(d.date, existing);
        });

        const chartData = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
        setDemandData(demand.map(d => ({ date: d.date, demandMAE: d.mae })));
        setSupplyData(supply.map(d => ({ date: d.date, supplyMAE: d.mae })));

        // For chart, combine them
        const combined = chartData.map(row => ({
          date: row.date,
          'Demand MAE': row.demandMAE ?? null,
          'Supply MAE': row.supplyMAE ?? null,
        }));

        // Store combined for rendering
        setDemandData(combined as any);
      } catch (err) {
        console.error('ShadowMAEChart: fetch error', err);
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
          Shadow MAE — Rolling 14d
        </h2>
        <p style={{ fontSize: '13px', color: '#7a8a9e', margin: 0 }}>
          Model prediction accuracy vs actual outcomes
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : demandData.length === 0 ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>No data available</div>
      ) : (
        <div style={{ height: '300px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={demandData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(78,90,122,0.06)" />
              <XAxis
                dataKey="date"
                stroke="#7a8a9e"
                style={{ fontSize: '11px' }}
                interval={Math.floor((demandData.length - 1) / 4)}
              />
              <YAxis stroke="#7a8a9e" style={{ fontSize: '11px' }} label={{ value: 'MAE', angle: -90, position: 'insideLeft' }} />
              <Tooltip
                contentStyle={{
                  background: '#ffffff',
                  border: '1px solid rgba(78,90,122,0.12)',
                  borderRadius: '8px',
                  padding: '8px',
                }}
                cursor={{ stroke: 'rgba(0,101,101,0.2)' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="Demand MAE"
                stroke="#004b4b"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="Supply MAE"
                stroke="#0066cc"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
              <ReferenceLine
                y={5}
                stroke="rgba(220,52,69,0.3)"
                strokeDasharray="5 5"
                label={{ value: 'Activation threshold (5)', position: 'right', fill: '#dc3545', fontSize: 11 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
