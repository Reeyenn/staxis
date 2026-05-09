'use client';

/**
 * Live hotels tab — Phase 1 baseline.
 *
 * Shows the hotels-list view (sorted by problems first) using the
 * existing /api/admin/list-properties data, with the staleness
 * threshold tightened from the old 7-day default to 12 hours.
 *
 * Phase 2 layers on grouped errors, SMS health per hotel, and the
 * health-summary chips. Phase 5 adds the activity / engagement panel.
 * Phase 6 adds the in-app feedback inbox.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  AlertTriangle, CheckCircle2, Clock, Building2, ChevronRight,
  WifiOff, Wifi,
} from 'lucide-react';

const STALE_THRESHOLD_MIN = 12 * 60; // 12 hours

interface PropertyRow {
  id: string;
  name: string | null;
  totalRooms: number | null;
  subscriptionStatus: string | null;
  pmsType: string | null;
  pmsConnected: boolean;
  lastSyncedAt: string | null;
  syncFreshnessMin: number | null;
  staffCount: number;
  createdAt: string;
  latestJob: {
    id: string; status: string | null; step: string | null;
    progressPct: number | null; error: string | null; createdAt: string;
  } | null;
}

export function LiveHotelsTab() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const res = await fetchWithAuth('/api/admin/list-properties');
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load hotels');
        return;
      }
      setProps(json.data.properties);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  useEffect(() => { void load(); }, []);

  if (error) {
    return (
      <div style={{
        padding: '12px 14px',
        background: 'var(--red-dim)',
        border: '1px solid rgba(239,68,68,0.25)',
        borderRadius: '10px',
        color: 'var(--red)', fontSize: '13px',
      }}>{error}</div>
    );
  }

  if (!props) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  // Live = synced at least once OR subscription_status='active'. Hotels
  // that are still mid-onboarding (no first sync, not active) belong on
  // the Onboarding tab.
  const live = props.filter((p) =>
    p.lastSyncedAt !== null || p.subscriptionStatus === 'active'
  );

  // Tighten staleness to 12h here (the parent API uses 2h for isStale,
  // but per Reeyen's call, anything over 12h needs eyes).
  const enriched = live.map((p) => ({
    ...p,
    isStale12h: p.pmsConnected && p.syncFreshnessMin !== null && p.syncFreshnessMin > STALE_THRESHOLD_MIN,
  }));

  // Sort: past_due first → 12h-stale → everything else.
  enriched.sort((a, b) => {
    const score = (p: typeof a) => {
      if (p.subscriptionStatus === 'past_due') return 0;
      if (p.isStale12h) return 1;
      return 2;
    };
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div>
            <h2 style={{ fontSize: '15px', fontWeight: 600 }}>Live hotels</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Sorted by problems first. Anything not synced in 12 hours is flagged red.
            </p>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {enriched.length} {enriched.length === 1 ? 'hotel' : 'hotels'}
          </span>
        </div>

        {enriched.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <Building2 size={28} style={{ marginBottom: '8px' }} />
            <p style={{ fontSize: '13px' }}>No live hotels yet — they'll appear here once their first sync completes.</p>
          </div>
        ) : (
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: '10px',
            overflow: 'hidden',
            background: 'var(--surface-primary)',
          }}>
            {enriched.map((p, idx) => (
              <Link
                key={p.id}
                href={`/admin/properties/${p.id}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1.2fr auto',
                  gap: '12px',
                  alignItems: 'center',
                  padding: '14px 16px',
                  borderBottom: idx < enriched.length - 1 ? '1px solid var(--border)' : 'none',
                  textDecoration: 'none', color: 'inherit',
                  background: rowBackground(p),
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px' }}>
                    {p.name ?? '(unnamed)'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {p.totalRooms ?? '—'} rooms · {p.staffCount} staff
                  </div>
                </div>
                <SubscriptionBadge status={p.subscriptionStatus} />
                <SyncBadge p={p} />
                <ChevronRight size={14} color="var(--text-muted)" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Phase 2/5/6 placeholder */}
      <div style={{
        padding: '14px',
        background: 'var(--surface-secondary)',
        border: '1px dashed var(--border)',
        borderRadius: '10px',
        textAlign: 'center',
        fontSize: '12px',
        color: 'var(--text-muted)',
        lineHeight: 1.5,
      }}>
        Coming next on this tab: grouped errors • SMS health per hotel • GM activity & engagement • in-app feedback inbox.
      </div>
    </div>
  );
}

function rowBackground(p: { subscriptionStatus: string | null; isStale12h: boolean }): string {
  if (p.subscriptionStatus === 'past_due') return 'rgba(239,68,68,0.04)';
  if (p.isStale12h) return 'rgba(239,68,68,0.03)';
  return 'transparent';
}

function SubscriptionBadge({ status }: { status: string | null }) {
  const s = status ?? 'unknown';
  const color = s === 'active' ? 'var(--green)'
              : s === 'past_due' ? 'var(--red)'
              : 'var(--text-muted)';
  return (
    <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color, fontWeight: 600 }}>
      {s.toUpperCase()}
    </div>
  );
}

function SyncBadge({ p }: { p: { pmsConnected: boolean; pmsType: string | null; syncFreshnessMin: number | null; isStale12h: boolean } }) {
  if (!p.pmsConnected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
        <WifiOff size={14} /> not connected
      </div>
    );
  }
  const color = p.isStale12h ? 'var(--red)'
              : p.syncFreshnessMin !== null && p.syncFreshnessMin > 60 ? 'var(--amber)'
              : 'var(--green)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color }}>
      <Wifi size={14} /> {p.pmsType}
      {p.syncFreshnessMin !== null && (
        <span style={{ fontFamily: 'var(--font-mono)' }}>· {formatMin(p.syncFreshnessMin)} ago</span>
      )}
    </div>
  );
}

function formatMin(min: number): string {
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
