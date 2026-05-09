'use client';

/**
 * /admin/jobs — onboarding job timeline.
 *
 * One row per onboarding_jobs entry, newest first. Lets Reeyen watch a
 * live onboarding play out (running jobs at the top) and post-mortem
 * failures (their step + error tells you exactly where the hotel got
 * stuck). Auto-refreshes every 8 seconds while there's a running job.
 *
 * Filters:
 *   - All (default), Live, Failed, Complete
 *
 * Each row links to /admin/properties/[id] for deeper context.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  CheckCircle2, AlertCircle, Clock, Loader2, ShieldAlert, RefreshCw,
  ChevronRight, ChevronLeft,
} from 'lucide-react';

interface JobRow {
  id: string;
  propertyId: string;
  propertyName: string | null;
  pmsType: string;
  status: string;
  step: string | null;
  progressPct: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  forceRemap: boolean;
}

interface Summary {
  total: number;
  running: number;
  failed: number;
  complete: number;
}

const RUNNING_STATES = new Set(['queued', 'running', 'mapping', 'extracting']);

type Filter = 'all' | 'live' | 'failed' | 'complete';

export default function AdminJobsPage() {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<{ jobs: JobRow[]; summary: Summary } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async (filterArg: Filter = filter) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (filterArg === 'live') qs.set('live', '1');
      else if (filterArg === 'failed') qs.set('status', 'failed');
      else if (filterArg === 'complete') qs.set('status', 'complete');
      const res = await fetchWithAuth(`/api/admin/onboarding-jobs?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load jobs');
        setLoading(false);
        return;
      }
      setData(json.data);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
    setLoading(false);
  };

  // Initial + on filter change.
  useEffect(() => {
    if (!authLoading && user?.role === 'admin') void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, filter]);

  // Auto-refresh every 8s when there's at least one running job. Uses
  // a recursive setTimeout so each fetch completes before the next is
  // scheduled (no overlapping requests).
  useEffect(() => {
    if (!data) return;
    const hasRunning = data.jobs.some((j) => RUNNING_STATES.has(j.status));
    if (!hasRunning) return;
    refreshTimer.current = setTimeout(() => { void load(filter); }, 8000);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
          {authLoading
            ? <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
            : <>
                <ShieldAlert size={32} color="var(--red)" style={{ marginBottom: '12px' }} />
                <p style={{ fontSize: '15px' }}>Admin access only.</p>
              </>}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
        <Link href="/admin/properties" style={{
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '12px',
        }}>
          <ChevronLeft size={14} /> Back to admin
        </Link>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.01em' }}>
              Onboarding jobs
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Watch new hotels onboarding in real time. Click a row for the property's full state.
              Auto-refreshes every 8 seconds when something's running.
            </p>
          </div>
          <button onClick={() => load(filter)} disabled={loading} className="btn btn-secondary" style={{ fontSize: '13px' }}>
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Refresh
          </button>
        </div>

        {data && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
            <FilterChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} value={data.summary.total} />
            <FilterChip label="Live" active={filter === 'live'} onClick={() => setFilter('live')} value={data.summary.running} color="var(--amber)" />
            <FilterChip label="Failed" active={filter === 'failed'} onClick={() => setFilter('failed')} value={data.summary.failed} color="var(--red)" />
            <FilterChip label="Complete" active={filter === 'complete'} onClick={() => setFilter('complete')} value={data.summary.complete} color="var(--green)" />
          </div>
        )}

        {error && (
          <div style={{
            padding: '12px 14px',
            background: 'var(--red-dim)',
            border: '1px solid var(--red-border, rgba(239,68,68,0.25))',
            borderRadius: '10px',
            marginBottom: '16px',
            color: 'var(--red)', fontSize: '13px',
          }}>{error}</div>
        )}

        {loading && !data && (
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
          </div>
        )}

        {data && data.jobs.length === 0 && !loading && (
          <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
            No jobs match this filter yet.
          </div>
        )}

        {data && data.jobs.map((j) => <JobCard key={j.id} job={j} />)}
      </div>
    </AppLayout>
  );
}

function FilterChip({ label, active, onClick, value, color }: {
  label: string; active: boolean; onClick: () => void; value: number; color?: string;
}) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px',
      background: active ? 'var(--surface-primary)' : 'var(--surface-secondary)',
      border: `1px solid ${active ? 'var(--amber)' : 'var(--border)'}`,
      borderRadius: '999px',
      fontSize: '12px',
      cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: '6px',
      color: 'var(--text-primary)',
    }}>
      <span style={{ color: color ?? 'var(--text-muted)' }}>●</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function JobCard({ job }: { job: JobRow }) {
  const isRunning = RUNNING_STATES.has(job.status);
  const isFailed = job.status === 'failed';
  const isComplete = job.status === 'complete';

  const StatusIcon = isComplete ? CheckCircle2 : isFailed ? AlertCircle : isRunning ? Loader2 : Clock;
  const statusColor = isComplete ? 'var(--green)' : isFailed ? 'var(--red)' : isRunning ? 'var(--amber)' : 'var(--text-muted)';

  return (
    <Link href={`/admin/properties/${job.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{
        padding: '14px 16px',
        background: 'var(--surface-primary)',
        border: `1px solid ${isFailed ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`,
        borderRadius: '12px',
        marginBottom: '10px',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }} onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-secondary)'; }}
         onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-primary)'; }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <StatusIcon size={16} color={statusColor} style={{ animation: isRunning ? 'spin 1.5s linear infinite' : undefined }} />
          <h3 style={{ fontSize: '14px', fontWeight: 600 }}>
            {job.propertyName ?? '(deleted property)'}
          </h3>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '2px 6px', background: 'var(--surface-secondary)', borderRadius: '4px' }}>
            {job.pmsType}
          </span>
          {job.forceRemap && (
            <span style={{ fontSize: '11px', color: 'var(--amber)', padding: '2px 6px', background: 'rgba(245,158,11,0.1)', borderRadius: '4px' }}>
              re-map
            </span>
          )}
          <span style={{ fontSize: '11px', fontWeight: 600, color: statusColor, marginLeft: 'auto' }}>
            {job.status.toUpperCase()}
          </span>
          <ChevronRight size={14} color="var(--text-muted)" />
        </div>

        {/* Step + progress bar */}
        <div style={{ marginTop: '8px', marginBottom: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            <span>{job.step ?? (isRunning ? 'Working…' : '—')}</span>
            {job.progressPct != null && <span>{job.progressPct}%</span>}
          </div>
          <div style={{ height: '4px', background: 'var(--surface-secondary)', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{
              width: `${Math.max(0, Math.min(100, job.progressPct ?? 0))}%`,
              height: '100%',
              background: statusColor,
              transition: 'width 0.3s',
            }} />
          </div>
        </div>

        {/* Timing line */}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          <span>Started {formatAge(job.createdAt)}</span>
          {job.durationMs != null && (
            <span>Duration {formatDuration(job.durationMs)}</span>
          )}
          {job.completedAt && (
            <span>Finished {formatAge(job.completedAt)}</span>
          )}
        </div>

        {job.error && (
          <div style={{
            marginTop: '8px',
            padding: '8px 10px',
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: '6px',
            color: 'var(--red)',
            fontSize: '12px',
          }}>
            {job.error}
          </div>
        )}
      </div>
    </Link>
  );
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}
