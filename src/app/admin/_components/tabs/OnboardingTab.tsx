'use client';

/**
 * Onboarding tab — Snow design (May 2026, v4-rewired 2026-05-24).
 *
 *   Onboarding (prospects)    │  Live in-flight sessions  │  Onboarding pipeline  │  PMS coverage
 *   (ProspectsSection)        │  (paused / starting)      │  (5-stage funnel)     │  (learned-only)
 *
 * Plan v4 rewire: the funnel buckets now come from the v4 source-of-truth
 * (`property_sessions.status`) instead of the legacy `onboarding_jobs`
 * table (empty stub post-v4) and `properties.last_synced_at` (not written
 * by anything in v4). See migration 0206 + /api/admin/list-properties rewire.
 *
 * Funnel stages:
 *   Signed up      — properties row, no staff added yet
 *   Wizard done    — staff added, no PMS creds saved
 *   Connecting     — creds saved, session in 'starting' (CUA logging in)
 *   Needs help     — paused_mfa / paused_no_knowledge_file / failed_restart /
 *                    paused_cost_cap (one-click CTAs to resolve)
 *   Live           — session 'alive' (graduates out — shows on Live hotels)
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  CheckCircle2, AlertCircle, Clock, Loader2,
  AlertTriangle, Plus, ShieldAlert,
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
  /** v4: property_sessions.status — drives funnel bucketing. */
  sessionStatus: string | null;
  sessionPausedReason: string | null;
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
  /** Plan v8 — for mapper.* workflow_jobs rows, 'mapper' so the
   *  LiveJobCard links to /admin/properties/mapper/[jobId] (the Live
   *  Mapping console). For session-derived rows, 'session' or absent. */
  kind?: 'session' | 'mapper';
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

  // v4: a hotel is "in onboarding" until its CUA session goes 'alive'.
  // A session in 'alive' state with a recent heartbeat = live; anything
  // else (no session row, starting, paused_*, failed_restart, stopped)
  // stays on this tab. Replaces the old `!lastSyncedAt` check which
  // never flipped because nothing in v4 writes properties.last_synced_at.
  const inOnboarding = props.filter((p) => p.sessionStatus !== 'alive');
  const stages = bucketByStage(inOnboarding);

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

      {/* Column 2: Live in-flight sessions (anything not 'alive'). */}
      <section style={columnStyle}>
        <SectionTitle caps="Live status" title="In-flight" italic="sessions" />
        {liveJobs.length === 0 ? (
          <EmptyState text="Every hotel is alive and polling ✓" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {liveJobs.map((j) => <LiveJobCard key={j.id} job={j} />)}
          </div>
        )}
      </section>

      {/* Column 3: Onboarding pipeline. */}
      <section style={columnStyle}>
        <SectionTitle caps="Pipeline" title="Onboarding" italic="funnel" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <PipelineColumn title="Signed up" hint="Account exists, wizard not done" rows={stages.signedUp} />
          <PipelineColumn title="Wizard done" hint="Staff added, no PMS yet" rows={stages.wizardDone} />
          <PipelineColumn title="Connecting" hint="Creds saved, CUA logging in" rows={stages.connecting} accent={T.caramelDeep} />
          <PipelineColumn
            title="Needs help"
            hint="MFA, unsupported PMS, or login failing — click a row"
            rows={stages.needsHelp}
            accent={T.warm}
            showHelpIcon
          />
        </div>
      </section>

      {/* Column 4: PMS coverage — filtered to learned only */}
      <section style={columnStyle}>
        <SectionTitle
          caps="Coverage"
          title="PMS"
          italic="coverage"
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
  // Plan v8 — mapper.* jobs deep-link into the Live Mapping console
  // (/admin/properties/mapper/[jobId]) so admin can watch + respond to
  // help requests. Session-derived rows keep linking to the property page.
  const href = job.kind === 'mapper'
    ? `/admin/properties/mapper/${job.id}`
    : `/admin/properties/${job.propertyId}`;
  return (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
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

interface PipelineRow {
  id: string;
  name: string | null;
  pmsType: string | null;
  /** Optional CTA — overrides the default /admin/properties/[id] link.
   *  Used by "Needs help" to deep-link to /admin/mfa-resume etc. */
  href?: string;
  /** Optional sub-line (e.g. "Waiting for MFA"). */
  subline?: string;
}

function PipelineColumn({ title, hint, rows, accent, showHelpIcon }: {
  title: string; hint: string;
  rows: PipelineRow[];
  accent?: string;
  showHelpIcon?: boolean;
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
              href={r.href ?? `/admin/properties/${r.id}`}
              style={{
                fontSize: 12.5,
                padding: '6px 10px',
                background: T.ruleSoft,
                borderRadius: 8,
                textDecoration: 'none',
                color: T.ink,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {showHelpIcon && <ShieldAlert size={11} color={accent ?? T.ink2} style={{ flexShrink: 0 }} />}
                  {r.name ?? '(unnamed)'}
                </span>
                {r.pmsType && (
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
                    flexShrink: 0, letterSpacing: '0.04em',
                  }}>
                    {r.pmsType}
                  </span>
                )}
              </div>
              {r.subline && (
                <span style={{ fontSize: 11, color: accent ?? T.ink2, lineHeight: 1.3 }}>
                  {r.subline}
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

/** v4 bucket: drive everything off property_sessions.status. The
 *  legacy onboarding_jobs/last_synced_at signals don't exist in v4. */
function bucketByStage(props: PropertyRow[]) {
  const signedUp: PipelineRow[] = [];
  const wizardDone: PipelineRow[] = [];
  const connecting: PipelineRow[] = [];
  const needsHelp: PipelineRow[] = [];

  for (const p of props) {
    const base: PipelineRow = { id: p.id, name: p.name, pmsType: p.pmsType };

    switch (p.sessionStatus) {
      case 'paused_mfa':
        needsHelp.push({
          ...base,
          href: `/admin/mfa-resume/${p.id}`,
          subline: 'Waiting for MFA — click to resolve.',
        });
        continue;
      case 'paused_no_knowledge_file':
        needsHelp.push({
          ...base,
          href: `/admin/property-sessions`,
          subline: 'Awaiting mapper — PMS not learned.',
        });
        continue;
      case 'paused_cost_cap':
        needsHelp.push({
          ...base,
          href: `/admin/property-sessions`,
          subline: 'Cost cap — auto-resumes at midnight.',
        });
        continue;
      case 'paused_circuit_breaker':
      case 'failed_restart':
        needsHelp.push({
          ...base,
          href: `/admin/property-sessions`,
          subline: p.sessionPausedReason ?? 'Login failing — edit credentials.',
        });
        continue;
      case 'starting':
        connecting.push({
          ...base,
          subline: 'CUA logging in…',
        });
        continue;
      case 'stopped':
        // Stopped is an admin action — surface in Needs help with
        // restart hint, not in the funnel proper.
        needsHelp.push({
          ...base,
          href: `/admin/property-sessions`,
          subline: 'Stopped — click to restart.',
        });
        continue;
    }

    // No session row → still pre-creds.
    if (p.pmsConnected) {
      // Defensive fallback (shouldn't happen post-0206): creds saved
      // but no session row. Treat as connecting.
      connecting.push({ ...base, subline: 'Creds saved, awaiting session.' });
    } else if (p.staffCount > 0) {
      wizardDone.push(base);
    } else {
      signedUp.push(base);
    }
  }
  return { signedUp, wizardDone, connecting, needsHelp };
}
