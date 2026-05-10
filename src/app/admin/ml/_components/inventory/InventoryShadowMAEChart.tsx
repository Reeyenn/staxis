'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryRollingMAE } from '@/lib/db';
import type { InventoryShadowMAEPoint } from '@/lib/db/ml-inventory-cockpit';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['#004b4b', '#0066cc', '#8b5cf6', '#dc3545', '#f0ad4e'];

/**
 * Shadow MAE chart — rolling daily mean-absolute-error per item, top 5 by
 * volume. Shows whether predictions are converging toward actuals as data
 * accumulates. Empty until prediction_log starts getting populated in
 * session 2.
 */
export function InventoryShadowMAEChart() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [data, setData] = useState<InventoryShadowMAEPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        const points = await getInventoryRollingMAE(activePropertyId, 30, 5);
        setData(points);
      } catch (err) {
        console.error('InventoryShadowMAEChart: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  // Pivot to wide format for recharts: one row per date, columns = item names.
  const wideData = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    const items = new Set<string>();
    for (const p of data) {
      items.add(p.itemName);
      if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
      byDate.get(p.date)![p.itemName] = p.mae;
    }
    return {
      rows: Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date))),
      items: Array.from(items),
    };
  }, [data]);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '12px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Prediction accuracy over time
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Top 5 items by volume. Lower bars = better. Goal: trend down as data accumulates.
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : wideData.rows.length === 0 ? (
        <div style={{
          padding: '32px',
          textAlign: 'center',
          color: '#7a8a9e',
          fontSize: '13px',
          background: '#f7fafb',
          borderRadius: '8px',
        }}>
          No predicted-vs-actual pairs yet. The first counts after a prediction is generated will populate this chart (typically takes 2–3 weeks of regular counting).
        </div>
      ) : (
        <div style={{ height: '280px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={wideData.rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(78,90,122,0.1)" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#7a8a9e' }} />
              <YAxis tick={{ fontSize: 11, fill: '#7a8a9e' }} />
              <Tooltip
                contentStyle={{
                  background: '#ffffff',
                  border: '1px solid rgba(78,90,122,0.15)',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {wideData.items.map((it, i) => (
                <Line
                  key={it}
                  type="monotone"
                  dataKey={it}
                  stroke={COLORS[i % COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
