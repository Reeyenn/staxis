'use client';

/**
 * Onboarding tab — Snow design (May 2026).
 *
 *   Onboarding (prospects)    │  CUA agent learning PMS  │  Onboarding pipeline  │  PMS coverage
 *   (ProspectsSection)        │  (live mapping jobs)     │  (4-stage funnel)     │  (learned-only)
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
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Card, Btn, Pill,
} from '@/app/admin/_components/_snow';

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
    return <ErrorRow text={error} />;
  }

  if (!props || !liveJobs || !pms) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
      </div>
    );
  }

  // Hotels that are ALREADY live (synced + connected) don't show on this
  // tab; they belong on Live hotels. We only surface in-flight onboardings.
  const inOnboarding = props.filter((p) => !p.lastSyncedAt);
  const stages = bucketByStage(inOnboarding, liveJobs);

  // PMS coverage filter: only show PMSes the agent has actually learned.
  const learnedPms = pms.filter((p) => p.recipe !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: FONT_SANS }}>

      {/* Primary CTA: start onboarding a new hotel. */}
      <Card padding="20px 24px" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Caps>New hotel</Caps>
          <h2 style={{
            fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 4px',
            lineHeight: 1.15,
          }}>
            <span style={{ fontStyle: 'italic' }}>Onboard</span> a new hotel
          </h2>
          <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5 }}>
            Creates the property, generates a single-use owner signup link valid for 7 days,
            and surfaces it for you to send.
          </p>
        </div>
        <Btn variant="primary" size="lg" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> New hotel
        </Btn>
      </Card>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 18,
        alignItems: 'start',
      }}>

      {/* Column 1: Onboarding (sales pipeline) */}
      <ProspectsSection />

      {/* Column 2: CUA agent learning PMS */}
      <section style={columnStyle}>
        <SectionTitle caps="Live mapping" title="CUA agent" italic="learning PMS" />
        {liveJobs.length === 0 ? (
          <EmptyState text="Nothing mapping right now ✓" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {liveJobs.map((j) => <LiveJobCard key={j.id} job={j} />)}
          </div>
        )}
      </section>

      {/* Column 3: Onboarding pipeline */}
      <section style={columnStyle}>
        <SectionTitle caps="Pipeline" title="Onboarding" italic="funnel" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <PipelineColumn title="Signed up" hint="Account exists, wizard not done" rows={stages.signedUp} />
          <PipelineColumn title="Wizard done" hint="Staff added, no PMS yet" rows={stages.wizardDone} />
          <PipelineColumn title="PMS connected" hint="Creds saved, not mapped" rows={stages.pmsConnected} />
          <PipelineColumn title="Mapping" hint="Agent is learning right now" rows={stages.mapping} accent={T.caramelDeep} />
        </div>
      </section>

      {/* Column 4: PMS coverage — filtered to learned only */}
      <section style={columnStyle}>
        <SectionTitle
          caps="Coverage"
          title="PMS"
          italic="coverage"
          right={
            <Link href="/admin/pms" style={{
              fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
              textDecoration: 'none', letterSpacing: '0.16em', textTransform: 'uppercase',
            }}>
              details →
            </Link>
          }
        />
        {learnedPms.length === 0 ? (
          <EmptyState text="No PMSes learned yet. First hotel onboarding will populate this list." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
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
  minWidth: 0,
};

// ── Sub-components ─────────────────────────────────────────────────────

function SectionTitle({ caps, title, italic, right }: {
  caps: string; title: string; italic?: string; right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 12, marginBottom: 4,
    }}>
      <div>
        <Caps>{caps}</Caps>
        <h2 style={{
          fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
          lineHeight: 1.15,
        }}>
          {title}
          {italic && <> <span style={{ fontStyle: 'italic' }}>{italic}</span></>}
        </h2>
      </div>
      {right}
    </div>
  );
}

function LiveJobCard({ job }: { job: JobRow }) {
  return (
    <Link href={`/admin/properties/${job.propertyId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card padding="14px 16px" style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Loader2 size={14} color={T.caramelDeep} style={{ animation: 'spin 1.5s linear infinite' }} />
          <strong style={{ fontSize: 13, color: T.ink, letterSpacing: '-0.005em' }}>
            {job.propertyName ?? '(deleted)'}
          </strong>
          <Pill tone="neutral" style={{ height: 20, fontSize: 10, fontFamily: FONT_MONO, letterSpacing: '0.04em' }}>
            {job.pmsType}
          </Pill>
          <Pill tone="caramel" style={{ marginLeft: 'auto', height: 20, fontSize: 10, letterSpacing: '0.06em' }}>
            {job.status.toUpperCase()}
          </Pill>
        </div>
        <div style={{
          fontSize: 12, color: T.ink2, display: 'flex',
          justifyContent: 'space-between', marginBottom: 6,
        }}>
          <span>{job.step ?? 'Working…'}</span>
          {job.progressPct != null && (
            <span style={{ fontFamily: FONT_MONO, color: T.caramelDeep, fontWeight: 600 }}>
              {job.progressPct}%
            </span>
          )}
        </div>
        <div style={{ height: 3, background: T.ruleSoft, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.max(0, Math.min(100, job.progressPct ?? 0))}%`,
            height: '100%',
            background: T.caramel,
            transition: 'width 0.3s',
          }} />
        </div>
      </Card>
    </Link>
  );
}

function PipelineColumn({ title, hint, rows, accent }: {
  title: string; hint: string;
  rows: { id: string; name: string | null; pmsType: string | null }[];
  accent?: string;
}) {
  return (
    <Card padding="14px">
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600,
        color: accent ?? T.ink, textTransform: 'uppercase', letterSpacing: '0.16em',
        marginBottom: 2,
      }}>
        {title}
        <span style={{ marginLeft: 6, fontWeight: 400, color: T.ink3 }}>
          · {rows.length}
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: T.ink2, marginBottom: 10, lineHeight: 1.45 }}>
        {hint}
      </p>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: T.ink3, fontStyle: 'italic' }}>—</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/admin/properties/${r.id}`}
              style={{
                fontSize: 12.5,
                padding: '6px 10px',
                background: T.ruleSoft,
                borderRadius: 8,
                textDecoration: 'none',
                color: T.ink,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name ?? '(unnamed)'}
              </span>
              {r.pmsType && (
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
                  flexShrink: 0, marginLeft: 6, letterSpacing: '0.04em',
                }}>
                  {r.pmsType}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function PMSRow({ pms }: { pms: PMSCoverage }) {
  const fully = !!pms.recipe && pms.recipe.coveragePct === 100;
  const partial = !!pms.recipe && pms.recipe.coveragePct < 100;
  const failed = !pms.recipe && pms.latestJob?.status === 'failed';

  let icon, color, status;
  if (fully) {
    icon = <CheckCircle2 size={16} color={T.sageDeep} />;
    color = T.sageDeep;
    status = 'Ready. Future hotels onboard free.';
  } else if (partial) {
    icon = <AlertCircle size={16} color={T.caramelDeep} />;
    color = T.caramelDeep;
    status = `Partial — ${pms.recipe!.coveragePct}% of actions captured.`;
  } else if (failed) {
    icon = <AlertTriangle size={16} color={T.warm} />;
    color = T.warm;
    status = 'Last mapping failed. First hotel will retry.';
  } else {
    icon = <Clock size={16} color={T.ink3} />;
    color = T.ink2;
    status = 'Not learned yet. First hotel triggers ~$0.50, ~7 min mapping.';
  }

  return (
    <Card padding="14px 16px" style={{
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
          {pms.label}
        </div>
        <div style={{ fontSize: 12, color, marginTop: 3, lineHeight: 1.4 }}>
          {status}
        </div>
      </div>
      <span style={{
        fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
        flexShrink: 0, letterSpacing: '0.04em',
      }}>
        {pms.propertyCount} {pms.propertyCount === 1 ? 'hotel' : 'hotels'}
      </span>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 8,
      padding: '24px 20px',
      background: T.ruleSoft,
      border: `1px dashed ${T.rule}`,
      borderRadius: 14,
      textAlign: 'center',
      fontSize: 12.5,
      color: T.ink2,
      fontStyle: 'italic',
      fontFamily: FONT_SERIF,
    }}>{text}</div>
  );
}

function ErrorRow({ text }: { text: string }) {
  return (
    <div style={{
      padding: '14px 16px',
      background: T.warmDim,
      border: `1px solid rgba(184,92,61,0.25)`,
      borderRadius: 14,
      color: T.warm, fontSize: 13,
      fontFamily: FONT_SANS,
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
