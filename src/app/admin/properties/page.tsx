'use client';

/**
 * /admin/properties — Reeyen's fleet view.
 *
 * One row per property, sorted with the most-broken ones at the top
 * (past_due → stale → trial_expired → trial → active). At a glance
 * shows: subscription, PMS sync freshness, latest onboarding job
 * status, room/staff counts.
 *
 * Click any row to /admin/properties/[id] for the deep view.
 *
 * Auth: admin role only. Non-admins get a 403 from the API and we
 * show a "you don't have access" message.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  AlertTriangle, CheckCircle2, Clock, Building2, ChevronRight,
  WifiOff, Wifi, RefreshCw, ShieldAlert, Layers, Activity,
} from 'lucide-react';

interface PropertyRow {
  id: string;
  name: string | null;
  totalRooms: number | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  trialExpired: boolean;
  pmsType: string | null;
  pmsConnected: boolean;
  lastSyncedAt: string | null;
  syncFreshnessMin: number | null;
  isStale: boolean;
  staffCount: number;
  onboardingSource: string | null;
  propertyKind: string | null;
  createdAt: string;
  latestJob: {
    id: string;
    status: string | null;
    step: string | null;
    progressPct: number | null;
    error: string | null;
    createdAt: string;
  } | null;
}

interface Summary {
  total: number;
  trial: number;
  active: number;
  pastDue: number;
  canceled: number;
  stale: number;
  trialExpired: number;
  pmsConnected: number;
}

export default function AdminPropertiesPage() {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<{ summary: Summary; properties: PropertyRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/list-properties');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load properties');
        setLoading(false);
        return;
      }
      setData(json.data);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!authLoading && user?.role === 'admin') {
      void load();
    }
  }, [authLoading, user]);

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
          {authLoading
            ? <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
            : (
              <>
                <ShieldAlert size={32} color="var(--red)" style={{ marginBottom: '12px' }} />
                <p style={{ fontSize: '15px' }}>Admin access only.</p>
              </>
            )}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.01em' }}>
              Admin
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Fleet + PMS + onboarding-job views.
            </p>
          </div>
          <button onClick={load} disabled={loading} className="btn btn-secondary" style={{ fontSize: '13px' }}>
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Refresh
          </button>
        </div>

        {/* Sub-page cards — quick access to the other admin views. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px', marginBottom: '20px' }}>
          <Link href="/admin/pms" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card" style={{ padding: '16px', cursor: 'pointer', transition: 'background 0.15s' }}
              onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-secondary)'; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <Layers size={16} color="var(--amber)" />
                <h3 style={{ fontSize: '14px', fontWeight: 600 }}>PMS coverage</h3>
                <ChevronRight size={14} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Which PMSes the agent has learned. Mapped = future hotels onboard for free.
              </p>
            </div>
          </Link>
          <Link href="/admin/jobs" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card" style={{ padding: '16px', cursor: 'pointer', transition: 'background 0.15s' }}
              onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-secondary)'; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <Activity size={16} color="var(--amber)" />
                <h3 style={{ fontSize: '14px', fontWeight: 600 }}>Onboarding jobs</h3>
                <ChevronRight size={14} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Watch live onboardings + post-mortem failures. Bottleneck visibility.
              </p>
            </div>
          </Link>
        </div>

        {/* Header for the property list itself. */}
        <div style={{ marginBottom: '12px' }}>
          <h2 style={{ fontSize: '15px', fontWeight: 600 }}>All properties</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Fleet view — broken ones rise to the top.
          </p>
        </div>

        {/* Summary chips */}
        {data && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '20px' }}>
            <Chip label="Total" value={data.summary.total} color="var(--text-secondary)" />
            <Chip label="Active" value={data.summary.active} color="var(--green)" />
            <Chip label="Trial" value={data.summary.trial} color="var(--amber)" />
            <Chip label="Past due" value={data.summary.pastDue} color="var(--red)" />
            <Chip label="Trial expired" value={data.summary.trialExpired} color="var(--red)" />
            <Chip label="Stale sync" value={data.summary.stale} color="var(--red)" />
            <Chip label="PMS connected" value={data.summary.pmsConnected} color="var(--green)" />
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

        {data && data.properties.length === 0 && !loading && (
          <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
            <Building2 size={32} style={{ marginBottom: '12px' }} />
            <p style={{ fontSize: '14px' }}>No properties yet. Self-signups will appear here.</p>
          </div>
        )}

        {data && data.properties.length > 0 && (
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: '12px',
            overflow: 'hidden',
            background: 'var(--card-bg, transparent)',
          }}>
            {data.properties.map((p, idx) => (
              <Link
                key={p.id}
                href={`/admin/properties/${p.id}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1.2fr 1.5fr auto',
                  gap: '12px',
                  alignItems: 'center',
                  padding: '14px 16px',
                  borderBottom: idx < data.properties.length - 1 ? '1px solid var(--border)' : 'none',
                  textDecoration: 'none', color: 'inherit',
                  background: rowBackground(p),
                }}
              >
                {/* Name + meta */}
                <div>
                  <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                    {p.name ?? '(unnamed)'}
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {p.totalRooms ?? '—'} rooms · {p.staffCount} staff · {p.propertyKind ?? '—'}
                  </p>
                </div>

                {/* Subscription */}
                <SubscriptionBadge p={p} />

                {/* PMS / sync */}
                <SyncBadge p={p} />

                {/* Latest job */}
                <JobBadge p={p} />

                <ChevronRight size={16} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </AppLayout>
  );
}

function rowBackground(p: PropertyRow): string {
  if (p.subscriptionStatus === 'past_due') return 'rgba(239,68,68,0.04)';
  if (p.isStale) return 'rgba(239,68,68,0.03)';
  if (p.trialExpired) return 'rgba(212,144,64,0.04)';
  return 'transparent';
}

function Chip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: '6px 12px',
      borderRadius: '8px',
      border: `1px solid ${color}`,
      fontSize: '12px',
      color,
      fontFamily: 'var(--font-mono)',
    }}>
      <span style={{ opacity: 0.7 }}>{label}: </span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function SubscriptionBadge({ p }: { p: PropertyRow }) {
  const status = p.subscriptionStatus ?? 'unknown';
  const color = status === 'active' ? 'var(--green)'
              : status === 'trial' && !p.trialExpired ? 'var(--amber)'
              : 'var(--red)';
  const label = status === 'trial' && p.trialExpired ? 'TRIAL EXPIRED' : status.toUpperCase();
  return (
    <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color, fontWeight: 600 }}>
      {label}
      {p.trialEndsAt && status === 'trial' && (
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400, marginTop: '2px' }}>
          ends {new Date(p.trialEndsAt).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}

function SyncBadge({ p }: { p: PropertyRow }) {
  if (!p.pmsConnected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
        <WifiOff size={14} /> not connected
      </div>
    );
  }
  const ageColor = p.isStale ? 'var(--red)'
                 : p.syncFreshnessMin !== null && p.syncFreshnessMin > 30 ? 'var(--amber)'
                 : 'var(--green)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: ageColor }}>
      <Wifi size={14} /> {p.pmsType}
      {p.syncFreshnessMin !== null && (
        <span style={{ fontFamily: 'var(--font-mono)' }}>· {p.syncFreshnessMin}m ago</span>
      )}
    </div>
  );
}

function JobBadge({ p }: { p: PropertyRow }) {
  if (!p.latestJob) return <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>—</span>;
  const j = p.latestJob;
  const Icon = j.status === 'complete' ? CheckCircle2
             : j.status === 'failed' ? AlertTriangle
             : Clock;
  const color = j.status === 'complete' ? 'var(--green)'
              : j.status === 'failed' ? 'var(--red)'
              : 'var(--amber)';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '12px', color }}>
      <Icon size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
      <div>
        <p style={{ fontWeight: 600 }}>{(j.status ?? '').toUpperCase()}</p>
        {j.step && (
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {j.step}
          </p>
        )}
      </div>
    </div>
  );
}
