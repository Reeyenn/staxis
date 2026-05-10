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
  ShieldAlert, ExternalLink, Loader2, Activity, Users, Plus, Trash2, FileText,
} from 'lucide-react';
import { roleLabel, type AppRole } from '@/lib/roles';

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
  staff: { count: number; sample: Array<{ id: string; name: string; phone: string | null; language: string; department: string; is_active: boolean }> };
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
        setError('Server returned an unexpected response shape — please refresh.');
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

            {/* People with access — Phase 4 */}
            <PeopleWithAccessSection propertyId={id} />

            {/* GM activity & engagement — moved here from fleet view */}
            <GmActivitySection propertyId={id} />

            {/* Audit log — Phase 5 */}
            <AuditLogSection propertyId={id} />

          </>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </AppLayout>
  );
}

// ─── People with access ─────────────────────────────────────────────────
interface AccountRow {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  propertyAccess: string[];
}

function PeopleWithAccessSection({ propertyId }: { propertyId: string }) {
  const { user } = useAuth();
  const [allAccounts, setAllAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pickAccountId, setPickAccountId] = useState('');

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await fetchWithAuth('/api/auth/accounts', { headers: { 'x-account-id': user.accountId } });
      const body = await res.json() as { ok?: boolean; data?: { accounts?: AccountRow[] } };
      if (body.ok) setAllAccounts(body.data?.accounts ?? []);
    } finally {
      setLoading(false);
    }
  }, [user]);
  useEffect(() => { void load(); }, [load, propertyId]);

  // "Has access" = role admin (sees everything) or propertyAccess includes this property.
  const withAccess = allAccounts.filter(a => a.role === 'admin' || a.propertyAccess.includes(propertyId));
  const eligibleToAdd = allAccounts.filter(a => a.role !== 'admin' && !a.propertyAccess.includes(propertyId));

  const detach = async (acct: AccountRow) => {
    if (!user) return;
    if (acct.role === 'admin') return; // admins always have access
    if (!confirm(`Remove ${acct.displayName} from this hotel?`)) return;
    const newAccess = acct.propertyAccess.filter(p => p !== propertyId);
    await fetchWithAuth('/api/auth/accounts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
      body: JSON.stringify({ accountId: acct.accountId, propertyAccess: newAccess }),
    });
    void load();
  };

  const attach = async () => {
    if (!user || !pickAccountId) return;
    const acct = allAccounts.find(a => a.accountId === pickAccountId);
    if (!acct) return;
    const newAccess = Array.from(new Set([...acct.propertyAccess, propertyId]));
    await fetchWithAuth('/api/auth/accounts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
      body: JSON.stringify({ accountId: pickAccountId, propertyAccess: newAccess }),
    });
    setShowAdd(false);
    setPickAccountId('');
    void load();
  };

  return (
    <div style={{ marginTop: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={16} /> People with access
        </h2>
        <button onClick={() => setShowAdd(v => !v)} style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          background: 'var(--surface-secondary)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: '8px',
          padding: '6px 12px', fontSize: '12px', fontWeight: 600,
          cursor: 'pointer',
        }}>
          <Plus size={13} /> Attach person
        </button>
      </div>

      {showAdd && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <select value={pickAccountId} onChange={e => setPickAccountId(e.target.value)} style={{
            flex: 1, height: '38px', borderRadius: '8px',
            background: 'var(--surface-primary)', border: '1px solid var(--border)',
            padding: '0 12px', color: 'var(--text-primary)', fontSize: '13px',
          }}>
            <option value="">Pick an account…</option>
            {eligibleToAdd.map(a => (
              <option key={a.accountId} value={a.accountId}>{a.displayName} — {roleLabel(a.role)} ({a.email})</option>
            ))}
          </select>
          <button disabled={!pickAccountId} onClick={attach} style={{
            background: pickAccountId ? 'var(--navy-light)' : 'rgba(37,99,235,0.4)',
            color: '#FFFFFF', border: 'none', borderRadius: '8px',
            padding: '0 16px', fontSize: '13px', fontWeight: 600,
            cursor: pickAccountId ? 'pointer' : 'not-allowed',
          }}>Attach</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</p>
      ) : withAccess.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No accounts have access to this hotel yet.</p>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
          {withAccess.map((a, idx) => (
            <div key={a.accountId} style={{
              padding: '12px 14px',
              borderBottom: idx < withAccess.length - 1 ? '1px solid var(--border)' : 'none',
              display: 'flex', alignItems: 'center', gap: '12px',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {roleLabel(a.role)} · {a.email}
                </div>
              </div>
              {a.role !== 'admin' && a.accountId !== user?.accountId && (
                <button onClick={() => detach(a)} aria-label={`Remove ${a.displayName}`} style={{
                  width: '32px', height: '32px', borderRadius: '6px',
                  background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                  color: 'var(--red)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</p>
      ) : !row ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No activity in the last 7 days.</p>
      ) : (
        <div style={{ padding: '14px', border: '1px solid var(--border)', borderRadius: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '12px' }}>
            <span><strong style={{ color: 'var(--text-primary)' }}>{row.viewsToday}</strong> <span style={{ color: 'var(--text-muted)' }}>views today</span></span>
            <span><strong style={{ color: 'var(--text-primary)' }}>{row.viewsWeek}</strong> <span style={{ color: 'var(--text-muted)' }}>this week</span></span>
            <span><strong style={{ color: 'var(--text-primary)' }}>{row.distinctUsersToday}</strong> <span style={{ color: 'var(--text-muted)' }}>{row.distinctUsersToday === 1 ? 'user' : 'users'} today</span></span>
            <span style={{ color: 'var(--text-muted)' }}>last active {new Date(row.lastActiveTs).toLocaleString()}</span>
          </div>
          {row.topFeatures.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
              {row.topFeatures.map(f => (
                <span key={f.path} style={{
                  fontSize: '11px', padding: '2px 8px',
                  background: 'var(--surface-secondary)', borderRadius: '999px',
                  color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
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
  if (s === 'past_due' || s === 'canceled') return 'var(--red)';
  return 'var(--text-secondary)';
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
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No events recorded for this hotel yet.</p>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
          {entries.map((e, idx) => (
            <div key={e.id} style={{
              padding: '10px 14px',
              borderBottom: idx < entries.length - 1 ? '1px solid var(--border)' : 'none',
              display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr', gap: '12px', alignItems: 'center',
              fontSize: '12px',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {e.action}
              </div>
              <div style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {summarizeMetadata(e)}
              </div>
              <div style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: '11px' }}>
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
