'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryDataFuelStats, getInventoryCountsPerDay } from '@/lib/db';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const MILESTONES = [10, 50, 200, 500, 2000];

export function InventoryDataFuelGauge() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [total, setTotal] = useState(0);
  const [last7d, setLast7d] = useState(0);
  const [last24h, setLast24h] = useState(0);
  const [itemsTracked, setItemsTracked] = useState(0);
  const [daysOfHistory, setDaysOfHistory] = useState(0);
  const [chartData, setChartData] = useState<Array<{ date: string; recorded: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        const [stats, daily] = await Promise.all([
          getInventoryDataFuelStats(activePropertyId),
          getInventoryCountsPerDay(activePropertyId, 30),
        ]);
        setTotal(stats.totalCounts);
        setLast7d(stats.last7d);
        setLast24h(stats.last24h);
        setItemsTracked(stats.itemsTracked);
        setDaysOfHistory(stats.daysOfHistory);
        setChartData(daily);
      } catch (err) {
        console.error('InventoryDataFuelGauge: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const nextMilestone = MILESTONES.find((m) => m > total) ?? MILESTONES[MILESTONES.length - 1];
  const prevMilestone = MILESTONES.filter((m) => m <= total).pop() ?? 0;
  const progressToNext = nextMilestone > prevMilestone
    ? ((total - prevMilestone) / (nextMilestone - prevMilestone)) * 100
    : 100;

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Inventory data fuel
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          Count events captured. The model needs ~30 events per item to graduate that item to auto-fill.
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px', marginBottom: '20px' }}>
            <Stat label="Total counts" value={total.toLocaleString()} />
            <Stat label="Last 7 days" value={last7d.toLocaleString()} />
            <Stat label="Last 24 hours" value={last24h.toLocaleString()} />
            <Stat label="Items tracked" value={itemsTracked.toLocaleString()} />
            <Stat label="Days of history" value={daysOfHistory.toLocaleString()} />
          </div>

          {/* Progress bar to next milestone */}
          <div style={{ marginBottom: '20px' }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: '11px', color: '#7a8a9e', marginBottom: '6px',
            }}>
              <span>Next milestone: {nextMilestone.toLocaleString()} counts</span>
              <span>{Math.round(progressToNext)}%</span>
            </div>
            <div style={{ height: '6px', background: '#f0f4f7', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.min(100, Math.max(0, progressToNext))}%`,
                height: '100%',
                background: '#004b4b',
                transition: 'width 0.4s',
              }} />
            </div>
          </div>

          <div style={{ height: '180px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(78,90,122,0.1)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#7a8a9e' }} />
                <YAxis tick={{ fontSize: 11, fill: '#7a8a9e' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: '#ffffff',
                    border: '1px solid rgba(78,90,122,0.15)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="recorded" fill="#004b4b" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 600, color: '#1b1c19' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '2px' }}>{label}</div>
    </div>
  );
}
