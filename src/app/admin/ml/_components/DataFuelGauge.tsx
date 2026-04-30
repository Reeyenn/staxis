'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getCleaningEventStats, getCleaningEventsPerDay } from '@/lib/db';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingUp } from 'lucide-react';

const MILESTONES = [50, 200, 500, 2000, 5000];

export function DataFuelGauge() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [total, setTotal] = useState(0);
  const [last7d, setLast7d] = useState(0);
  const [last24h, setLast24h] = useState(0);
  const [distinctStaff, setDistinctStaff] = useState(0);
  const [distinctRooms, setDistinctRooms] = useState(0);
  const [chartData, setChartData] = useState<Array<{ date: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const [stats, dailyData] = await Promise.all([
          getCleaningEventStats(activePropertyId),
          getCleaningEventsPerDay(activePropertyId, 30),
        ]);
        setTotal(stats.total);
        setLast7d(stats.last7d);
        setLast24h(stats.last24h);
        setDistinctStaff(stats.distinctStaff);
        setDistinctRooms(stats.distinctRooms);
        setChartData(dailyData);
      } catch (err) {
        console.error('DataFuelGauge: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  // Find next milestone
  const nextMilestone = MILESTONES.find(m => m > total) ?? MILESTONES[MILESTONES.length - 1];
  const prevMilestone = MILESTONES.filter(m => m <= total).pop() ?? 0;
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
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0, marginBottom: '4px' }}>
          Data Fuel Gauge
        </h2>
        <p style={{ fontSize: '13px', color: '#7a8a9e', margin: 0 }}>
          Total cleaning events collected
        </p>
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading...</div>
      ) : (
        <>
          {/* Big number + progress */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{
              fontSize: '40px',
              fontWeight: 700,
              color: '#004b4b',
              marginBottom: '8px',
            }}>
              {total.toLocaleString()}
            </div>
            <div style={{ fontSize: '12px', color: '#7a8a9e', marginBottom: '12px' }}>
              {Math.round(progressToNext)}% to milestone {nextMilestone.toLocaleString()}
            </div>

            {/* Progress bar */}
            <div style={{
              height: '8px',
              background: 'rgba(0,101,101,0.1)',
              borderRadius: '4px',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(progressToNext, 100)}%`,
                background: 'linear-gradient(90deg, #004b4b, #00a6a6)',
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>

          {/* Sub-stats grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '12px',
            marginBottom: '24px',
          }}>
            {[
              { label: 'Last 24h', value: last24h },
              { label: 'Last 7d', value: last7d },
              { label: 'Staff', value: distinctStaff },
              { label: 'Rooms', value: distinctRooms },
              { label: 'Avg/Day', value: last7d > 0 ? Math.round(last7d / 7) : 0 },
            ].map((stat, i) => (
              <div key={i} style={{
                background: 'rgba(0,101,101,0.04)',
                borderRadius: '8px',
                padding: '12px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '16px', fontWeight: 600, color: '#004b4b' }}>
                  {stat.value}
                </div>
                <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '4px' }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div style={{ height: '200px', marginTop: '16px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(78,90,122,0.06)" />
                <XAxis
                  dataKey="date"
                  stroke="#7a8a9e"
                  style={{ fontSize: '11px' }}
                  interval={Math.floor(chartData.length / 4)}
                />
                <YAxis stroke="#7a8a9e" style={{ fontSize: '11px' }} />
                <Tooltip
                  contentStyle={{
                    background: '#ffffff',
                    border: '1px solid rgba(78,90,122,0.12)',
                    borderRadius: '8px',
                    padding: '8px',
                  }}
                  cursor={{ stroke: 'rgba(0,101,101,0.2)' }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#004b4b"
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
