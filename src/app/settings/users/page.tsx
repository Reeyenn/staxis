'use client';


export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { ArrowRight, ChevronLeft, UserCog, Crown, ShieldCheck } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  clearOwnershipTransferAttempt,
  findOwnershipTransferAttempt,
  getOrCreateOwnershipTransferAttempt,
} from '@/lib/ownership-transfer-attempt';
import { roleLabel, type AppRole } from '@/lib/roles';
import { useCan } from '@/lib/capabilities/useCan';

interface UserRow {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  active: boolean;
  lastSignInAt: string | null;
  propertyAccess: string[];
}

export default function UsersPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const {
    properties,
    activeProperty,
    activePropertyId,
    loading: propertyLoading,
    capabilityOverridesViewerKey,
    capabilityOverridesPropertyId,
    setActivePropertyId,
  } = useProperty();
  const { lang } = useLang();
  const can = useCan();
  const capabilityViewerKey = user?.uid && activePropertyId
    ? `${user.uid}:${activePropertyId}`
    : null;
  const accessContextReady = Boolean(
    capabilityViewerKey
    && activeProperty?.id === activePropertyId
    && capabilityOverridesPropertyId === activePropertyId
    && capabilityOverridesViewerKey === capabilityViewerKey
  );
  const allowed = accessContextReady && !!user && can('manage_users');

  useEffect(() => {
    if (!authLoading && !propertyLoading && user && accessContextReady && !allowed) {
      router.replace('/settings');
    }
  }, [user, authLoading, propertyLoading, accessContextReady, allowed, router]);

  // Keep the data scope and capability scope identical. A separate local
  // hotel selector could otherwise authorize against one hotel's overrides
  // while sending a settings request for another hotel.
  const propertyId = activePropertyId ?? '';

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<UserRow | null>(null);
  const loadRequestRef = useRef(0);
  const transferAttemptRef = useRef<{
    key: string;
    operationId: string;
    reason: string | null;
  } | null>(null);
  const replayedTransferOperationsRef = useRef(new Set<string>());
  const activeScopeRef = useRef<string | null>(null);
  activeScopeRef.current = allowed ? propertyId : null;

  useEffect(() => {
    // A late Hotel A response must never render after the selector moves to
    // Hotel B, even if A's request was already in flight.
    loadRequestRef.current += 1;
    setUsers([]);
    setError('');
    setTransferTarget(null);
    transferAttemptRef.current = null;
    setLoading(true);
  }, [propertyId]);

  const load = useCallback(async () => {
    const requestedPropertyId = propertyId;
    const requestId = ++loadRequestRef.current;
    if (!requestedPropertyId || !allowed || activeScopeRef.current !== requestedPropertyId) {
      if (!requestedPropertyId) setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetchWithAuth(`/api/settings/users?propertyId=${propertyId}`);
      const body = await res.json() as { ok?: boolean; data?: { users: UserRow[] }; error?: string };
      if (requestId !== loadRequestRef.current || activeScopeRef.current !== requestedPropertyId) return;
      if (!res.ok || !body.ok || !body.data) {
        setError(body.error || (lang === 'es' ? 'No se pudieron cargar los usuarios' : 'Failed to load users'));
        return;
      }
      setUsers(body.data.users);
    } catch (err) {
      if (requestId !== loadRequestRef.current || activeScopeRef.current !== requestedPropertyId) return;
      // A network throw used to escape as an unhandled rejection, rendering a
      // silently empty user list with no error.
      console.error('[users:settings] load failed', err);
      setError(lang === 'es' ? 'No se pudieron cargar los usuarios — revisa tu conexión' : 'Failed to load users — check your connection');
    } finally {
      if (requestId === loadRequestRef.current && activeScopeRef.current === requestedPropertyId) setLoading(false);
    }
  }, [propertyId, lang, allowed]);

  useEffect(() => { void load(); }, [load]);

  const transferOwnership = async (accountId: string, reason: string) => {
    if (!allowed || !propertyId) return;
    const requestedPropertyId = propertyId;
    const attemptKey = `${requestedPropertyId}:${accountId}`;
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* storage is optional */ }
    const persistedAttempt = transferAttemptRef.current?.key === attemptKey
      ? transferAttemptRef.current
      : getOrCreateOwnershipTransferAttempt(
        storage,
        requestedPropertyId,
        accountId,
        reason || null,
        () => crypto.randomUUID(),
      );
    const operationId = persistedAttempt.operationId;
    const persistedReason = persistedAttempt.reason;
    // Keep the operation UUID across network errors and ambiguous server
    // responses. A retry can then prove that the atomic transfer already
    // committed without creating duplicate role/audit rows. Hotel or target
    // changes get a fresh key and the property-change effect clears it too.
    transferAttemptRef.current = { key: attemptKey, operationId, reason: persistedReason };
    setBusyAccountId(accountId);
    setError('');
    try {
      const res = await fetchWithAuth('/api/settings/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId,
          accountId,
          action: 'transfer_ownership',
          newOwnerAccountId: accountId,
          operationId,
          reason: persistedReason,
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      const definitive = (res.ok && body.ok === true)
        || (!res.ok && res.status >= 400 && res.status < 500);
      if (definitive) {
        clearOwnershipTransferAttempt(
          storage,
          requestedPropertyId,
          accountId,
          operationId,
        );
        if (transferAttemptRef.current?.operationId === operationId) {
          transferAttemptRef.current = null;
        }
      }
      if (activeScopeRef.current !== requestedPropertyId) return;
      if (!res.ok || !body.ok) {
        setError(body.error || (lang === 'es' ? 'La transferencia de propiedad falló' : 'Ownership transfer failed'));
        return;
      }
      await load();
    } catch (err) {
      if (activeScopeRef.current !== requestedPropertyId) return;
      console.error('[users:settings] ownership transfer failed', err);
      setError(lang === 'es'
        ? 'La transferencia de propiedad falló — revisa tu conexión e intenta de nuevo'
        : 'Ownership transfer failed — check your connection and try again');
    } finally {
      setBusyAccountId(null);
    }
  };

  useEffect(() => {
    if (!allowed || loading || !propertyId || users.length === 0) return;
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { return; }
    const attempt = findOwnershipTransferAttempt(
      storage,
      propertyId,
      users.map((row) => row.accountId),
    );
    if (!attempt || replayedTransferOperationsRef.current.has(attempt.operationId)) return;
    replayedTransferOperationsRef.current.add(attempt.operationId);
    // A persisted record exists only after an ambiguous/network outcome. Run
    // the exact operation again on reload so a committed transfer can return
    // already_applied even though the caller's current role is now GM.
    void transferOwnership(attempt.newOwnerAccountId, attempt.reason ?? '');
  // transferOwnership intentionally uses this render's authenticated hotel
  // context; the operation UUID ref prevents an automatic replay loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, loading, propertyId, users]);

  const isOwnerCaller = user?.role === 'owner' || user?.role === 'admin';

  // Sort: active first, then by display name. Owners pinned to the top.
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      if (a.role === 'owner' && b.role !== 'owner') return -1;
      if (b.role === 'owner' && a.role !== 'owner') return 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [users]);

  if (authLoading || propertyLoading || (!!user && !accessContextReady)) {
    return (
      <AppLayout>
        <div role="status" style={{ minHeight: '50dvh', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
          {lang === 'es' ? 'Comprobando acceso…' : 'Checking access…'}
        </div>
      </AppLayout>
    );
  }
  if (!user) return null;
  if (!allowed) {
    return (
      <AppLayout>
        <div role="status" style={{ minHeight: '50dvh', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
          {lang === 'es' ? 'Volviendo a Configuración…' : 'Returning to Settings…'}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 880 }}>
        <div>
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 13,
              cursor: 'pointer', padding: '0 0 12px', fontFamily: 'var(--font-sans)',
            }}
          >
            <ChevronLeft size={14} />
            {lang === 'es' ? 'Configuración' : 'Settings'}
          </button>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserCog size={15} color="var(--navy)" />
            {lang === 'es' ? 'Usuarios y propiedad' : 'Users & ownership'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            {lang === 'es'
              ? 'Consulta las cuentas del hotel y transfiere la propiedad cuando sea necesario. Los roles y el acceso ahora se administran en Mi hotel.'
              : 'Review hotel accounts and transfer ownership when needed. Roles and login access are now managed in My Hotel.'}
          </p>
        </div>

        {properties.length > 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>{lang === 'es' ? 'Hotel' : 'Hotel'}</label>
            <select value={propertyId} onChange={e => setActivePropertyId(e.target.value)} style={{ ...inputStyle, height: 44 }}>
              {properties.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        )}

        <section
          aria-labelledby="my-hotel-people-handoff-title"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
            flexWrap: 'wrap', padding: '14px 16px', background: 'var(--bg-card)',
            border: '1px solid var(--border-bright)', borderRadius: 'var(--radius-lg)',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <h2 id="my-hotel-people-handoff-title" style={{ fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              {lang === 'es' ? 'Administra roles y accesos en Mi hotel' : 'Manage roles and login access in My Hotel'}
            </h2>
            <p style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
              {lang === 'es'
                ? `Abre Personas para ${activeProperty?.name ?? 'este hotel'}. Este marcador sigue mostrando las cuentas y la transferencia de propiedad.`
                : `Open People for ${activeProperty?.name ?? 'this hotel'}. This bookmark still shows accounts and ownership transfer.`}
            </p>
          </div>
          <Link
            href="/company?tab=people"
            className="btn btn-primary"
            style={{ height: 44, padding: '0 16px', flex: '0 0 auto' }}
          >
            {lang === 'es' ? 'Abrir Personas en Mi hotel' : 'Open People in My Hotel'}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </section>

        {error && (
          <p style={{ fontSize: 13, color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            {error}
          </p>
        )}

        {loading && (
          <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}>
            <div className="spinner" style={{ width: 28, height: 28 }} />
          </div>
        )}

        {!loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortedUsers.map(u => {
              const isSelf = u.accountId === user.accountId;
              const isOwner = u.role === 'owner';
              return (
                <div key={u.accountId} style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)', padding: '14px 16px',
                  display: 'flex', flexDirection: 'column', gap: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 38, height: 38, borderRadius: '50%',
                      background: isOwner ? 'rgba(212,144,64,0.12)' : 'rgba(100,116,139,0.12)',
                      border: `1px solid ${isOwner ? 'rgba(212,144,64,0.3)' : 'var(--border)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      {isOwner ? <Crown size={16} color="var(--amber)" /> : <ShieldCheck size={16} color="var(--text-muted)" />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {u.displayName}
                        {isSelf && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
                            {lang === 'es' ? '(tú)' : '(you)'}
                          </span>
                        )}
                        {!u.active && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--red)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {lang === 'es' ? 'inactivo' : 'inactive'}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {u.email} · {u.lastSignInAt
                          ? `${lang === 'es' ? 'último ingreso' : 'last sign-in'} ${new Date(u.lastSignInAt).toLocaleDateString()}`
                          : (lang === 'es' ? 'sin ingresos aún' : 'no sign-ins yet')}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                        {lang === 'es' ? 'Rol actual' : 'Current role'}: <strong>{roleLabel(u.role)}</strong>
                      </div>
                    </div>
                  </div>

                  {isOwnerCaller && !isOwner && u.active && !isSelf && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <button
                        onClick={() => setTransferTarget(u)}
                        disabled={busyAccountId === u.accountId}
                        style={ghostBtnStyle('var(--amber)')}
                      >
                        <Crown size={13} />
                        {lang === 'es' ? 'Hacer propietario' : 'Make owner'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {transferTarget && (
          <TransferOwnershipModal
            target={transferTarget}
            onClose={() => setTransferTarget(null)}
            onConfirm={async (reason) => {
              await transferOwnership(transferTarget.accountId, reason);
              setTransferTarget(null);
            }}
          />
        )}
      </div>
    </AppLayout>
  );
}

function TransferOwnershipModal({ target, onClose, onConfirm }: {
  target: UserRow;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { lang } = useLang();
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const expected = lang === 'es' ? 'transferir' : 'transfer';
  const canSubmit = confirmText.trim().toLowerCase() === expected;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: '100%', maxWidth: 440,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-bright)',
        borderRadius: 'var(--radius-lg)', padding: '20px 20px 22px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Crown size={18} color="var(--amber)" />
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>
            {lang === 'es' ? 'Transferir la propiedad' : 'Transfer ownership'}
          </h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>
          {lang === 'es'
            ? `Vas a hacer a ${target.displayName} el nuevo propietario de este hotel. Tu propio rol pasará a Gerente General. Esto NO se puede deshacer desde la app — necesitarás pedirle al nuevo propietario que te promueva de vuelta.`
            : `You're about to make ${target.displayName} the new owner of this hotel. Your own role will drop to General Manager. This canNOT be undone from the app — you'll need to ask the new owner to promote you back.`}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>{lang === 'es' ? 'Razón (opcional)' : 'Reason (optional)'}</label>
          <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder={lang === 'es' ? 'Ej. cambio de gerencia' : 'e.g. handover after sale'} style={inputStyle} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>
            {lang === 'es' ? `Escribe "transferir" para confirmar` : `Type "transfer" to confirm`}
          </label>
          <input type="text" value={confirmText} onChange={e => setConfirmText(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} style={ghostBtnStyle('var(--text-secondary)')}>
            {lang === 'es' ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onConfirm(reason)}
            style={{
              flex: 1, height: 42, borderRadius: 'var(--radius-md)',
              background: canSubmit ? 'var(--amber)' : 'rgba(212,144,64,0.4)',
              color: '#fff', border: 'none', cursor: canSubmit ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            <Crown size={14} />
            {lang === 'es' ? 'Transferir' : 'Transfer'}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
  color: 'var(--text-secondary)', textTransform: 'uppercase', fontFamily: 'var(--font-sans)',
};

const inputStyle: React.CSSProperties = {
  height: 42, borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  padding: '0 12px', color: 'var(--text-primary)', fontSize: 14,
  fontFamily: 'var(--font-sans)', outline: 'none', width: '100%',
};

function ghostBtnStyle(color: string): React.CSSProperties {
  return {
    height: 44, padding: '0 12px', borderRadius: 'var(--radius-sm)',
    background: 'transparent', border: `1px solid var(--border)`,
    color, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex', alignItems: 'center', gap: 6,
  };
}
