'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { getRecentDailyLogs } from '@/lib/firestore';
import { formatDate } from '@/lib/utils';
import type { DailyLog } from '@/types';
import { ChevronLeft } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

export default function ROIPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;

    (async () => {
      try {
        const dailyLogs = await getRecentDailyLogs(user.uid, activePropertyId, 90);
        setLogs(dailyLogs);
      } catch (error) {
        console.error('Error fetching daily logs:', error);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  if (authLoading || propLoading || loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-4 rounded-full mb-3 mx-auto" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--green)' }} />
            <div className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              Loading ROI data...
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  const thisWeek = getLogsForLastDays(logs, 7);
  const thisMonth = getLogsForLastDays(logs, 30);
  const allTime = logs;

  const thisWeekLaborSaved = sumLaborSaved(thisWeek);
  const thisWeekStaffRecommended = avgValue(thisWeek.map(l => l.recommendedStaff || 0));
  const thisWeekStaffActual = avgValue(thisWeek.map(l => l.actualStaff || 0));

  const thisMonthLaborSaved = sumLaborSaved(thisMonth);
  const thisMonthStaffRecommended = avgValue(thisMonth.map(l => l.recommendedStaff || 0));
  const thisMonthStaffActual = avgValue(thisMonth.map(l => l.actualStaff || 0));

  const allTimeLaborSaved = sumLaborSaved(allTime);
  const allTimeDaysTracked = allTime.length;

  const last30Days = getLogsForLastDays(logs, 30).sort((a, b) => a.date.localeCompare(b.date));
  const chartData = last30Days.map(log => ({
    date: new Date(log.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    laborCost: log.laborCost || 0,
  }));

  const staffComparisonData = last30Days.map(log => ({
    date: new Date(log.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    recommended: log.recommendedStaff || 0,
    actual: log.actualStaff || 0,
  }));

  return (
    <AppLayout>
      <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
        {/* Header */}
        <div
          className="sticky top-0 z-40 border-b px-4 py-4 flex items-center justify-between"
          style={{
            backgroundColor: 'var(--bg-card)',
            borderColor: 'var(--border)'
          }}
        >
          <button
            onClick={() => router.back()}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-primary)', backgroundColor: 'var(--bg)' }}
            aria-label="Go back"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-xl font-bold flex-1 text-center" style={{ color: 'var(--text-primary)' }}>
            ROI Summary
          </h1>
          <div className="w-10" />
        </div>

        <div className="p-4 space-y-6 pb-8">
          {/* This Week */}
          <KPICard title="This Week">
            <KPIRow label="Labor Saved" value={`$${thisWeekLaborSaved.toFixed(0)}`} color="var(--green)" />
            <KPIRow
              label="Avg Staff (Recommended vs Actual)"
              value={`${thisWeekStaffRecommended.toFixed(1)} vs ${thisWeekStaffActual.toFixed(1)}`}
              color="var(--navy)"
            />
          </KPICard>

          {/* This Month */}
          <KPICard title="This Month">
            <KPIRow label="Labor Saved" value={`$${thisMonthLaborSaved.toFixed(0)}`} color="var(--green)" />
            <KPIRow
              label="Avg Staff (Recommended vs Actual)"
              value={`${thisMonthStaffRecommended.toFixed(1)} vs ${thisMonthStaffActual.toFixed(1)}`}
              color="var(--navy)"
            />
          </KPICard>

          {/* All Time */}
          <KPICard title="All Time">
            <KPIRow label="Total Labor Saved" value={`$${allTimeLaborSaved.toFixed(0)}`} color="var(--green)" />
            <KPIRow label="Days Tracked" value={allTimeDaysTracked.toString()} color="var(--navy)" />
          </KPICard>

          {/* Labor Cost Trend Chart */}
          {chartData.length > 0 && (
            <div
              className="rounded-lg p-4 border"
              style={{
                backgroundColor: 'var(--bg-card)',
                borderColor: 'var(--border)'
              }}
            >
              <h3 className="text-sm font-bold mb-4 uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
                Labor Cost Trend (Last 30 Days)
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                  />
                  <YAxis
                    tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                    label={{ value: 'Cost ($)', angle: -90, position: 'insideLeft', style: { fill: 'var(--text-muted)' } }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      color: 'var(--text-primary)'
                    }}
                    formatter={(value) => `$${(value as number).toFixed(0)}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="laborCost"
                    stroke="var(--red)"
                    dot={{ r: 3, fill: 'var(--red)' }}
                    strokeWidth={2}
                    name="Labor Cost"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Staff Comparison Chart */}
          {staffComparisonData.length > 0 && (
            <div
              className="rounded-lg p-4 border"
              style={{
                backgroundColor: 'var(--bg-card)',
                borderColor: 'var(--border)'
              }}
            >
              <h3 className="text-sm font-bold mb-4 uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
                Recommended vs Actual Staff (Last 30 Days)
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={staffComparisonData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                  />
                  <YAxis
                    tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                    label={{ value: 'Staff Count', angle: -90, position: 'insideLeft', style: { fill: 'var(--text-muted)' } }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      color: 'var(--text-primary)'
                    }}
                    formatter={(value) => (value as number).toFixed(1)}
                  />
                  <Legend wrapperStyle={{ color: 'var(--text-primary)' }} />
                  <Line
                    type="monotone"
                    dataKey="recommended"
                    stroke="var(--green)"
                    dot={false}
                    strokeWidth={2}
                    name="Recommended"
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="var(--navy)"
                    dot={false}
                    strokeWidth={2}
                    name="Actual"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Empty State */}
          {logs.length === 0 && (
            <div
              className="rounded-lg p-8 text-center border-2 border-dashed"
              style={{
                borderColor: 'var(--border)',
                backgroundColor: 'var(--bg-card)'
              }}
            >
              <p className="text-lg font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                No data yet
              </p>
              <p style={{ color: 'var(--text-muted)' }}>
                ROI tracking starts after your first daily schedule. Run Morning Setup from the Dashboard to begin.
              </p>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

interface KPICardProps {
  title: string;
  children: React.ReactNode;
}

function KPICard({ title, children }: KPICardProps) {
  return (
    <div
      className="rounded-lg p-4 border"
      style={{
        backgroundColor: 'var(--bg-card)',
        borderColor: 'var(--border)'
      }}
    >
      <h2 className="text-sm font-bold mb-4 uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

interface KPIRowProps {
  label: string;
  value: string;
  color?: string;
}

function KPIRow({ label, value, color = 'var(--text-primary)' }: KPIRowProps) {
  return (
    <div className="flex justify-between items-center py-2">
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      <span className="font-bold text-lg" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function getLogsForLastDays(logs: DailyLog[], days: number): DailyLog[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA');
  return logs.filter(log => log.date >= cutoffStr);
}

function sumLaborSaved(logs: DailyLog[]): number {
  return logs.reduce((sum, log) => sum + (log.laborSaved || 0), 0);
}

function avgValue(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
