'use client';

/**
 * Live hotels tab — Phase 1 + 2.
 *
 * Sections:
 *   1. Health summary chips
 *   2. Hotels list (12h staleness threshold, problems first)
 *   3. Recent errors (grouped, last 24h)
 *   4. SMS health (per hotel, last 24h)
 *
 * Phase 5 layers on activity / engagement panel; Phase 6 adds the
 * in-app feedback inbox.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  Building2, ChevronRight, WifiOff, Wifi, AlertCircle,
  MessageSquare, ChevronDown,
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
}

interface ErrorGroup {
  source: string | null;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedPropertyIds: string[];
  sampleStack: string | null;
}

interface SmsHealthRow {
  propertyId: string;
  propertyName: string | null;
  sent: number;
  inFlight: number;
  failed: number;
  deliveryPct: number | null;
  topErrors: { message: string; count: number }[];
}

export function LiveHotelsTab() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [errors, setErrors] = useState<ErrorGroup[] | null>(null);
  const [sms, setSms] = useState<SmsHealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [propsRes, errorsRes, smsRes] = await Promise.all([
        fetchWithAuth('/api/admin/list-properties'),
        fetchWithAuth('/api/admin/recent-errors'),
        fetchWithAuth('/api/admin/sms-health'),
      ]);
      const [propsJson, errorsJson, smsJson] = await Promise.all([
        propsRes.json(), errorsRes.json(), smsRes.json(),
      ]);
      if (propsJson.ok) setProps(propsJson.data.properties);
      if (errorsJson.ok) setErrors(errorsJson.data.groups);
      if (smsJson.ok) setSms(smsJson.data.perHotel);
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

  if (!props || !errors || !sms) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  const live = props.filter((p) => p.lastSyncedAt !== null || p.subscriptionStatus === 'active');

  const enriched = live.map((p) => ({
    ...p,
    isStale12h: p.pmsConnected && p.syncFreshnessMin !== null && p.syncFreshnessMin > STALE_THRESHOLD_MIN,
  }));

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

  const summary = {
    total: enriched.length,
    active: enriched.filter((p) => p.subscriptionStatus === 'active').length,
    stale12h: enriched.filter((p) => p.isStale12h).length,
    pastDue: enriched.filter((p) => p.subscriptionStatus === 'past_due').length,
    disconnected: enriched.filter((p) => !p.pmsConnected).length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* 1. Health chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <Chip label="Total" value={summary.total} color="var(--text-secondary)" />
        <Chip label="Active" value={summary.active} color="var(--green)" />
        <Chip label="Stale (12h+)" value={summary.stale12h} color={summary.stale12h > 0 ? 'var(--red)' : 'var(--text-muted)'} />
        <Chip label="Past due" value={summary.pastDue} color={summary.pastDue > 0 ? 'var(--red)' : 'var(--text-muted)'} />
        <Chip label="Disconnected PMS" value={summary.disconnected} color={summary.disconnected > 0 ? 'var(--amber)' : 'var(--text-muted)'} />
      </div>

      {/* 2. Hotels list */}
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div>
            <h2 style={sectionTitle}>Hotels</h2>
            <p style={sectionHint}>Sorted by problems first. Anything not synced in 12h is flagged red.</p>
          </div>
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

      {/* 3. Recent errors grouped */}
      <section>
        <h2 style={sectionTitle}>Recent errors (last 24h)</h2>
        <p style={sectionHint}>Grouped — 100 copies of the same error show as one row.</p>
        {errors.length === 0 ? (
          <EmptyState text="No errors in the last 24 hours ✓" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {errors.map((g, idx) => <ErrorGroupRow key={idx} group={g} />)}
          </div>
        )}
      </section>

      {/* 4. SMS health per hotel */}
      <section>
        <h2 style={sectionTitle}>SMS health (last 24h)</h2>
        <p style={sectionHint}>Per hotel — failures bubble to the top so a broken phone number is never hidden in fleet averages.</p>
        {sms.length === 0 ? (
          <EmptyState text="No SMS activity in the last 24 hours." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {sms.map((h) => <SmsHealthRow key={h.propertyId} row={h} />)}
          </div>
        )}
      </section>

      {/* Phase 5 + 6 placeholder */}
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
        Coming next on this tab: per-hotel GM activity & engagement (Phase 5) • in-app feedback inbox (Phase 6).
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

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

function ErrorGroupRow({ group }: { group: ErrorGroup }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = group.message.length > 120 ? group.message.slice(0, 120) + '…' : group.message;
  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--surface-primary)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        cursor: group.sampleStack ? 'pointer' : 'default',
      }}
      onClick={() => group.sampleStack && setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <AlertCircle size={14} color="var(--red)" style={{ marginTop: '2px', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
            {expanded ? group.message : truncated}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <span>{group.source ?? 'unknown source'}</span>
            <span>{group.count}× · last {formatAge(group.lastSeen)}</span>
            {group.affectedPropertyIds.length > 0 && (
              <span>{group.affectedPropertyIds.length} {group.affectedPropertyIds.length === 1 ? 'hotel' : 'hotels'} affected</span>
            )}
          </div>
        </div>
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
          ×{group.count}
        </span>
        {group.sampleStack && (
          <ChevronDown size={14} color="var(--text-muted)" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
        )}
      </div>
      {expanded && group.sampleStack && (
        <pre style={{
          marginTop: '10px',
          padding: '10px',
          background: 'var(--surface-secondary)',
          borderRadius: '6px',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>{group.sampleStack}</pre>
      )}
    </div>
  );
}

function SmsHealthRow({ row }: { row: SmsHealthRow }) {
  const hasFailures = row.failed > 0;
  return (
    <Link href={`/admin/properties/${row.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{
        padding: '12px 14px',
        background: 'var(--surface-primary)',
        border: `1px solid ${hasFailures ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`,
        borderRadius: '10px',
        display: 'flex', alignItems: 'center', gap: '12px',
      }}>
        <MessageSquare size={14} color={hasFailures ? 'var(--red)' : 'var(--text-muted)'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>
            {row.propertyName ?? '(deleted property)'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <span style={{ color: 'var(--green)' }}>{row.sent} sent</span>
            {row.inFlight > 0 && <span>{row.inFlight} in flight</span>}
            {row.failed > 0 && <span style={{ color: 'var(--red)' }}>{row.failed} failed</span>}
            {row.deliveryPct !== null && (
              <span style={{ color: row.deliveryPct >= 95 ? 'var(--green)' : row.deliveryPct >= 80 ? 'var(--amber)' : 'var(--red)' }}>
                {row.deliveryPct}% delivery
              </span>
            )}
          </div>
          {row.topErrors.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
              {row.topErrors[0].message}{row.topErrors.length > 1 ? ` (+${row.topErrors.length - 1} more)` : ''}
            </div>
          )}
        </div>
        <ChevronRight size={14} color="var(--text-muted)" />
      </div>
    </Link>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: '8px',
      padding: '20px',
      background: 'var(--surface-secondary)',
      border: '1px dashed var(--border)',
      borderRadius: '10px',
      textAlign: 'center',
      fontSize: '12px',
      color: 'var(--text-muted)',
    }}>{text}</div>
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

const sectionTitle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const sectionHint: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
  marginTop: '2px',
  marginBottom: '8px',
};
