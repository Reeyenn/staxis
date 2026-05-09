'use client';

/**
 * Alerts bell — sticky-header right-side icon that surfaces
 * "stuff that needs Reeyen's attention right now" without him having
 * to walk through every tab.
 *
 * Fetches /api/admin/alerts on mount + every 30s. Shows a red badge
 * if there's a red alert, amber if only amber alerts. Click opens
 * a dropdown listing each alert with severity, title, detail, and a
 * jump-to link when one is available.
 *
 * Wired into StickyHeader.tsx; replaced the inert <Bell> placeholder
 * that landed in Phase 1.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Bell, X, ChevronRight } from 'lucide-react';

type Severity = 'red' | 'amber';

interface Alert {
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  propertyId: string | null;
  href: string | null;
  ts: string;
}

interface AlertsResp {
  counts: { total: number; red: number; amber: number };
  alerts: Alert[];
}

export function AlertsBell() {
  const [data, setData] = useState<AlertsResp | null>(null);
  const [open, setOpen] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/alerts');
      const json = await res.json();
      if (res.ok && json.ok) setData(json.data);
    } catch {
      // Silent — bell keeps showing last-known until next tick.
    }
  };

  useEffect(() => {
    void load();
    const tick = () => {
      refreshTimer.current = setTimeout(async () => {
        await load();
        tick();
      }, 30_000);
    };
    tick();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const badgeColor = (data?.counts.red ?? 0) > 0
    ? 'var(--red)'
    : (data?.counts.amber ?? 0) > 0 ? 'var(--amber)' : null;

  return (
    <div style={{ position: 'relative' }}>
      <button
        aria-label={`Alerts (${data?.counts.total ?? 0})`}
        title={data?.counts.total ? `${data.counts.total} alert${data.counts.total === 1 ? '' : 's'}` : 'No alerts'}
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '6px',
          borderRadius: '8px',
          border: 'none',
          background: open ? 'var(--surface-secondary)' : 'transparent',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}
      >
        <Bell size={18} color={badgeColor ?? 'var(--text-muted)'} />
        {(data?.counts.total ?? 0) > 0 && (
          <span style={{
            position: 'absolute',
            top: '2px',
            right: '2px',
            minWidth: '16px',
            height: '16px',
            padding: '0 4px',
            borderRadius: '8px',
            background: badgeColor ?? 'var(--text-muted)',
            color: 'white',
            fontSize: '10px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
          }}>{data!.counts.total}</span>
        )}
      </button>

      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 48 }}
            onClick={() => setOpen(false)}
          />
          <div style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: '380px',
            maxHeight: '70vh',
            overflowY: 'auto',
            background: '#ffffff',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            zIndex: 50,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <strong style={{ fontSize: '13px' }}>
                {data && data.counts.total > 0
                  ? `${data.counts.total} ${data.counts.total === 1 ? 'alert' : 'alerts'}`
                  : 'Alerts'}
              </strong>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close alerts"
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  display: 'flex', padding: '4px',
                }}
              >
                <X size={14} color="var(--text-muted)" />
              </button>
            </div>

            {!data ? (
              <div style={{ padding: '20px', textAlign: 'center' }}>
                <div className="spinner" style={{ width: '18px', height: '18px', margin: '0 auto' }} />
              </div>
            ) : data.alerts.length === 0 ? (
              <div style={{
                padding: '24px 16px',
                textAlign: 'center',
                fontSize: '13px',
                color: 'var(--text-muted)',
              }}>
                Nothing needs your attention ✓
              </div>
            ) : (
              <div>
                {data.alerts.map((a, idx) => (
                  <AlertRow key={idx} alert={a} onClickThrough={() => setOpen(false)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AlertRow({ alert, onClickThrough }: { alert: Alert; onClickThrough: () => void }) {
  const dotColor = alert.severity === 'red' ? 'var(--red)' : 'var(--amber)';
  const inner = (
    <div style={{
      padding: '12px 16px',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      cursor: alert.href ? 'pointer' : 'default',
    }}>
      <span style={{ marginTop: '5px', width: '8px', height: '8px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {alert.title}
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>
          {alert.detail}
        </p>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', opacity: 0.7 }}>
          {formatAge(alert.ts)}
        </p>
      </div>
      {alert.href && <ChevronRight size={14} color="var(--text-muted)" style={{ marginTop: '4px', flexShrink: 0 }} />}
    </div>
  );

  if (alert.href) {
    return (
      <Link
        href={alert.href}
        onClick={onClickThrough}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        {inner}
      </Link>
    );
  }
  return inner;
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
