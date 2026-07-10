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
  ShieldAlert, Loader2, Activity, Users, Plus, Trash2, FileText,
  Pencil, X,
} from 'lucide-react';
import { ASSIGNABLE_ROLES, roleLabel, type AppRole, type AssignableRole } from '@/lib/roles';
import { JoinCodesSection } from '@/app/admin/_components/JoinCodesSection';
import { MlHealthPanel } from '@/app/admin/_components/MlHealthPanel';
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
                    <p style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, wordBreak: 'break-all', marginTop: 4 }}>
                      {data.credentials.loginUrl}
                    </p>
                    <p style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>
                      user: {data.credentials.username} · {data.credentials.isActive ? 'active' : 'inactive'}
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
            {data.credentials && (
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [editAccount, setEditAccount] = useState<AccountRow | null>(null);

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

  const withAccess = allAccounts.filter(a => a.role === 'admin' || a.propertyAccess.includes(propertyId));
  const eligibleToAttach = allAccounts.filter(a => a.role !== 'admin' && !a.propertyAccess.includes(propertyId));

  // Row-level trash = full delete (account removed from every hotel,
  // auth user gone, can never sign in again). For "just remove from
  // THIS hotel" while keeping the account alive on other hotels,
  // use Edit → "Remove from this hotel".
  const deleteAccount = async (acct: AccountRow) => {
    if (!user) return;
    if (acct.role === 'admin') return;
    const hotelCount = acct.propertyAccess.length;
    const scopeNote = hotelCount > 1
      ? `\n\nThis account currently has access to ${hotelCount} hotels — all of that access will be removed.`
      : '';
    if (!confirm(
      `Delete ${acct.displayName} entirely?${scopeNote}\n\n`
      + `This deletes the account from the system. They will not be able to sign in again. This cannot be undone.`,
    )) return;
    const res = await fetchWithAuth(
      `/api/auth/accounts?accountId=${encodeURIComponent(acct.accountId)}`,
      { method: 'DELETE', headers: { 'x-account-id': user.accountId } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      alert(body.error ?? 'Failed to delete account');
      return;
    }
    void load();
  };

  return (
    <div style={{ marginTop: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={16} /> People with access
        </h2>
        <button onClick={() => setShowAddModal(true)} style={attachBtnStyle}>
          <Plus size={13} /> Attach person
        </button>
      </div>

      {loading ? (
        <p style={{ fontSize: '12px', color: T.ink2 }}>Loading…</p>
      ) : withAccess.length === 0 ? (
        <p style={{ fontSize: '13px', color: T.ink2 }}>No accounts have access to this hotel yet.</p>
      ) : (
        <div style={{ border: `1px solid ${T.rule}`, borderRadius: '10px', overflow: 'hidden' }}>
          {withAccess.map((a, idx) => (
            <div key={a.accountId} style={{
              padding: '12px 14px',
              borderBottom: idx < withAccess.length - 1 ? `1px solid ${T.rule}` : 'none',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.displayName}</div>
                <div style={{ fontSize: '11px', color: T.ink2, marginTop: '2px' }}>
                  {roleLabel(a.role)} · {a.email}
                </div>
              </div>
              <button onClick={() => setEditAccount(a)} aria-label={`Edit ${a.displayName}`} style={iconBtnStyle}>
                <Pencil size={13} />
              </button>
              {a.role !== 'admin' && a.accountId !== user?.accountId && (
                <button onClick={() => deleteAccount(a)} aria-label={`Delete ${a.displayName}`} title={`Delete ${a.displayName} entirely`} style={iconBtnRedStyle}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showAddModal && (
        <AddPersonModal
          propertyId={propertyId}
          eligibleToAttach={eligibleToAttach}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => { setShowAddModal(false); void load(); }}
        />
      )}
      {editAccount && (
        <EditPersonModal
          account={editAccount}
          propertyId={propertyId}
          onClose={() => setEditAccount(null)}
          onSuccess={() => { setEditAccount(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─── Add Person modal ──────────────────────────────────────────────────
function AddPersonModal({
  propertyId, eligibleToAttach, onClose, onSuccess,
}: {
  propertyId: string;
  eligibleToAttach: AccountRow[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  // Create-new state
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AssignableRole>('housekeeping');
  // Attach-existing state
  const [pickId, setPickId] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const usernameFromEmail = (e: string) => {
    const local = e.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
    return local.slice(0, 40) || `user${Date.now().toString(36)}`;
  };

  const submit = async () => {
    if (!user) return;
    const activeMode: 'new' | 'existing' = eligibleToAttach.length > 0 ? mode : 'new';
    setError('');
    setSubmitting(true);
    try {
      if (activeMode === 'new') {
        if (!displayName.trim() || !email.trim() || !password.trim()) { setError('Name, email, and password are required'); return; }
        if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
        const res = await fetchWithAuth('/api/auth/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
          body: JSON.stringify({
            username: usernameFromEmail(email),
            displayName,
            email: email.trim(),
            password,
            role,
            propertyAccess: [propertyId],
          }),
        });
        const body = await res.json() as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) { setError(body.error ?? 'Failed to create account'); return; }
      } else {
        if (!pickId) { setError('Pick an account'); return; }
        const acct = eligibleToAttach.find(a => a.accountId === pickId);
        if (!acct) { setError('Account not found'); return; }
        const newAccess = Array.from(new Set([...acct.propertyAccess, propertyId]));
        const res = await fetchWithAuth('/api/auth/accounts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
          body: JSON.stringify({ accountId: pickId, propertyAccess: newAccess }),
        });
        const body = await res.json() as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) { setError(body.error ?? 'Failed to attach account'); return; }
      }
      onSuccess();
    } finally {
      setSubmitting(false);
    }
  };

  // Force Create mode + hide the tab toggle entirely when there are no
  // existing accounts that could be attached. Showing a disabled tab is
  // confusing — the user can't tell why it doesn't work.
  const hasEligibleExisting = eligibleToAttach.length > 0;
  const effectiveMode: 'new' | 'existing' = hasEligibleExisting ? mode : 'new';

  return (
    <ModalShell onClose={onClose} title="Attach person">
      {hasEligibleExisting && (
        <div style={{ display: 'flex', gap: '4px', background: T.ruleSoft, borderRadius: '8px', padding: '3px' }}>
          <TabButton active={effectiveMode === 'new'} onClick={() => setMode('new')}>Create new</TabButton>
          <TabButton active={effectiveMode === 'existing'} onClick={() => setMode('existing')}>
            Attach existing ({eligibleToAttach.length})
          </TabButton>
        </div>
      )}

      {effectiveMode === 'new' ? (
        <>
          <FieldText label="Full name" value={displayName} onChange={setDisplayName} placeholder="e.g. Maria Lopez" autoFocus />
          <FieldText label="Email" type="email" value={email} onChange={setEmail} placeholder="name@example.com" />
          <FieldText label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 6 characters" />
          <FieldRole role={role} onChange={setRole} />
        </>
      ) : (
        <FieldSelect label="Account" value={pickId} onChange={setPickId} options={[
          { value: '', label: 'Pick an account…' },
          ...eligibleToAttach.map(a => ({ value: a.accountId, label: `${a.displayName} — ${roleLabel(a.role)} (${a.email})` })),
        ]} />
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      <button disabled={submitting} onClick={submit} style={primaryBtnStyle(submitting)}>
        {submitting
          ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
          : (effectiveMode === 'new' ? 'Create account' : 'Attach')}
      </button>
    </ModalShell>
  );
}

// ─── Edit Person modal ─────────────────────────────────────────────────
function EditPersonModal({
  account, propertyId, onClose, onSuccess,
}: {
  account: AccountRow;
  propertyId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [email, setEmail] = useState(account.email);
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AppRole>(account.role);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isAdminRow = account.role === 'admin';

  const submit = async () => {
    if (!user) return;
    setError('');
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = { accountId: account.accountId };
      if (displayName !== account.displayName) payload.displayName = displayName;
      if (email !== account.email) payload.email = email.trim();
      if (role !== account.role && !isAdminRow) payload.role = role;
      if (password) {
        if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
        payload.password = password;
      }
      if (Object.keys(payload).length === 1) { setError('Nothing changed'); return; }

      const res = await fetchWithAuth('/api/auth/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
        body: JSON.stringify(payload),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) { setError(body.error ?? 'Failed to update'); return; }
      onSuccess();
    } finally {
      setSubmitting(false);
    }
  };

  const removeFromHotel = async () => {
    if (!user || isAdminRow) return;
    if (!confirm(`Remove ${account.displayName} from this hotel?`)) return;
    const newAccess = account.propertyAccess.filter(p => p !== propertyId);
    await fetchWithAuth('/api/auth/accounts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
      body: JSON.stringify({ accountId: account.accountId, propertyAccess: newAccess }),
    });
    onSuccess();
  };

  return (
    <ModalShell onClose={onClose} title={`Edit ${account.displayName}`}>
      <FieldText label="Full name" value={displayName} onChange={setDisplayName} />
      <FieldText label="Email" type="email" value={email} onChange={setEmail} />
      <FieldText label="New password (optional)" type="password" value={password} onChange={setPassword} placeholder="Leave blank to keep current" />
      {!isAdminRow && <FieldRole role={role as AssignableRole} onChange={(r) => setRole(r)} />}

      {error && <ErrorBox>{error}</ErrorBox>}

      <button disabled={submitting} onClick={submit} style={primaryBtnStyle(submitting)}>
        {submitting
          ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
          : 'Save changes'}
      </button>
      {!isAdminRow && account.accountId !== user?.accountId && (
        <button onClick={removeFromHotel} style={{
          width: '100%', height: '40px', borderRadius: '8px',
          background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
          color: T.warm, fontSize: '13px', fontWeight: 600,
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        }}>
          <Trash2 size={13} /> Remove from this hotel
        </button>
      )}
    </ModalShell>
  );
}

// ─── Modal building blocks ─────────────────────────────────────────────
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: '100%', maxWidth: '440px',
        // Opaque white so the modal stands out against the dark backdrop.
        // Was using var(--surface-primary) which on the light theme is the
        // same near-white as the page itself, making the modal nearly
        // invisible. Forcing a hard color + a real drop shadow.
        background: '#ffffff',
        borderRadius: '12px',
        border: '1px solid rgba(0,0,0,0.08)',
        boxShadow: '0 20px 60px -10px rgba(0,0,0,0.35), 0 8px 20px -6px rgba(0,0,0,0.18)',
        padding: '20px',
        display: 'flex', flexDirection: 'column', gap: '12px',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '16px', color: T.ink }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: T.ink2, padding: '4px' }}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TabButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      flex: 1, height: '34px', borderRadius: '6px',
      background: active ? T.paper : 'transparent',
      border: active ? `1px solid ${T.rule}` : '1px solid transparent',
      color: disabled ? T.ink2 : T.ink,
      fontSize: '13px', fontWeight: active ? 600 : 500,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
  );
}

function FieldText({ label, value, onChange, type='text', placeholder, autoFocus }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoFocus?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: T.ink2 }}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        style={{ height: '40px', borderRadius: '8px', background: T.paper, border: `1px solid ${T.rule}`, padding: '0 12px', color: T.ink, fontSize: '14px', outline: 'none' }} />
    </div>
  );
}

function FieldSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: T.ink2 }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ height: '40px', borderRadius: '8px', background: T.paper, border: `1px solid ${T.rule}`, padding: '0 12px', color: T.ink, fontSize: '14px', outline: 'none' }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function FieldRole({ role, onChange }: { role: AssignableRole; onChange: (r: AssignableRole) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: T.ink2 }}>Role</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {ASSIGNABLE_ROLES.map(r => (
          <button key={r} onClick={() => onChange(r)} style={{
            minWidth: 90, flex: '1 1 90px', height: 34,
            borderRadius: 999,
            background: role === r ? 'rgba(215,176,126,0.14)' : T.paper,
            border: `1px solid ${role === r ? T.caramelDeep : T.rule}`,
            color: role === r ? T.caramelDeep : T.ink2,
            fontFamily: FONT_SANS, fontSize: 12, fontWeight: role === r ? 600 : 500,
            cursor: 'pointer',
          }}>
            {roleLabel(r)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: 12, color: T.warm,
      background: T.warmDim,
      border: `1px solid rgba(184,92,61,0.25)`,
      borderRadius: 10,
      padding: '8px 12px', margin: 0,
    }}>{children}</p>
  );
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: 44, borderRadius: 999,
    background: disabled ? 'rgba(31,35,28,0.4)' : T.ink,
    color: T.bg, fontFamily: FONT_SANS, fontSize: 14, fontWeight: 500,
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

const attachBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'transparent', color: T.ink,
  border: `1px solid ${T.rule}`, borderRadius: 999,
  padding: '6px 14px', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: FONT_SANS,
};
const iconBtnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 999,
  background: 'transparent', border: `1px solid ${T.rule}`,
  color: T.ink2, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const iconBtnRedStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 999,
  background: 'transparent', border: `1px solid rgba(184,92,61,0.30)`,
  color: T.warm, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

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
