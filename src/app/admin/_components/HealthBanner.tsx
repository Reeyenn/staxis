'use client';

/**
 * Health banner shown above the admin StickyHeader.
 *
 * Polls /api/admin/doctor every 60 seconds. If any check has
 * status='fail', renders a warm-toned banner listing them with their
 * suggested fixes. Hidden when everything is green/warn.
 *
 * The intent is "you don't have to remember to check the doctor page —
 * if something's red, the admin home page will tell you the moment you
 * land." Reeyen specifically asked for this because, as a non-technical
 * founder, he might not catch silent failures otherwise.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AlertTriangle, X } from 'lucide-react';
import { T, FONT_MONO, FONT_SANS, Caps } from './_snow';

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  fix?: string;
}

interface DoctorResponse {
  ok: boolean;
  summary: { total: number; ok: number; warn: number; fail: number; skipped: number };
  checks: DoctorCheck[];
}

const POLL_MS = 60_000;

export function HealthBanner() {
  const [failing, setFailing] = useState<DoctorCheck[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchWithAuth('/api/admin/doctor');
        if (!res.ok) return;
        const body = (await res.json()) as DoctorResponse;
        if (cancelled) return;
        setFailing(body.checks?.filter(c => c.status === 'fail') ?? []);
      } catch {
        // Silent: a doctor outage is a separate problem from the things it monitors.
      }
    };
    void load();
    const handle = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  const visible = failing.filter(c => !dismissed.has(c.name));

  if (visible.length === 0) return null;

  return (
    <div style={{
      marginBottom: '16px',
      borderRadius: 18,
      border: `1px solid ${T.warmDim}`,
      background: 'rgba(184,92,61,0.04)',
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      fontFamily: FONT_SANS,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.warm }}>
        <AlertTriangle size={16} />
        <Caps c={T.warm}>
          {visible.length} system check{visible.length === 1 ? '' : 's'} failing
        </Caps>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.map(check => (
          <div key={check.name} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '8px 0 0',
            borderTop: `1px solid ${T.warmDim}`,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 500, color: T.ink }}>
                {check.name}
              </div>
              <div style={{ fontSize: 13, color: T.ink2, marginTop: 3, lineHeight: 1.5 }}>
                {check.detail}
              </div>
              {check.fix && (
                <div style={{ fontSize: 12, color: T.ink3, marginTop: 6, fontStyle: 'italic' }}>
                  Fix: {check.fix}
                </div>
              )}
            </div>
            <button
              onClick={() => setDismissed(prev => new Set(prev).add(check.name))}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                color: T.ink3,
                flexShrink: 0,
              }}
              title="Hide this for the rest of this session"
              aria-label={`Dismiss ${check.name}`}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
