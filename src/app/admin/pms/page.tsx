'use client';

/**
 * /admin/pms — PMS coverage dashboard.
 *
 * One row per supported PMS. Tells Reeyen at a glance which PMSes the
 * agent has already learned (4/4 actions captured, replays free for
 * every future hotel) and which still need a first-time mapping
 * (~$0.50, ~7 min on the first hotel of that PMS).
 *
 * Source of truth = pms_recipes.status='active' rows joined with
 * properties.pms_type counts and the most-recent onboarding_jobs row
 * per pms_type. See /api/admin/pms-coverage.
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  CheckCircle2, AlertCircle, Clock, ShieldAlert, RefreshCw, ExternalLink,
} from 'lucide-react';

type TargetAction = 'getRoomStatus' | 'getArrivals' | 'getDepartures' | 'getStaffRoster';

interface CoverageRow {
  pmsType: string;
  label: string;
  hint: string;
  tier: 1 | 2 | 3;
  runtime: 'railway' | 'fly';
  recipe: {
    id: string;
    version: number;
    createdAt: string;
    actionsCaptured: TargetAction[];
    actionsMissing: TargetAction[];
    coveragePct: number;
  } | null;
  propertyCount: number;
  latestJob: {
    id: string;
    status: string;
    step: string | null;
    progressPct: number | null;
    error: string | null;
    createdAt: string;
  } | null;
}

const ACTION_LABEL: Record<TargetAction, string> = {
  getRoomStatus: 'Housekeeping',
  getArrivals: 'Arrivals',
  getDepartures: 'Departures',
  getStaffRoster: 'Staff',
};

export default function AdminPMSPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<CoverageRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/pms-coverage');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load PMS coverage');
        setLoading(false);
        return;
      }
      setRows(json.data.pmsTypes);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!authLoading && user?.role === 'admin') void load();
  }, [authLoading, user]);

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
          {authLoading
            ? <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
            : <>
                <ShieldAlert size={32} color="var(--red)" style={{ marginBottom: '12px' }} />
                <p style={{ fontSize: '15px' }}>Admin access only.</p>
              </>
          }
        </div>
      </AppLayout>
    );
  }

  const fullyMapped = (rows ?? []).filter((r) => r.recipe && r.recipe.coveragePct === 100).length;
  const partiallyMapped = (rows ?? []).filter((r) => r.recipe && r.recipe.coveragePct < 100).length;
  const unmapped = (rows ?? []).filter((r) => !r.recipe).length;

  return (
    <AppLayout>
      <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.01em' }}>
              PMS coverage
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Which PMSes the CUA agent already knows. Mapped = future hotels onboard for free.
              Unmapped = first hotel triggers a one-time ~$0.50 / ~7 min mapping run.
            </p>
          </div>
          <button onClick={load} disabled={loading} className="btn btn-secondary" style={{ fontSize: '13px' }}>
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Refresh
          </button>
        </div>

        {rows && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '20px' }}>
            <Chip label="Fully mapped" value={fullyMapped} color="var(--green)" />
            <Chip label="Partial" value={partiallyMapped} color="var(--amber)" />
            <Chip label="Unmapped" value={unmapped} color="var(--text-muted)" />
            <Chip label="Total PMSes" value={rows.length} color="var(--text-secondary)" />
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

        {loading && !rows && (
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
          </div>
        )}

        {rows && rows.map((r) => <CoverageCard key={r.pmsType} row={r} />)}
      </div>
    </AppLayout>
  );
}

function Chip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: '6px 10px',
      background: 'var(--surface-secondary)',
      border: '1px solid var(--border)',
      borderRadius: '999px',
      fontSize: '12px',
      display: 'flex', alignItems: 'center', gap: '6px',
    }}>
      <span style={{ color }}>●</span>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <strong style={{ color: 'var(--text-primary)' }}>{value}</strong>
    </div>
  );
}

function CoverageCard({ row }: { row: CoverageRow }) {
  const isMapped = !!row.recipe;
  const fully = isMapped && row.recipe!.coveragePct === 100;
  const learnedAgo = row.recipe ? formatAge(row.recipe.createdAt) : null;

  return (
    <div style={{
      padding: '16px',
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '12px',
      marginBottom: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            {fully ? (
              <CheckCircle2 size={16} color="var(--green)" />
            ) : isMapped ? (
              <AlertCircle size={16} color="var(--amber)" />
            ) : (
              <Clock size={16} color="var(--text-muted)" />
            )}
            <h2 style={{ fontSize: '15px', fontWeight: 600 }}>{row.label}</h2>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '2px 6px', background: 'var(--surface-secondary)', borderRadius: '4px' }}>
              tier {row.tier}
            </span>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{row.hint}</p>
        </div>
        <div style={{ textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>
          {row.propertyCount} {row.propertyCount === 1 ? 'property' : 'properties'}
        </div>
      </div>

      <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '6px' }}>
        {(['getRoomStatus', 'getArrivals', 'getDepartures', 'getStaffRoster'] as TargetAction[]).map((a) => {
          const captured = row.recipe?.actionsCaptured.includes(a) ?? false;
          return (
            <div key={a} style={{
              padding: '8px',
              background: captured ? 'rgba(34,197,94,0.08)' : 'var(--surface-secondary)',
              border: `1px solid ${captured ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
              borderRadius: '8px',
              textAlign: 'center',
              fontSize: '11px',
            }}>
              <div style={{ color: captured ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>
                {captured ? '✓' : '—'}
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>{ACTION_LABEL[a]}</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '14px' }}>
        {row.recipe ? (
          <>
            <span>Recipe v{row.recipe.version}</span>
            <span>Learned {learnedAgo}</span>
            <span style={{ color: fully ? 'var(--green)' : 'var(--amber)' }}>
              {row.recipe.coveragePct}% coverage
            </span>
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Not yet mapped — first hotel triggers learning</span>
        )}
      </div>

      {row.latestJob && (
        <div style={{
          marginTop: '10px',
          padding: '8px 10px',
          background: 'var(--surface-secondary)',
          borderRadius: '8px',
          fontSize: '12px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px',
          alignItems: 'center',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Latest job:</span>
          <span style={{ fontWeight: 600 }}>{row.latestJob.status}</span>
          {row.latestJob.step && <span style={{ color: 'var(--text-muted)' }}>· {row.latestJob.step}</span>}
          {row.latestJob.error && (
            <span style={{ color: 'var(--red)', fontSize: '11px' }} title={row.latestJob.error}>
              · {row.latestJob.error.slice(0, 80)}{row.latestJob.error.length > 80 ? '…' : ''}
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>{formatAge(row.latestJob.createdAt)}</span>
        </div>
      )}
    </div>
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
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
