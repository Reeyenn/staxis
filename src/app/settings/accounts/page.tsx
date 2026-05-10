'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { Users, Plus, Trash2, Pencil, X, Check, ChevronLeft, Shield, User, Mail, KeyRound, Copy } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api-fetch';

import { ALL_ROLES, ASSIGNABLE_ROLES, roleLabel, canManageTeam, type AppRole, type AssignableRole } from '@/lib/roles';

interface AccountRow {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  propertyAccess: string[];
  createdAt: string | null;
}

interface FormState {
  username: string;
  displayName: string;
  email: string;
  password: string;
  role: AppRole;
  propertyAccess: string[];  // property IDs, or ["*"] for all
}

const BLANK_FORM: FormState = {
  username: '',
  displayName: '',
  email: '',
  password: '',
  role: 'owner',
  propertyAccess: [],
};

export default function AccountsPage() {
  const { user } = useAuth();
  const { properties } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add/Edit modal state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Allow admin / owner / general_manager. Front-desk / housekeeping /
  // maintenance roles get bounced back to /settings.
  useEffect(() => {
    if (user && !canManageTeam(user.role)) router.replace('/settings');
  }, [user, router]);

  const isAdmin = user?.role === 'admin';

  // Hotels this user can manage. Admin sees all properties; owner/GM only
  // see hotels in their property_access (which is what useProperty already
  // returns since PropertyContext filters by access).
  const manageableHotels = properties;
  const [teamHotelId, setTeamHotelId] = useState<string>('');
  useEffect(() => {
    if (!teamHotelId && manageableHotels.length > 0) setTeamHotelId(manageableHotels[0].id);
  }, [manageableHotels, teamHotelId]);

  // ── Invites ──────────────────────────────────────────────────────────────
  interface InviteRow { id: string; email: string; role: AssignableRole; expires_at: string }
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableRole>('housekeeping');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    if (!user || !teamHotelId) return;
    const res = await fetchWithAuth(`/api/auth/invites?hotelId=${teamHotelId}`);
    if (res.ok) {
      const body = await res.json() as { data?: { invites?: InviteRow[] } };
      setInvites(body.data?.invites ?? []);
    }
  }, [user, teamHotelId]);

  // ── Join codes ───────────────────────────────────────────────────────────
  interface CodeRow { id: string; code: string; role: AssignableRole; expires_at: string; max_uses: number; used_count: number }
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeRole, setCodeRole] = useState<AssignableRole>('housekeeping');
  const [codeExpiryHours, setCodeExpiryHours] = useState(24);
  const [codeMaxUses, setCodeMaxUses] = useState(1);
  const [codeSubmitting, setCodeSubmitting] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [codeResult, setCodeResult] = useState<CodeRow | null>(null);

  const loadCodes = useCallback(async () => {
    if (!user || !teamHotelId) return;
    const res = await fetchWithAuth(`/api/auth/join-codes?hotelId=${teamHotelId}`);
    if (res.ok) {
      const body = await res.json() as { data?: { codes?: CodeRow[] } };
      setCodes(body.data?.codes ?? []);
    }
  }, [user, teamHotelId]);

  useEffect(() => { void loadInvites(); void loadCodes(); }, [loadInvites, loadCodes]);

  const handleInviteSubmit = async () => {
    if (!user || !teamHotelId) return;
    setInviteError('');
    setInviteSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: teamHotelId, email: inviteEmail.trim(), role: inviteRole }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { inviteLink?: string } };
      if (!res.ok || !body.ok) {
        setInviteError(body.error ?? 'Failed to send invite');
        return;
      }
      setInviteResult(body.data?.inviteLink ?? '');
      setInviteEmail('');
      void loadInvites();
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleRevokeInvite = async (id: string) => {
    if (!confirm(lang === 'es' ? '¿Revocar esta invitación?' : 'Revoke this invite?')) return;
    await fetchWithAuth(`/api/auth/invites?id=${id}`, { method: 'DELETE' });
    void loadInvites();
  };

  const handleGenerateCode = async () => {
    if (!user || !teamHotelId) return;
    setCodeError('');
    setCodeSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/auth/join-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: teamHotelId, role: codeRole, expiryHours: codeExpiryHours, maxUses: codeMaxUses }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { joinCode?: CodeRow } };
      if (!res.ok || !body.ok) {
        setCodeError(body.error ?? 'Failed to generate code');
        return;
      }
      setCodeResult(body.data?.joinCode ?? null);
      void loadCodes();
    } finally {
      setCodeSubmitting(false);
    }
  };

  const handleRevokeCode = async (id: string) => {
    if (!confirm(lang === 'es' ? '¿Revocar este código?' : 'Revoke this code?')) return;
    await fetchWithAuth(`/api/auth/join-codes?id=${id}`, { method: 'DELETE' });
    void loadCodes();
  };

  const loadAccounts = useCallback(async () => {
    // Only admin can list all accounts; owners/GMs use the team panel below.
    if (!user || user.role !== 'admin') { setLoading(false); return; }
    setLoading(true);
    try {
      // fetchWithAuth attaches the Authorization: Bearer <jwt> header. The
      // server-side admin gate now requires BOTH the bearer token AND the
      // x-account-id header; without the JWT, the route 403s. This closes
      // the privilege-escalation backdoor where someone who knew an admin
      // accountId could spoof admin access by sending only the header.
      const res = await fetchWithAuth('/api/auth/accounts', {
        headers: { 'x-account-id': user.accountId },
      });
      if (!res.ok) throw new Error('Failed to load accounts');
      // /api/auth/accounts now returns the standard ApiResponse envelope
      // ({ ok, requestId, data: { accounts: [...] } }) — read accounts off
      // body.data.accounts.
      const body = await res.json() as { ok?: boolean; data?: { accounts?: AccountRow[] }; error?: string };
      if (!body || !body.ok) throw new Error(body?.error ?? 'Failed to load accounts');
      setAccounts(body.data?.accounts ?? []);
    } catch (err) {
      setError('Failed to load accounts');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const openAdd = () => {
    setEditingId(null);
    setForm(BLANK_FORM);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (acct: AccountRow) => {
    setEditingId(acct.accountId);
    setForm({
      username: acct.username,
      displayName: acct.displayName,
      email: acct.email,
      password: '',
      role: acct.role,
      propertyAccess: acct.propertyAccess,
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!user) return;
    if (!form.username.trim()) { setFormError(lang === 'es' ? 'El nombre de usuario es requerido' : 'Username is required'); return; }
    if (!form.email.trim()) { setFormError(lang === 'es' ? 'El correo es requerido' : 'Email is required'); return; }
    if (!editingId && !form.password.trim()) { setFormError(lang === 'es' ? 'La contraseña es requerida para cuentas nuevas' : 'Password is required for new accounts'); return; }

    setSaving(true);
    setFormError('');

    try {
      if (editingId) {
        const res = await fetchWithAuth('/api/auth/accounts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
          body: JSON.stringify({
            accountId: editingId,
            displayName: form.displayName || form.username,
            email: form.email.trim(),
            role: form.role,
            propertyAccess: form.propertyAccess,
            ...(form.password ? { password: form.password } : {}),
          }),
        });
        if (!res.ok) {
          // Envelope on error: { ok: false, error }. Fall back if a future
          // migration ever returns a different shape.
          const d = await res.json().catch(() => ({})) as { error?: string };
          setFormError(d?.error || 'Failed to update');
          return;
        }
      } else {
        const res = await fetchWithAuth('/api/auth/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-account-id': user.accountId },
          body: JSON.stringify({
            username: form.username.trim(),
            displayName: form.displayName || form.username,
            email: form.email.trim(),
            password: form.password,
            role: form.role,
            propertyAccess: form.propertyAccess,
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({})) as { error?: string };
          setFormError(d?.error || 'Failed to create');
          return;
        }
      }

      setShowForm(false);
      await loadAccounts();
    } catch (err) {
      console.error(err);
      setFormError('An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (accountId: string) => {
    if (!user) return;
    if (!confirm(lang === 'es' ? '¿Eliminar esta cuenta?' : 'Delete this account?')) return;

    try {
      const res = await fetchWithAuth(`/api/auth/accounts?accountId=${accountId}`, {
        method: 'DELETE',
        headers: { 'x-account-id': user.accountId },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        alert(d?.error || 'Failed to delete');
        return;
      }
      await loadAccounts();
    } catch (err) {
      console.error(err);
      alert('Failed to delete account');
    }
  };

  const togglePropertyAccess = (pid: string) => {
    setForm(f => {
      if (f.propertyAccess.includes('*')) return f; // admin access - skip
      const has = f.propertyAccess.includes(pid);
      return {
        ...f,
        propertyAccess: has
          ? f.propertyAccess.filter(id => id !== pid)
          : [...f.propertyAccess, pid],
      };
    });
  };

  const setAdminAccess = (admin: boolean) => {
    setForm(f => ({ ...f, propertyAccess: admin ? ['*'] : [] }));
  };

  if (!user || !canManageTeam(user.role)) return null;

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Header */}
        <div className="animate-in">
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', fontSize: '13px',
              cursor: 'pointer', padding: '0 0 12px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <ChevronLeft size={14} />
            {t('settings', lang)}
          </button>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '16px', color: 'var(--text-primary)',
            letterSpacing: '-0.01em',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <Users size={15} color="var(--navy)" />
            {lang === 'es' ? 'Cuenta y equipo' : 'Account & Team'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            {lang === 'es' ? 'Tu perfil y cuentas del equipo.' : 'Your profile and team accounts.'}
          </p>
        </div>

        {/* Add button — admin only (full account creation w/ any role) */}
        {isAdmin && (
          <button
            onClick={openAdd}
            className="animate-in stagger-1"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: 'var(--navy-light)', color: '#FFFFFF',
              border: 'none', borderRadius: 'var(--radius-md)',
              padding: '10px 16px', fontSize: '14px', fontWeight: 600,
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              alignSelf: 'flex-start',
            }}
          >
            <Plus size={15} />
            {lang === 'es' ? 'Agregar cuenta' : 'Add account'}
          </button>
        )}

        {/* All-accounts list — admin only */}
        {isAdmin && (loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
            <div className="spinner" style={{ width: '28px', height: '28px' }} />
          </div>
        ) : error ? (
          <p style={{ color: 'var(--red)', fontSize: '14px' }}>{error}</p>
        ) : (
          <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {accounts.map(acct => (
              <div key={acct.accountId} style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', padding: '14px 16px',
                display: 'flex', alignItems: 'center', gap: '14px',
              }}>
                {/* Avatar */}
                <div style={{
                  width: '38px', height: '38px', borderRadius: '50%',
                  background: acct.role === 'admin' ? 'var(--amber-dim)' : 'rgba(100,116,139,0.12)',
                  border: `1px solid ${acct.role === 'admin' ? 'var(--amber-border)' : 'var(--border)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {acct.role === 'admin'
                    ? <Shield size={16} color="var(--amber)" />
                    : <User size={16} color="var(--text-muted)" />
                  }
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '14px', fontWeight: 600,
                    color: 'var(--text-primary)', fontFamily: 'var(--font-sans)',
                  }}>
                    {acct.displayName}
                    <span style={{
                      marginLeft: '8px', fontSize: '11px', fontWeight: 500,
                      color: 'var(--text-muted)', letterSpacing: '0.02em',
                    }}>
                      @{acct.username}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {acct.role}
                    {' · '}
                    {acct.propertyAccess.includes('*')
                      ? (lang === 'es' ? 'Todas las propiedades' : 'All properties')
                      : acct.propertyAccess.length === 0
                        ? (lang === 'es' ? 'Sin propiedades' : 'No properties')
                        : acct.propertyAccess.length === 1
                          ? (lang === 'es' ? '1 propiedad' : '1 property')
                          : `${acct.propertyAccess.length} ${lang === 'es' ? 'propiedades' : 'properties'}`
                    }
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    onClick={() => openEdit(acct)}
                    aria-label={lang === 'es' ? `Editar ${acct.displayName}` : `Edit ${acct.displayName}`}
                    style={{
                      width: '32px', height: '32px', borderRadius: 'var(--radius-sm)',
                      background: 'transparent', border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: 'var(--text-muted)',
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  {acct.accountId !== user.accountId && (
                    <button
                      onClick={() => handleDelete(acct.accountId)}
                      aria-label={lang === 'es' ? `Eliminar ${acct.displayName}` : `Delete ${acct.displayName}`}
                      style={{
                        width: '32px', height: '32px', borderRadius: 'var(--radius-sm)',
                        background: 'transparent', border: '1px solid var(--red-border, rgba(239,68,68,0.3))',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: 'var(--red)',
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* ─── Team management — visible to admin / owner / GM ───────────── */}
        <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {lang === 'es' ? 'Equipo' : 'Team'}
          </h2>

          {manageableHotels.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{lang === 'es' ? 'Hotel' : 'Hotel'}</label>
              <select value={teamHotelId} onChange={e => setTeamHotelId(e.target.value)} style={{ ...inputStyle, height: '42px' }}>
                {manageableHotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => { setInviteResult(null); setInviteError(''); setShowInviteModal(true); }} style={teamBtnStyle}>
              <Mail size={14} />
              {lang === 'es' ? 'Invitar por correo' : 'Invite by email'}
            </button>
            <button onClick={() => { setCodeResult(null); setCodeError(''); setShowCodeModal(true); }} style={teamBtnStyle}>
              <KeyRound size={14} />
              {lang === 'es' ? 'Generar código' : 'Generate code'}
            </button>
          </div>

          {/* Pending invites */}
          {invites.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <h3 style={subHeadingStyle}>{lang === 'es' ? 'Invitaciones pendientes' : 'Pending invites'}</h3>
              {invites.map(iv => (
                <div key={iv.id} style={teamRowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{iv.email}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {roleLabel(iv.role)} · {lang === 'es' ? 'expira' : 'expires'} {new Date(iv.expires_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button onClick={() => handleRevokeInvite(iv.id)} style={revokeBtnStyle} aria-label="Revoke">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Active codes */}
          {codes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <h3 style={subHeadingStyle}>{lang === 'es' ? 'Códigos activos' : 'Active codes'}</h3>
              {codes.map(c => (
                <div key={c.id} style={teamRowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', color: 'var(--text-primary)' }}>
                      {c.code}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {roleLabel(c.role)} · {c.used_count}/{c.max_uses} {lang === 'es' ? 'usados' : 'used'} · {lang === 'es' ? 'expira' : 'expires'} {new Date(c.expires_at).toLocaleString()}
                    </div>
                  </div>
                  <button onClick={() => navigator.clipboard?.writeText(c.code)} style={iconBtnStyle} aria-label="Copy">
                    <Copy size={13} />
                  </button>
                  <button onClick={() => handleRevokeCode(c.id)} style={revokeBtnStyle} aria-label="Revoke">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Add/Edit modal */}
      {showForm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 60,
          background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '20px',
        }}
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '480px',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-bright)',
            padding: '24px 20px 28px',
            maxHeight: '90vh', overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>

            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{
                fontFamily: 'var(--font-sans)', fontWeight: 700,
                fontSize: '18px', color: 'var(--text-primary)',
              }}>
                {editingId
                  ? (lang === 'es' ? 'Editar cuenta' : 'Edit account')
                  : (lang === 'es' ? 'Agregar cuenta' : 'Add account')}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                aria-label={lang === 'es' ? 'Cerrar' : 'Close'}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--text-muted)', cursor: 'pointer',
                  display: 'flex', padding: '4px',
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Username */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{t('username', lang)}</label>
              <input
                type="text"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                disabled={!!editingId}
                placeholder={lang === 'es' ? 'minúsculas, sin espacios' : 'lowercase, no spaces'}
                style={{ ...inputStyle, opacity: editingId ? 0.5 : 1 }}
              />
            </div>

            {/* Display name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{t('name', lang)}</label>
              <input
                type="text"
                value={form.displayName}
                onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
                placeholder={lang === 'es' ? 'Nombre completo (ej. Jay Patel)' : 'Full name (e.g. Jay Patel)'}
                style={inputStyle}
              />
            </div>

            {/* Email — used for sign-in and password recovery */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{lang === 'es' ? 'Correo electrónico' : 'Email'}</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="name@example.com"
                autoCapitalize="off"
                spellCheck={false}
                style={inputStyle}
              />
            </div>

            {/* Password */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{editingId ? t('password', lang) : t('password', lang)}</label>
              <input
                type="password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder={editingId ? (lang === 'es' ? 'Dejar en blanco para mantener actual' : 'Leave blank to keep current') : (lang === 'es' ? 'Establecer contraseña' : 'Set a password')}
                style={inputStyle}
              />
            </div>

            {/* Role */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{t('type', lang)}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {ALL_ROLES.filter(r => r !== 'staff').map(r => (
                  <button key={r} onClick={() => setForm(f => ({ ...f, role: r }))} style={{
                    minWidth: '90px', flex: '1 1 90px', height: '36px',
                    borderRadius: 'var(--radius-sm)',
                    background: form.role === r ? 'var(--amber-dim)' : 'var(--bg-card)',
                    border: `1px solid ${form.role === r ? 'var(--amber-border)' : 'var(--border)'}`,
                    color: form.role === r ? 'var(--amber)' : 'var(--text-secondary)',
                    fontSize: '12px', fontWeight: form.role === r ? 600 : 400,
                    cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  }}>
                    {roleLabel(r)}
                  </button>
                ))}
              </div>
            </div>

            {/* Property access */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={labelStyle}>{t('property', lang)}</label>

              {/* All properties toggle */}
              <button
                onClick={() => setAdminAccess(!form.propertyAccess.includes('*'))}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: form.propertyAccess.includes('*') ? 'var(--amber-dim)' : 'var(--bg-card)',
                  border: `1px solid ${form.propertyAccess.includes('*') ? 'var(--amber-border)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)', padding: '10px 12px',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
                  {lang === 'es' ? 'Todas las propiedades (actuales y futuras)' : 'All properties (current & future)'}
                </span>
                {form.propertyAccess.includes('*') && <Check size={14} color="var(--amber)" />}
              </button>

              {/* Individual property toggles */}
              {!form.propertyAccess.includes('*') && properties.map(p => (
                <button
                  key={p.id}
                  onClick={() => togglePropertyAccess(p.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: form.propertyAccess.includes(p.id) ? 'var(--green-dim)' : 'var(--bg-card)',
                    border: `1px solid ${form.propertyAccess.includes(p.id) ? 'var(--green-border, rgba(34,197,94,0.25))' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)', padding: '10px 12px',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
                    {p.name}
                  </span>
                  {form.propertyAccess.includes(p.id) && <Check size={14} color="var(--green)" />}
                </button>
              ))}
            </div>

            {formError && (
              <p style={{
                fontSize: '13px', color: 'var(--red)',
                background: 'var(--red-dim)',
                border: '1px solid var(--red-border, rgba(239,68,68,0.25))',
                borderRadius: 'var(--radius-sm)', padding: '10px 12px',
              }}>
                {formError}
              </p>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                height: '48px', borderRadius: 'var(--radius-md)',
                background: saving ? 'rgba(37,99,235,0.5)' : 'var(--navy-light)',
                color: '#FFFFFF',
                fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
                border: 'none', cursor: saving ? 'wait' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {saving
                ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                : editingId ? t('saveChanges', lang) : (lang === 'es' ? 'Crear cuenta' : 'Create account')
              }
            </button>
          </div>
        </div>
      )}

      {/* ─── Invite-by-email modal ──────────────────────────────────────── */}
      {showInviteModal && (
        <ModalShell onClose={() => setShowInviteModal(false)} title={lang === 'es' ? 'Invitar por correo' : 'Invite by email'}>
          {inviteResult !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {lang === 'es' ? 'Invitación enviada. Comparte este enlace si el correo no llega:' : 'Invite sent. Share this link if the email doesn’t arrive:'}
              </p>
              <input readOnly value={inviteResult ?? ''} style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: '12px' }} onFocus={e => e.currentTarget.select()} />
              <button onClick={() => setShowInviteModal(false)} style={primaryBtnStyle(false)}>
                {lang === 'es' ? 'Cerrar' : 'Close'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={labelStyle}>{lang === 'es' ? 'Correo' : 'Email'}</label>
                <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="name@example.com" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={labelStyle}>{lang === 'es' ? 'Rol' : 'Role'}</label>
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value as AssignableRole)} style={{ ...inputStyle, height: '42px' }}>
                  {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </div>
              {inviteError && <ErrorBox>{inviteError}</ErrorBox>}
              <button disabled={inviteSubmitting || !inviteEmail.trim()} onClick={handleInviteSubmit} style={primaryBtnStyle(inviteSubmitting || !inviteEmail.trim())}>
                {inviteSubmitting
                  ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                  : (lang === 'es' ? 'Enviar invitación' : 'Send invite')}
              </button>
            </div>
          )}
        </ModalShell>
      )}

      {/* ─── Generate-join-code modal ──────────────────────────────────── */}
      {showCodeModal && (
        <ModalShell onClose={() => setShowCodeModal(false)} title={lang === 'es' ? 'Generar código' : 'Generate code'}>
          {codeResult ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {lang === 'es' ? 'Código creado. Compártelo con la persona que se va a unir:' : 'Code created. Share it with the person joining:'}
              </p>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '20px', fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: 'var(--text-primary)' }}>{codeResult.code}</span>
                <button onClick={() => navigator.clipboard?.writeText(codeResult.code)} style={iconBtnStyle} aria-label="Copy">
                  <Copy size={14} />
                </button>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {roleLabel(codeResult.role)} · {lang === 'es' ? 'usar en' : 'use at'} <code>/join</code> · {lang === 'es' ? 'expira' : 'expires'} {new Date(codeResult.expires_at).toLocaleString()}
              </p>
              <button onClick={() => setShowCodeModal(false)} style={primaryBtnStyle(false)}>
                {lang === 'es' ? 'Cerrar' : 'Close'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={labelStyle}>{lang === 'es' ? 'Rol' : 'Role'}</label>
                <select value={codeRole} onChange={e => setCodeRole(e.target.value as AssignableRole)} style={{ ...inputStyle, height: '42px' }}>
                  {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>{lang === 'es' ? 'Validez (h)' : 'Valid for (hr)'}</label>
                  <input type="number" min={1} max={720} value={codeExpiryHours} onChange={e => setCodeExpiryHours(Number(e.target.value))} style={inputStyle} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>{lang === 'es' ? 'Usos máx.' : 'Max uses'}</label>
                  <input type="number" min={1} max={100} value={codeMaxUses} onChange={e => setCodeMaxUses(Number(e.target.value))} style={inputStyle} />
                </div>
              </div>
              {codeError && <ErrorBox>{codeError}</ErrorBox>}
              <button disabled={codeSubmitting} onClick={handleGenerateCode} style={primaryBtnStyle(codeSubmitting)}>
                {codeSubmitting
                  ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                  : (lang === 'es' ? 'Generar' : 'Generate')}
              </button>
            </div>
          )}
        </ModalShell>
      )}
    </AppLayout>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: '100%', maxWidth: '440px',
        background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-bright)', padding: '20px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: '13px', color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: 0 }}>
      {children}
    </p>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 600,
  letterSpacing: '0.04em', color: 'var(--text-secondary)',
  textTransform: 'uppercase', fontFamily: 'var(--font-sans)',
};

const inputStyle: React.CSSProperties = {
  height: '42px', borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  padding: '0 12px',
  color: 'var(--text-primary)', fontSize: '14px',
  fontFamily: 'var(--font-sans)',
  outline: 'none', width: '100%',
};

const subHeadingStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em',
  color: 'var(--text-muted)', textTransform: 'uppercase',
  fontFamily: 'var(--font-sans)',
};

const teamBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '8px',
  background: 'var(--bg-card)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
  padding: '10px 14px', fontSize: '13px', fontWeight: 600,
  cursor: 'pointer', fontFamily: 'var(--font-sans)',
};

const teamRowStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)', padding: '10px 12px',
  display: 'flex', alignItems: 'center', gap: '10px',
};

const iconBtnStyle: React.CSSProperties = {
  width: '32px', height: '32px', borderRadius: 'var(--radius-sm)',
  background: 'transparent', border: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: 'var(--text-muted)',
};

const revokeBtnStyle: React.CSSProperties = {
  width: '32px', height: '32px', borderRadius: 'var(--radius-sm)',
  background: 'transparent', border: '1px solid var(--red-border, rgba(239,68,68,0.3))',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: 'var(--red)',
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: '44px',
    borderRadius: 'var(--radius-md)',
    background: disabled ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
    color: '#FFFFFF', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '14px',
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
