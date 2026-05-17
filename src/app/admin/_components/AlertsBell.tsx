'use client';

/**
 * Alerts bell — sticky-header right-side icon (Snow design).
 *
 * Surfaces "stuff that needs Reeyen's attention right now" without him
 * having to walk through every tab.
 *
 * Fetches /api/admin/alerts on mount + every 30s. Shows a warm badge
 * if there's a red alert, caramel if only amber alerts. Click opens a
 * dropdown listing each alert with severity, title, detail, and a
 * jump-to link when one is available.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Bell, X, ChevronRight } from 'lucide-react';
import { T, FONT_MONO, FONT_SANS, Caps } from './_snow';

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
    ? T.warm
    : (data?.counts.amber ?? 0) > 0 ? T.caramelDeep : null;

  return (
    <div style={{ position: 'relative' }}>
      <button
        aria-label={`Alerts (${data?.counts.total ?? 0})`}
        title={data?.counts.total ? `${data.counts.total} alert${data.counts.total === 1 ? '' : 's'}` : 'No alerts'}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 38, height: 38,
          borderRadius: 999,
          border: `1px solid ${T.rule}`,
          background: open ? T.ruleSoft : 'transparent',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}
      >
        <Bell size={16} color={badgeColor ?? T.ink2} />
        {(data?.counts.total ?? 0) > 0 && (
          <span style={{
            position: 'absolute',
            top: '-2px',
            right: '-2px',
            minWidth: '18px',
            height: '18px',
            padding: '0 5px',
            borderRadius: 999,
            background: badgeColor ?? T.ink2,
            color: '#fff',
            fontSize: 10,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT_MONO,
            border: '2px solid #fff',
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
            top: 'calc(100% + 10px)',
            width: '400px',
            maxHeight: '70vh',
            overflowY: 'auto',
            background: T.paper,
            border: `1px solid ${T.rule}`,
            borderRadius: 18,
            zIndex: 50,
            boxShadow: '0 24px 48px -16px rgba(31,35,28,0.18)',
            fontFamily: FONT_SANS,
          }}>
            <div style={{
              padding: '14px 18px',
              borderBottom: `1px solid ${T.rule}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <Caps>
                {data && data.counts.total > 0
                  ? `${data.counts.total} ${data.counts.total === 1 ? 'alert' : 'alerts'}`
                  : 'Alerts'}
              </Caps>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close alerts"
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  display: 'flex', padding: 4, color: T.ink3,
                }}
              >
                <X size={14} />
              </button>
            </div>

            {!data ? (
              <div style={{ padding: '20px', textAlign: 'center' }}>
                <div className="spinner" style={{ width: '18px', height: '18px', margin: '0 auto' }} />
              </div>
            ) : data.alerts.length === 0 ? (
              <div style={{
                padding: '28px 16px',
                textAlign: 'center',
                fontSize: 13,
                color: T.ink2,
              }}>
                Nothing needs your attention <span style={{ color: T.sageDeep }}>✓</span>
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
  const dotColor = alert.severity === 'red' ? T.warm : T.caramelDeep;
  const inner = (
    <div style={{
      padding: '14px 18px',
      borderBottom: `1px solid ${T.rule}`,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      cursor: alert.href ? 'pointer' : 'default',
    }}>
      <span style={{ marginTop: 6, width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
          {alert.title}
        </div>
        <p style={{ fontSize: 12, color: T.ink2, marginTop: 3, lineHeight: 1.5 }}>
          {alert.detail}
        </p>
        <p style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, marginTop: 6, letterSpacing: '0.04em' }}>
          {formatAge(alert.ts)}
        </p>
      </div>
      {alert.href && <ChevronRight size={14} color={T.ink3} style={{ marginTop: 4, flexShrink: 0 }} />}
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
