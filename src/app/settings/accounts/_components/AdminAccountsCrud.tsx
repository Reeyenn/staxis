'use client';

// Settings → Account & Team — the admin-only account CRUD concern
// (full-accounts list + Add/Edit modal + delete), extracted verbatim from
// accounts/page.tsx in the by-concern file split. Renders a fragment so the
// pieces stay direct flex items of the page's column (identical spacing).
//
// Every /api/auth/accounts call sends BOTH the Authorization bearer (via
// fetchWithAuth) AND the x-account-id header — the server-side admin gate
// requires the pair. Do not drop either header.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, X, Check, Shield, User } from 'lucide-react';

import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { fetchWithAuth } from '@/lib/api-fetch';
import { captureException } from '@/lib/sentry';
import { ALL_ROLES, roleLabel, type AppRole } from '@/lib/roles';
import type { AppUser } from '@/contexts/AuthContext';

import { type AccountRow, labelStyle, inputStyle } from './shared';

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

export function AdminAccountsCrud({ user }: { user: AppUser }) {
  const { properties } = useProperty();
  const { lang } = useLang();
  // Read language via a ref so loadAccounts() below does not depend on `lang` —
  // otherwise toggling EN/ES recreates it, refires the load effect, flashes the
  // loading state and refetches the account list, which isn't language-
  // dependent. `lang` is used only for the error string.
  const langRef = useRef(lang);
  langRef.current = lang;

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add/Edit modal state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const isAdmin = user.role === 'admin';

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
      setError(langRef.current === 'es' ? 'No se pudieron cargar las cuentas' : 'Failed to load accounts');
      captureException(err, { route: 'settings/accounts', op: 'loadAccounts' });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

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
          setFormError(d?.error || (lang === 'es' ? 'No se pudo crear' : 'Failed to create'));
          return;
        }
      }

      setShowForm(false);
      await loadAccounts();
    } catch (err) {
      console.error(err);
      setFormError(lang === 'es' ? 'Ocurrió un error' : 'An error occurred');
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
        alert(d?.error || (lang === 'es' ? 'No se pudo eliminar' : 'Failed to delete'));
        return;
      }
      await loadAccounts();
    } catch (err) {
      console.error(err);
      alert(lang === 'es' ? 'No se pudo eliminar la cuenta' : 'Failed to delete account');
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

  return (
    <>
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
              <label style={labelStyle}>{t('password', lang)}</label>
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
    </>
  );
}
