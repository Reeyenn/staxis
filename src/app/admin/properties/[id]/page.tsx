'use client';

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
  ArrowLeft, RefreshCw, AlertTriangle, CheckCircle2, Clock,
  ShieldAlert, ExternalLink, Loader2,
} from 'lucide-react';

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
    loginUrl: string;
    username: string;
    isActive: boolean;
    scraperInstance: string;
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
  staff: { count: number; sample: Array<{ id: string; name: string; phone_number: string | null; language: string; role: string; is_active: boolean }> };
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
      setData(json.data);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!authLoading && user?.role === 'admin') void load();
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
        setRegenerateMsg(`Queued — job ${json.data.jobId.slice(0, 8)}…`);
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
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
          {authLoading
            ? <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
            : <><ShieldAlert size={32} color="var(--red)" /><p>Admin access only.</p></>}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto' }}>

        <Link href="/admin/properties" style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          fontSize: '13px', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '16px',
        }}>
          <ArrowLeft size={14} /> All properties
        </Link>

        {loading && !data && (
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }} />
          </div>
        )}

        {error && (
          <div style={{ padding: '12px', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.25))', borderRadius: '10px', color: 'var(--red)', fontSize: '13px', marginBottom: '14px' }}>
            {error}
          </div>
        )}

        {data && (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.01em' }}>
                  {data.property.name ?? '(unnamed)'}
                </h1>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                  {data.property.id}
                </p>
              </div>
              <button onClick={load} disabled={loading} className="btn btn-secondary" style={{ fontSize: '13px' }}>
                <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Refresh
              </button>
            </div>

            {/* Summary cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              <DetailCard title="Subscription">
                <p style={{ fontSize: '15px', fontWeight: 600, color: subscriptionColor(data.property.subscriptionStatus) }}>
                  {(data.property.subscriptionStatus ?? '?').toUpperCase()}
                </p>
                {data.property.trialEndsAt && (
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Trial ends {new Date(data.property.trialEndsAt).toLocaleDateString()}
                  </p>
                )}
                {data.property.stripeCustomerId && (
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                    {data.property.stripeCustomerId}
                  </p>
                )}
              </DetailCard>

              <DetailCard title="PMS">
                {data.credentials ? (
                  <>
                    <p style={{ fontSize: '14px', fontWeight: 600 }}>{data.credentials.pmsType}</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{data.credentials.loginUrl}</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      user: {data.credentials.username} · {data.credentials.isActive ? 'active' : 'inactive'}
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No credentials saved</p>
                )}
              </DetailCard>

              <DetailCard title="Active recipe">
                {data.activeRecipe ? (
                  <>
                    <p style={{ fontSize: '14px', fontWeight: 600 }}>v{data.activeRecipe.version}</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {data.activeRecipe.id.slice(0, 8)}…
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      learned {new Date(data.activeRecipe.created_at).toLocaleDateString()}
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No active recipe</p>
                )}
              </DetailCard>

              <DetailCard title="Staff">
                <p style={{ fontSize: '15px', fontWeight: 600 }}>{data.staff.count}</p>
                {data.staff.sample.slice(0, 3).map((s) => (
                  <p key={s.id} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {s.name} {s.is_active ? '' : '(inactive)'}
                  </p>
                ))}
              </DetailCard>

              <DetailCard title="Owner">
                {data.owner ? (
                  <>
                    <p style={{ fontSize: '13px' }}>{data.owner.displayName ?? '(no name)'}</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{data.owner.email ?? '—'}</p>
                  </>
                ) : (
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No owner row</p>
                )}
              </DetailCard>

              <DetailCard title="Source">
                <p style={{ fontSize: '13px' }}>{data.property.onboardingSource}</p>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Created {new Date(data.property.createdAt).toLocaleDateString()}
                </p>
              </DetailCard>
            </div>

            {/* Action: regenerate recipe */}
            {data.credentials && (
              <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: '12px', marginBottom: '20px' }}>
                <p style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>Recipe re-mapping</p>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                  Use this when a PMS UI change has broken the active recipe. Demotes current active and queues a fresh CUA mapping run (~$1-3).
                </p>
                <button
                  onClick={handleRegenerate}
                  disabled={regenerating}
                  className="btn btn-secondary"
                  style={{ fontSize: '13px' }}
                >
                  {regenerating
                    ? (<><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Queuing…</>)
                    : (<>Regenerate recipe</>)}
                </button>
                {regenerateMsg && (
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '10px' }}>{regenerateMsg}</p>
                )}
              </div>
            )}

            {/* Recent jobs */}
            <div>
              <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Recent onboarding jobs (last 10)
              </p>
              {data.jobs.length === 0 ? (
                <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No jobs yet.</p>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
                  {data.jobs.map((j, idx) => (
                    <div key={j.id} style={{
                      padding: '12px 14px',
                      borderBottom: idx < data.jobs.length - 1 ? '1px solid var(--border)' : 'none',
                      display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr', gap: '12px', alignItems: 'flex-start',
                    }}>
                      <div>
                        <JobIconStatus status={j.status} />
                        <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                          {j.id.slice(0, 8)}…
                        </p>
                      </div>
                      <div>
                        {j.step && <p style={{ fontSize: '12px' }}>{j.step}</p>}
                        {j.error && <p style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px' }}>{j.error}</p>}
                        {j.worker_id && (
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                            {j.worker_id}
                          </p>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right' }}>
                        <p>{new Date(j.created_at).toLocaleString()}</p>
                        {j.completed_at && j.started_at && (
                          <p style={{ marginTop: '2px' }}>
                            took {Math.round((Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000)}s
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </AppLayout>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px', border: '1px solid var(--border)', borderRadius: '12px' }}>
      <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '8px' }}>
        {title}
      </p>
      {children}
    </div>
  );
}

function JobIconStatus({ status }: { status: string }) {
  const Icon = status === 'complete' ? CheckCircle2
             : status === 'failed' ? AlertTriangle
             : Clock;
  const color = status === 'complete' ? 'var(--green)'
              : status === 'failed' ? 'var(--red)'
              : 'var(--amber)';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color, fontWeight: 600 }}>
      <Icon size={14} /> {status.toUpperCase()}
    </div>
  );
}

function subscriptionColor(s: string | null): string {
  if (s === 'active') return 'var(--green)';
  if (s === 'trial') return 'var(--amber)';
  if (s === 'past_due' || s === 'cancelled') return 'var(--red)';
  return 'var(--text-secondary)';
}
