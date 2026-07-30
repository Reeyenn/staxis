'use client';


export const dynamic = 'force-dynamic';
/**
 * /admin/properties/[id] — single property triage view.
 *
 * Shows everything Reeyen needs to debug what's going on with a
 * property: subscription state, PMS connection, active recipe,
 * recent onboarding jobs (with errors), staff sample, owner info.
 *
 * Action: "Regenerate recipe" — POST /api/admin/regenerate-recipe.
 * Used when a PMS UI change has broken the active recipe and we
 * want to force a fresh CUA mapping run.
 */

import React, { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  ArrowLeft, RefreshCw,
  ShieldAlert, Loader2, Activity, FileText,
} from 'lucide-react';
import { JoinCodesSection } from '@/app/admin/_components/JoinCodesSection';
import { MlHealthPanel } from '@/app/admin/_components/MlHealthPanel';
import { AdminEffectiveAccess } from '@/app/admin/_components/AdminEffectiveAccess';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Btn, Pill } from '@/app/admin/_components/_snow';

interface HealthData {
  property: {
    id: string;
    name: string | null;
    totalRooms: number | null;
    subscriptionStatus: string | null;
    trialEndsAt: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    servicesEnabled: Record<string, boolean> | null;
    propertyKind: string | null;
    onboardingSource: string | null;
    pmsType: string | null;
    pmsConnected: boolean | null;
    lastSyncedAt: string | null;
    timezone: string | null;
    createdAt: string;
  };
  credentials: {
    pmsType: string;
    loginUrl: string | null;
    username: string | null;
    isActive: boolean;
    scraperInstance: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  activeRecipe: {
    id: string;
    version: number;
    status: string;
    learned_by_property_id: string | null;
    notes: string | null;
    created_at: string;
  } | null;
  jobs: Array<{
    id: string;
    status: string;
    step: string | null;
    progress_pct: number;
    error: string | null;
    recipe_id: string | null;
    worker_id: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  staff: { count: number; sample: Array<{ id: string; name: string; language: string; department: string; is_active: boolean }> };
  owner: { email: string | null; displayName: string | null; username: string | null } | null;
}

export default function AdminPropertyDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const { user, loading: authLoading } = useAuth();

  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [regenerating, setRegenerating] = useState(false);
  const [regenerateMsg, setRegenerateMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/admin/property-health?id=${id}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Failed to load');
        setLoading(false);
        return;
      }
      // Defensive shape validation — if the server returns a
      // malformed payload, render a "data missing" error instead
      // of crashing on .map() of undefined.
      const d = json.data as HealthData | undefined;
      if (!d || !d.property || !Array.isArray(d.jobs) || !d.staff) {
        setError('Server returned an unexpected response shape. Please refresh.');
        setLoading(false);
        return;
      }
      setData(d);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!authLoading && user?.role === 'admin') void load();
    // load is stable for our purposes (closure over setState only); excluding
    // it from deps avoids a re-fire loop on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, id]);

  const handleRegenerate = async () => {
    if (!confirm('Demote the current active recipe and queue a fresh CUA mapping run? This costs ~$1-3 in API tokens.')) return;
    setRegenerating(true);
    setRegenerateMsg(null);
    try {
      const res = await fetchWithAuth('/api/admin/regenerate-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: id, reason: 'manual admin trigger' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setRegenerateMsg(`Error: ${json.error ?? 'unknown'}`);
      } else {
        setRegenerateMsg(`Queued. Job ${json.data.jobId.slice(0, 8)}…`);
        // Refresh after a beat so the new job appears in the list
        setTimeout(load, 2000);
      }
    } catch (e) {
      setRegenerateMsg(`Network error: ${(e as Error).message}`);
    }
    setRegenerating(false);
  };

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div style={{ padding: '80px 24px', textAlign: 'center', fontFamily: FONT_SERIF, color: T.ink }}>
          {authLoading
            ? <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
            : <><ShieldAlert size={32} color={T.warm} /><p style={{ fontSize: 22, fontStyle: 'italic', letterSpacing: '-0.02em' }}>Admin access only.</p></>}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{
        padding: '24px 48px 48px', maxWidth: 1400, margin: '0 auto',
        background: 'transparent', minHeight: 'calc(100vh - 64px)',
        fontFamily: FONT_SANS,
      }}>

        <Link href="/admin/properties" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink3, textDecoration: 'none',
          marginBottom: 20, letterSpacing: '0.16em', textTransform: 'uppercase',
        }}>
          <ArrowLeft size={12} /> All properties
        </Link>

        {loading && !data && (
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
          </div>
        )}

        {error && (
          <div style={{
            padding: '14px 16px',
            background: T.warmDim,
            border: `1px solid rgba(184,92,61,0.25)`,
            borderRadius: 14,
            color: T.warm, fontSize: 13, marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {data && (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28, gap: 16, flexWrap: 'wrap' }}>
              <div>
                <Caps>Property</Caps>
                <h1 style={{
                  fontFamily: FONT_SERIF, fontSize: 40, fontWeight: 400,
                  letterSpacing: '-0.02em', color: T.ink, margin: '4px 0 0',
                  lineHeight: 1.1,
                }}>
                  {data.property.name ?? <span style={{ fontStyle: 'italic', color: T.ink3 }}>(unnamed)</span>}
                </h1>
              </div>
              <Btn variant="ghost" size="md" onClick={load} disabled={loading}>
                <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Refresh
              </Btn>
            </div>

            {/* Summary cards — kept Subscription, PMS, Owner per Reeyen.
                Removed: Active recipe, Staff sample, Source. Property UUID
                under the name and the Recent onboarding jobs section are
                also gone. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginBottom: 24 }}>
              <DetailCard title="Subscription">
                <Pill tone={
                  data.property.subscriptionStatus === 'active' ? 'sage'
                    : data.property.subscriptionStatus === 'past_due' ? 'warm'
                    : 'neutral'
                }>
                  {(data.property.subscriptionStatus ?? '?').toUpperCase()}
                </Pill>
                {data.property.trialEndsAt && (
                  <p style={{ fontSize: 12, color: T.ink2, marginTop: 8, fontStyle: 'italic', fontFamily: FONT_SERIF }}>
                    Trial ends {new Date(data.property.trialEndsAt).toLocaleDateString()}
                  </p>
                )}
                {data.property.stripeCustomerId && (
                  <p style={{ fontSize: 10.5, color: T.ink3, fontFamily: FONT_MONO, marginTop: 6, letterSpacing: '0.04em' }}>
                    {data.property.stripeCustomerId}
                  </p>
                )}
              </DetailCard>

              <DetailCard title="PMS">
                {data.credentials ? (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>{data.credentials.pmsType}</p>
                    {data.credentials.loginUrl && (
                      <p style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, wordBreak: 'break-all', marginTop: 4 }}>
                        {data.credentials.loginUrl}
                      </p>
                    )}
                    <p style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>
                      {data.credentials.username ? `user: ${data.credentials.username} · ` : ''}
                      {data.credentials.isActive ? 'active' : 'inactive'}
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: 13, color: T.ink2, fontStyle: 'italic', fontFamily: FONT_SERIF }}>No credentials saved</p>
                )}
              </DetailCard>

              <DetailCard title="Owner">
                {data.owner ? (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 600, color: T.ink, letterSpacing: '-0.005em' }}>
                      {data.owner.displayName ?? '(no name)'}
                    </p>
                    <p style={{ fontSize: 12, color: T.ink2, marginTop: 3 }}>{data.owner.email ?? '—'}</p>
                  </>
                ) : (
                  <p style={{ fontSize: 13, color: T.ink2, fontStyle: 'italic', fontFamily: FONT_SERIF }}>No owner row</p>
                )}
              </DetailCard>
            </div>

            {/* Action: regenerate recipe — kept near the header as a small
                utility. The big "Active recipe" card itself is gone. */}
            {data.credentials?.isActive && (
              <div style={{
                padding: '14px 16px', border: `1px solid ${T.rule}`, borderRadius: 14,
                marginBottom: 28, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                background: T.paper,
              }}>
                <span style={{ fontSize: 12, color: T.ink2, flex: 1, minWidth: 180, fontStyle: 'italic', fontFamily: FONT_SERIF }}>
                  Use when a PMS UI change has broken the active recipe (~$1-3).
                </span>
                <Btn variant="ghost" size="md" onClick={handleRegenerate} disabled={regenerating}>
                  {regenerating
                    ? (<><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Queuing…</>)
                    : (<>Regenerate recipe</>)}
                </Btn>
                {regenerateMsg && (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, letterSpacing: '0.04em' }}>{regenerateMsg}</span>
                )}
              </div>
            )}

            {/* 3-column horizontal layout below the cards.
                Left: People with access · Middle: GM activity · Right: Audit log */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '20px',
              alignItems: 'start',
            }}>
              <JoinCodesSection propertyId={id} />
              <PeopleWithAccessSection propertyId={id} />
              <GmActivitySection propertyId={id} />
              <MlHealthPanel propertyId={id} />
              <AuditLogSection propertyId={id} />
            </div>

          </>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </AppLayout>
  );
}

// ─── Authoritative effective access ───────────────────────────────────────
function PeopleWithAccessSection({ propertyId }: { propertyId: string }) {
  return <AdminEffectiveAccess propertyId={propertyId} />;
}

// ─── GM activity (this hotel only) ──────────────────────────────────────
interface ActivityRow {
  propertyId: string;
  propertyName: string | null;
  lastActiveTs: string;
  viewsToday: number;
  viewsWeek: number;
  distinctUsersToday: number;
  topFeatures: { path: string; count: number }[];
}

function GmActivitySection({ propertyId }: { propertyId: string }) {
  const [row, setRow] = useState<ActivityRow | null | undefined>(undefined);

  useEffect(() => {
    fetchWithAuth('/api/admin/activity').then(r => r.json()).then((body: { ok?: boolean; data?: { rows?: ActivityRow[] } }) => {
      if (body.ok) {
        const found = (body.data?.rows ?? []).find(r => r.propertyId === propertyId);
        setRow(found ?? null);
      } else {
        setRow(null);
      }
    }).catch(() => setRow(null));
  }, [propertyId]);

  return (
    <div style={{ marginTop: '20px' }}>
      <h2 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <Activity size={16} /> GM activity & engagement
      </h2>
      {row === undefined ? (
        <p style={{ fontSize: '12px', color: T.ink2 }}>Loading…</p>
      ) : !row ? (
        <p style={{ fontSize: '13px', color: T.ink2 }}>No activity in the last 7 days.</p>
      ) : (
        <div style={{ padding: '14px', border: `1px solid ${T.rule}`, borderRadius: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '12px' }}>
            <span><strong style={{ color: T.ink }}>{row.viewsToday}</strong> <span style={{ color: T.ink2 }}>views today</span></span>
            <span><strong style={{ color: T.ink }}>{row.viewsWeek}</strong> <span style={{ color: T.ink2 }}>this week</span></span>
            <span><strong style={{ color: T.ink }}>{row.distinctUsersToday}</strong> <span style={{ color: T.ink2 }}>{row.distinctUsersToday === 1 ? 'user' : 'users'} today</span></span>
            <span style={{ color: T.ink2 }}>last active {new Date(row.lastActiveTs).toLocaleString()}</span>
          </div>
          {row.topFeatures.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
              {row.topFeatures.map(f => (
                <span key={f.path} style={{
                  fontSize: '11px', padding: '2px 8px',
                  background: T.ruleSoft, borderRadius: '999px',
                  color: T.ink2, fontFamily: 'var(--font-mono)',
                }}>
                  {f.path === '/' ? 'home' : f.path.split('/').filter(Boolean).slice(0, 2).join('/')} · {f.count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '16px 18px',
      background: T.paper,
      border: `1px solid ${T.rule}`,
      borderRadius: 16,
    }}>
      <Caps style={{ marginBottom: 10, display: 'block' }}>{title}</Caps>
      {children}
    </div>
  );
}

// ─── Audit log (this hotel only) ────────────────────────────────────────
interface AuditEntry {
  id: string;
  ts: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

function AuditLogSection({ propertyId }: { propertyId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    fetchWithAuth(`/api/admin/audit-log?propertyId=${propertyId}&limit=100`)
      .then(r => r.json())
      .then((body: { ok?: boolean; data?: { entries?: AuditEntry[] } }) => {
        if (body.ok) setEntries(body.data?.entries ?? []);
        else setEntries([]);
      })
      .catch(() => setEntries([]));
  }, [propertyId]);

  return (
    <div style={{ marginTop: '20px' }}>
      <h2 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <FileText size={16} /> Audit log
      </h2>
      {entries === null ? (
        <p style={{ fontSize: '12px', color: T.ink2 }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ fontSize: '13px', color: T.ink2 }}>No events recorded for this hotel yet.</p>
      ) : (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: '10px', overflow: 'hidden' }}>
          {entries.map((e, idx) => (
            <div key={e.id} style={{
              padding: '10px 14px',
              borderBottom: idx < entries.length - 1 ? `1px solid ${T.rule}` : 'none',
              display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr', gap: '12px', alignItems: 'center',
              fontSize: '12px',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {e.action}
              </div>
              <div style={{ color: T.ink2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {summarizeMetadata(e)}
              </div>
              <div style={{ textAlign: 'right', color: T.ink2, fontSize: '11px' }}>
                <div>{e.actor_email ?? '—'}</div>
                <div style={{ marginTop: '2px' }}>{new Date(e.ts).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeMetadata(e: AuditEntry): string {
  const m = e.metadata ?? {};
  const parts: string[] = [];
  for (const k of ['email', 'username', 'role', 'code']) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === 'string') parts.push(`${k}: ${v}`);
  }
  if (Array.isArray((m as Record<string, unknown>).changedFields)) {
    parts.push(`fields: ${((m as Record<string, unknown>).changedFields as string[]).join(', ')}`);
  }
  return parts.join(' · ');
}
