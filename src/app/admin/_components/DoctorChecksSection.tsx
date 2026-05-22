'use client';

/**
 * DoctorChecksSection — per-area doctor health card.
 *
 * Drop this on any admin page that wants to surface a subset of the
 * doctor's checks (filtered by name prefix). The global HealthBanner
 * already surfaces FAILING checks on every admin page; this component
 * surfaces the matching subset whether they're passing or not, so
 * Reeyen can confirm the safety net is alive WITHOUT having to wait
 * for it to break.
 *
 * Use cases (deploy-ci-cron Step 7.5):
 *   - /admin/ml      → filterPrefix="ml_"   title="ML service health"
 *   - /admin/pms     → filterPrefix="cua_"  title="Onboarding service health"
 *
 * Auth: relies on requireAdminOrCron in /api/admin/doctor. Caller must
 * already be in an admin-gated page.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

interface DoctorResponse {
  ok: boolean;
  checks: DoctorCheck[];
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'ok')   return <CheckCircle2 size={14} color="#3a8048" />;
  if (status === 'warn') return <AlertTriangle size={14} color="#b85c3d" />;
  if (status === 'fail') return <XCircle size={14} color="#b53d2e" />;
  return <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', background: '#cfcabb' }} />;
}

interface Props {
  /** Match checks whose `name` starts with any of these prefixes (e.g. ['ml_', 'cua_']). */
  filterPrefixes: string[];
  /** Section heading shown above the rows. */
  title: string;
  /** Optional intro paragraph under the title. */
  description?: string;
}

export function DoctorChecksSection({ filterPrefixes, title, description }: Props) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchWithAuth('/api/admin/doctor');
        if (!res.ok && res.status !== 503) {
          // The doctor returns 503 when any check fails — that's still a
          // valid body we want to render. Anything else is an auth or
          // network problem.
          if (!cancelled) {
            setError(`Doctor returned ${res.status}`);
            setLoading(false);
          }
          return;
        }
        const body = (await res.json()) as DoctorResponse;
        if (cancelled) return;
        const matched = (body.checks ?? []).filter(c =>
          filterPrefixes.some(p => c.name.startsWith(p))
        );
        setChecks(matched);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
    // filterPrefixes is an array literal at the call site — stringify to
    // avoid re-firing on every render. Stable list size in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterPrefixes.join('|')]);

  if (loading) {
    return (
      <div style={{ padding: '16px 20px', border: '1px solid #e5e1d7', borderRadius: 14, background: '#fffefb', marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: '#666', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading {title.toLowerCase()}…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: '16px 20px', border: '1px solid #e5d4c8', borderRadius: 14, background: '#fff8f3', marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: '#b85c3d' }}>
          Could not load {title.toLowerCase()}: {error}
        </div>
      </div>
    );
  }
  if (!checks || checks.length === 0) return null;

  return (
    <div style={{
      padding: '16px 20px',
      border: '1px solid #e5e1d7',
      borderRadius: 14,
      background: '#fffefb',
      marginBottom: 20,
      fontFamily: 'var(--font-sans), system-ui, sans-serif',
    }}>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#999', marginBottom: 4 }}>
        {title}
      </div>
      {description && (
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 12px', lineHeight: 1.4 }}>{description}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {checks.map(c => (
          <li key={c.name} style={{
            display: 'grid',
            gridTemplateColumns: '18px 1fr',
            gap: 10,
            alignItems: 'baseline',
            padding: '8px 0',
            borderTop: '1px solid #f0ece2',
          }}>
            <div style={{ paddingTop: 2 }}>
              <StatusIcon status={c.status} />
            </div>
            <div>
              <div style={{ fontSize: 13.5, color: '#222', lineHeight: 1.4 }}>{c.detail}</div>
              {c.fix && c.status !== 'ok' && (
                <div style={{ fontSize: 12, color: '#777', marginTop: 4, lineHeight: 1.4 }}>
                  <strong>Fix:</strong> {c.fix}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
