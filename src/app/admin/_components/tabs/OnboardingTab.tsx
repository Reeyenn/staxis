'use client';

/**
 * Onboarding tab — everything about getting a hotel set up, from sales
 * lead through first sync.
 *
 * Sections (top → bottom):
 *   1. Live mapping — running CUA jobs, auto-refresh every 5s
 *   2. Onboarding pipeline — 4 buckets showing where each new hotel is
 *      stuck (Signed up → Wizard done → PMS connected → Mapping)
 *   3. PMS coverage (plain English) — replaces the technical jargon
 *      with green/amber/red status per supported PMS
 *   4. Recent sign-ups — last 24h
 *
 * Phase 1 uses existing APIs only. Phase 4 adds the "Soon to be onboarded"
 * sales-pipeline section + per-hotel launch checklist on top.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  CheckCircle2, AlertCircle, Clock, Loader2, ChevronRight,
  Layers, ArrowRight, AlertTriangle,
} from 'lucide-react';
import { ProspectsSection } from '@/app/admin/_components/ProspectsSection';

const RUNNING = new Set(['queued', 'running', 'mapping', 'extracting']);

interface PropertyRow {
  id: string;
  name: string | null;
  pmsType: string | null;
  pmsConnected: boolean;
  lastSyncedAt: string | null;
  staffCount: number;
  createdAt: string;
  latestJob: {
    id: string; status: string | null; step: string | null;
    progressPct: number | null; error: string | null; createdAt: string;
  } | null;
}

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
}

interface PMSCoverage {
  pmsType: string;
  label: string;
  hint: string;
  tier: 1 | 2 | 3;
  recipe: { coveragePct: number; version: number; createdAt: string } | null;
  propertyCount: number;
  latestJob: { status: string; error: string | null; createdAt: string } | null;
}

export function OnboardingTab() {
  const [props, setProps] = useState<PropertyRow[] | null>(null);
  const [liveJobs, setLiveJobs] = useState<JobRow[] | null>(null);
  const [pms, setPms] = useState<PMSCoverage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const [propsRes, jobsRes, pmsRes] = await Promise.all([
        fetchWithAuth('/api/admin/list-properties'),
        fetchWithAuth('/api/admin/onboarding-jobs?live=1'),
        fetchWithAuth('/api/admin/pms-coverage'),
      ]);
      const [propsJson, jobsJson, pmsJson] = await Promise.all([
        propsRes.json(), jobsRes.json(), pmsRes.json(),
      ]);
      if (propsJson.ok) setProps(propsJson.data.properties);
      if (jobsJson.ok) setLiveJobs(jobsJson.data.jobs);
      if (pmsJson.ok) setPms(pmsJson.data.pmsTypes);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Auto-refresh while there are live jobs.
  useEffect(() => {
    if (!liveJobs) return;
    if (liveJobs.length === 0) return;
    refreshTimer.current = setTimeout(() => { void load(); }, 5000);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [liveJobs]);

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

  if (!props || !liveJobs || !pms) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  // ── Bucket properties by onboarding stage ─────────────────────────────
  // Hotels that are ALREADY live (synced + connected) don't show on this
  // tab; they belong on Live hotels. We only surface in-flight onboardings.
  const inOnboarding = props.filter((p) => !p.lastSyncedAt);
  const stages = bucketByStage(inOnboarding, liveJobs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* 0. Sales pipeline (Phase 4) */}
      <ProspectsSection />

      {/* 1. Live mapping */}
      <section>
        <h2 style={sectionTitle}>Live mapping</h2>
        <p style={sectionHint}>The CUA agent learning a PMS in real time.</p>
        {liveJobs.length === 0 ? (
          <EmptyState text="Nothing mapping right now ✓" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {liveJobs.map((j) => <LiveJobCard key={j.id} job={j} />)}
          </div>
        )}
      </section>

      {/* 2. Pipeline */}
      <section>
        <h2 style={sectionTitle}>Onboarding pipeline</h2>
        <p style={sectionHint}>Where each new hotel is stuck. Click any to see detail.</p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: '8px',
          marginTop: '12px',
        }}>
          <PipelineColumn title="Signed up" hint="Account exists, wizard not done" rows={stages.signedUp} />
          <PipelineColumn title="Wizard done" hint="Staff added, no PMS yet" rows={stages.wizardDone} />
          <PipelineColumn title="PMS connected" hint="Creds saved, not mapped" rows={stages.pmsConnected} />
          <PipelineColumn title="Mapping" hint="Agent is learning right now" rows={stages.mapping} accent="var(--amber)" />
        </div>
      </section>

      {/* 3. PMS coverage in plain English */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={sectionTitle}>PMS coverage</h2>
            <p style={sectionHint}>Which PMSes the agent has learned. Mapped = future hotels onboard free.</p>
          </div>
          <Link href="/admin/pms" style={{ fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'none' }}>
            Show technical details →
          </Link>
        </div>
        <div style={{
          marginTop: '12px',
          display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          {pms.map((p) => <PMSRow key={p.pmsType} pms={p} />)}
        </div>
      </section>

      {/* 4. Recent sign-ups */}
      <section>
        <h2 style={sectionTitle}>Recent sign-ups (last 24h)</h2>
        <RecentSignupsList properties={props} />
      </section>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function LiveJobCard({ job }: { job: JobRow }) {
  return (
    <Link href={`/admin/properties/${job.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{
        padding: '12px 14px',
        background: 'var(--surface-primary)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        cursor: 'pointer',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <Loader2 size={14} color="var(--amber)" style={{ animation: 'spin 1.5s linear infinite' }} />
          <strong style={{ fontSize: '13px' }}>{job.propertyName ?? '(deleted)'}</strong>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '2px 6px', background: 'var(--surface-secondary)', borderRadius: '4px' }}>
            {job.pmsType}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--amber)', fontWeight: 600 }}>
            {job.status.toUpperCase()}
          </span>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span>{job.step ?? 'Working…'}</span>
          {job.progressPct != null && <span>{job.progressPct}%</span>}
        </div>
        <div style={{ height: '3px', background: 'var(--surface-secondary)', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{
            width: `${Math.max(0, Math.min(100, job.progressPct ?? 0))}%`,
            height: '100%',
            background: 'var(--amber)',
            transition: 'width 0.3s',
          }} />
        </div>
      </div>
    </Link>
  );
}

function PipelineColumn({ title, hint, rows, accent }: {
  title: string; hint: string;
  rows: { id: string; name: string | null; pmsType: string | null }[];
  accent?: string;
}) {
  return (
    <div style={{
      padding: '12px',
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      minHeight: '80px',
    }}>
      <div style={{ fontSize: '12px', fontWeight: 700, color: accent ?? 'var(--text-primary)', marginBottom: '2px' }}>
        {title} <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 400, opacity: 0.6 }}>· {rows.length}</span>
      </div>
      <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.4 }}>{hint}</p>
      {rows.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', opacity: 0.5 }}>—</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/admin/properties/${r.id}`}
              style={{
                fontSize: '12px',
                padding: '6px 8px',
                background: 'var(--surface-secondary)',
                borderRadius: '6px',
                textDecoration: 'none',
                color: 'var(--text-primary)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name ?? '(unnamed)'}
              </span>
              {r.pmsType && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0, marginLeft: '6px' }}>
                  {r.pmsType}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function PMSRow({ pms }: { pms: PMSCoverage }) {
  const fully = !!pms.recipe && pms.recipe.coveragePct === 100;
  const partial = !!pms.recipe && pms.recipe.coveragePct < 100;
  const failed = !pms.recipe && pms.latestJob?.status === 'failed';

  let icon, color, status;
  if (fully) {
    icon = <CheckCircle2 size={16} color="var(--green)" />;
    color = 'var(--green)';
    status = 'Ready. Future hotels onboard free.';
  } else if (partial) {
    icon = <AlertCircle size={16} color="var(--amber)" />;
    color = 'var(--amber)';
    status = `Partial — ${pms.recipe!.coveragePct}% of actions captured.`;
  } else if (failed) {
    icon = <AlertTriangle size={16} color="var(--red)" />;
    color = 'var(--red)';
    status = 'Last mapping failed. First hotel will retry.';
  } else {
    icon = <Clock size={16} color="var(--text-muted)" />;
    color = 'var(--text-muted)';
    status = 'Not learned yet. First hotel triggers ~$0.50, ~7 min mapping.';
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '12px 14px',
      background: 'var(--surface-primary)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
    }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>{pms.label}</div>
        <div style={{ fontSize: '12px', color, marginTop: '2px' }}>{status}</div>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
        {pms.propertyCount} {pms.propertyCount === 1 ? 'hotel' : 'hotels'}
      </div>
    </div>
  );
}

function RecentSignupsList({ properties }: { properties: PropertyRow[] }) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = properties.filter((p) => Date.parse(p.createdAt) >= cutoff);
  if (recent.length === 0) {
    return <EmptyState text="No new sign-ups in the last 24 hours." />;
  }
  return (
    <div style={{
      marginTop: '8px',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      overflow: 'hidden',
      background: 'var(--surface-primary)',
    }}>
      {recent.map((p, idx) => (
        <Link
          key={p.id}
          href={`/admin/properties/${p.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: idx < recent.length - 1 ? '1px solid var(--border)' : 'none',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600 }}>{p.name ?? '(unnamed)'}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Joined {formatAge(p.createdAt)} · {p.staffCount} staff added · {p.pmsType ?? 'no PMS yet'}
            </div>
          </div>
          <ChevronRight size={14} color="var(--text-muted)" />
        </Link>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
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

// ── Helpers ────────────────────────────────────────────────────────────

function bucketByStage(props: PropertyRow[], liveJobs: JobRow[]) {
  const liveJobByPropertyId = new Map(liveJobs.map((j) => [j.propertyId, j]));

  const signedUp: PropertyRow[] = [];
  const wizardDone: PropertyRow[] = [];
  const pmsConnected: PropertyRow[] = [];
  const mapping: PropertyRow[] = [];

  for (const p of props) {
    if (liveJobByPropertyId.has(p.id)) {
      mapping.push(p);
    } else if (p.pmsConnected) {
      pmsConnected.push(p);
    } else if (p.staffCount > 0) {
      wizardDone.push(p);
    } else {
      signedUp.push(p);
    }
  }
  return { signedUp, wizardDone, pmsConnected, mapping };
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
