'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getCleaningEventStats, getCleaningEventsPerDay } from '@/lib/db';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LabelList } from 'recharts';

const MILESTONES = [50, 200, 500, 2000, 5000];

// Per-day breakdown shape returned by getCleaningEventsPerDay.
//   • date:      "MM-DD" short string for x-axis labels
//   • recorded:  real cleans (status not 'discarded')
//   • discarded: throwaway taps (under 3min, over 90min, or Done→Reset undo)
//   • count:     legacy alias for `recorded` — kept for backward compat
type DailyRow = { date: string; count: number; recorded: number; discarded: number };

export function DataFuelGauge() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [total, setTotal] = useState(0);
  const [last7d, setLast7d] = useState(0);
  const [last24h, setLast24h] = useState(0);
  const [distinctStaff, setDistinctStaff] = useState(0);
  const [distinctRooms, setDistinctRooms] = useState(0);
  const [chartData, setChartData] = useState<DailyRow[]>([]);
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

  // Last 14 days for the table — recent at top so the most relevant info is
  // the first thing Reeyen sees when he scans down.
  const recentDays = useMemo(() => {
    const last14 = chartData.slice(-14).slice().reverse();
    return last14.map((row) => {
      // chartData rows have date "MM-DD" — synthesize a current-year date for
      // the day-of-week label. We don't store the full ISO date through to
      // here so this can drift one day at the year boundary; acceptable for
      // a UI label that's already showing the same calendar info.
      const [mm, dd] = row.date.split('-').map(Number);
      const year = new Date().getFullYear();
      const d = new Date(year, (mm ?? 1) - 1, dd ?? 1);
      const dayOfWeek = d.toLocaleDateString('en-US', { weekday: 'short' });
      return { ...row, dayOfWeek, total: row.recorded + row.discarded };
    });
  }, [chartData]);

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

          {/* ── Daily Activity Bar Chart ──
              One bar per day showing real cleans (teal) stacked on top of
              throwaway taps (gray). Total label sits above each bar so
              Reeyen can scan platform usage at a glance without hovering.
              Days with zero activity show no bar — making "nobody used the
              app" obvious by absence. */}
          <div style={{ marginTop: '16px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
                Daily Activity (Last 30 Days)
              </h3>
              <p style={{ fontSize: '11px', color: '#7a8a9e', margin: 0 }}>
                Each bar = one day. Top number = total Done taps that day.
              </p>
            </div>
          </div>
          <div style={{ height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 24, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(78,90,122,0.06)" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="#7a8a9e"
                  style={{ fontSize: '10px' }}
                  interval={2}
                  tickMargin={6}
                />
                <YAxis stroke="#7a8a9e" style={{ fontSize: '10px' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: '#ffffff',
                    border: '1px solid rgba(78,90,122,0.12)',
                    borderRadius: '8px',
                    padding: '8px',
                    fontSize: '12px',
                  }}
                  cursor={{ fill: 'rgba(0,101,101,0.05)' }}
                  formatter={(value: number, name: string) => {
                    const label = name === 'recorded' ? 'Real cleans' : name === 'discarded' ? 'Throwaway taps' : name;
                    return [value, label];
                  }}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                  formatter={(value: string) => value === 'recorded' ? 'Real cleans' : 'Throwaway taps (under 3 min)'}
                />
                <Bar dataKey="recorded" stackId="a" fill="#004b4b" isAnimationActive={false} />
                <Bar dataKey="discarded" stackId="a" fill="#cbd5e1" isAnimationActive={false}>
                  {/* Total label rides on the top stack so it always shows the
                      sum of both segments, regardless of which one is bigger. */}
                  <LabelList
                    position="top"
                    style={{ fontSize: '10px', fill: '#1b1c19', fontWeight: 600 }}
                    formatter={(value: unknown, _entry?: unknown, index?: unknown): string => {
                      const idx = typeof index === 'number' ? index : -1;
                      if (idx < 0) return '';
                      const row = chartData[idx];
                      if (!row) return '';
                      const sum = row.recorded + row.discarded;
                      return sum > 0 ? String(sum) : '';
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── Daily Activity Table (Last 14 Days) ──
              Same data as the chart but in a row-by-row form Reeyen can
              skim. Most recent at top. Zero-activity days deliberately
              shown so "nobody touched the app on Tuesday" is unambiguous. */}
          <div style={{ marginTop: '32px' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19', margin: 0, marginBottom: '12px' }}>
              Last 14 Days — Day-by-Day
            </h3>
            <div style={{
              border: '1px solid rgba(78,90,122,0.12)',
              borderRadius: '8px',
              overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'rgba(0,101,101,0.04)' }}>
                    <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#1b1c19', borderBottom: '1px solid rgba(78,90,122,0.12)' }}>Date</th>
                    <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#1b1c19', borderBottom: '1px solid rgba(78,90,122,0.12)' }}>Day</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: '#1b1c19', borderBottom: '1px solid rgba(78,90,122,0.12)' }}>Real cleans</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: '#1b1c19', borderBottom: '1px solid rgba(78,90,122,0.12)' }}>Throwaway</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: '#1b1c19', borderBottom: '1px solid rgba(78,90,122,0.12)' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDays.map((row, i) => {
                    const noActivity = row.total === 0;
                    return (
                      <tr key={row.date} style={{
                        background: noActivity ? 'rgba(239,68,68,0.03)' : (i % 2 === 0 ? '#ffffff' : 'rgba(0,101,101,0.02)'),
                      }}>
                        <td style={{ padding: '8px 12px', color: '#1b1c19', fontFamily: 'var(--font-mono)' }}>{row.date}</td>
                        <td style={{ padding: '8px 12px', color: noActivity ? '#dc2626' : '#7a8a9e' }}>
                          {row.dayOfWeek}{noActivity ? ' — no activity' : ''}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#004b4b', fontWeight: row.recorded > 0 ? 600 : 400, fontFamily: 'var(--font-mono)' }}>
                          {row.recorded}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#7a8a9e', fontFamily: 'var(--font-mono)' }}>
                          {row.discarded}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#1b1c19', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                          {row.total}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
