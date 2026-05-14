'use client';

/**
 * Health banner shown above the admin StickyHeader.
 *
 * Polls /api/admin/doctor every 60 seconds. If any check has
 * status='fail', renders a red banner listing them with their
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
        // If we can't reach the doctor, the rest of the admin page will probably also be unhappy.
      }
    };
    void load();
    const handle = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  // Filter out any failing checks the user has dismissed in this session.
  // Re-rendering with new "name"s automatically re-shows them.
  const visible = failing.filter(c => !dismissed.has(c.name));

  if (visible.length === 0) return null;

  return (
    <div style={{
      marginBottom: '16px',
      borderRadius: '8px',
      border: '1px solid rgba(220, 53, 69, 0.30)',
      background: 'rgba(220, 53, 69, 0.06)',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red, #dc3545)' }}>
        <AlertTriangle size={16} />
        <strong style={{ fontSize: 13 }}>
          {visible.length} system check{visible.length === 1 ? '' : 's'} failing
        </strong>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map(check => (
          <div key={check.name} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '6px 0',
            borderTop: '1px solid rgba(220, 53, 69, 0.15)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>
                {check.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {check.detail}
              </div>
              {check.fix && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
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
                color: 'var(--text-muted)',
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
