'use client';

/**
 * Onboarding tab — 4-column horizontal layout.
 *
 *   Onboarding (prospects)    │  CUA agent learning PMS  │  Onboarding pipeline  │  PMS coverage
 *   (ProspectsSection)        │  (live mapping jobs)     │  (4-stage funnel)     │  (learned-only)
 *
 * The Recent sign-ups list that used to live below was removed — the
 * Onboarding pipeline already surfaces the same hotels.
 *
 * PMS coverage is filtered to PMSes the agent has actually learned
 * (recipe.coveragePct > 0). PMSes with zero progress are hidden — they
 * just clutter the list when we have one customer.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  CheckCircle2, AlertCircle, Clock, Loader2,
  AlertTriangle, Plus,
} from 'lucide-react';
import { ProspectsSection } from '@/app/admin/_components/ProspectsSection';
import { CreateHotelModal } from '@/app/admin/_components/CreateHotelModal';

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
  const [createOpen, setCreateOpen] = useState(false);
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

  // PMS coverage filter: only show PMSes the agent has actually learned.
  // The full registry (all supported PMSes including never-touched ones)
  // is still available behind the "Show technical details" link.
  const learnedPms = pms.filter((p) => p.recipe !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Phase M1 (2026-05-14) — primary CTA: start onboarding a new hotel.
          Lives at the top of THIS tab (not Live Hotels) because hotels
          enter the system here, then graduate to Live Hotels once their
          first PMS sync completes. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '12px', padding: '16px 20px',
        background: 'var(--surface-primary)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '2px' }}>
            Onboard a new hotel
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Creates the property, generates a single-use owner signup link valid for 7 days, and surfaces it for you to send.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="btn btn-primary"
          style={{
            padding: '10px 16px', fontSize: '13px', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
          }}
        >
          <Plus size={14} /> New hotel
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '20px',
        alignItems: 'start',
      }}>

      {/* Column 1: Onboarding (sales pipeline) */}
      <ProspectsSection />

      {/* Column 2: CUA agent learning PMS */}
      <section style={columnStyle}>
        <h2 style={sectionTitle}>CUA agent learning PMS</h2>
        {liveJobs.length === 0 ? (
          <EmptyState text="Nothing mapping right now ✓" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {liveJobs.map((j) => <LiveJobCard key={j.id} job={j} />)}
          </div>
        )}
      </section>

      {/* Column 3: Onboarding pipeline.
          Keep the 4 sub-buckets but flow them vertically within the column
          so they fit the narrower width. */}
      <section style={columnStyle}>
        <h2 style={sectionTitle}>Onboarding pipeline</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          <PipelineColumn title="Signed up" hint="Account exists, wizard not done" rows={stages.signedUp} />
          <PipelineColumn title="Wizard done" hint="Staff added, no PMS yet" rows={stages.wizardDone} />
          <PipelineColumn title="PMS connected" hint="Creds saved, not mapped" rows={stages.pmsConnected} />
          <PipelineColumn title="Mapping" hint="Agent is learning right now" rows={stages.mapping} accent="var(--amber)" />
        </div>
      </section>

      {/* Column 4: PMS coverage — filtered to learned only */}
      <section style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
          <h2 style={sectionTitle}>PMS coverage</h2>
          <Link href="/admin/pms" style={{ fontSize: '11px', color: 'var(--text-muted)', textDecoration: 'none' }}>
            details →
          </Link>
        </div>
        {learnedPms.length === 0 ? (
          <EmptyState text="No PMSes learned yet. First hotel onboarding will populate this list." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {learnedPms.map((p) => <PMSRow key={p.pmsType} pms={p} />)}
          </div>
        )}
      </section>

      </div>

      <CreateHotelModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { void load(); }}
      />
    </div>
  );
}

const columnStyle: React.CSSProperties = {
  minWidth: 0, // critical for grid children so long names don't overflow
};

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

const sectionTitle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  marginBottom: '4px',
};
