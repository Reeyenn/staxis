'use client';

// Settings → Account & Team — the team-members concern (member list for the
// selected hotel + edit-member modal + remove-access), extracted verbatim
// from accounts/page.tsx in the by-concern file split.
//
// Visible to admin / owner / GM via the /api/auth/team endpoint, which
// returns every account with access to the selected hotel (including
// admins, since they implicitly have access everywhere).

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2, Pencil, Shield, User } from 'lucide-react';

import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ASSIGNABLE_ROLES, roleLabel, type AssignableRole } from '@/lib/roles';
import type { AppUser } from '@/contexts/AuthContext';

import {
  type AccountRow, ErrorBox, ModalShell,
  labelStyle, inputStyle, subHeadingStyle, iconBtnStyle, revokeBtnStyle, primaryBtnStyle,
} from './shared';

export function TeamMembers({ user, hotelId }: { user: AppUser; hotelId: string }) {
  const { lang } = useLang();

  const [team, setTeam] = useState<AccountRow[]>([]);
  const [editMember, setEditMember] = useState<AccountRow | null>(null);

  const loadTeam = useCallback(async () => {
    if (!user || !hotelId) return;
    const res = await fetchWithAuth(`/api/auth/team?hotelId=${hotelId}`);
    if (res.ok) {
      const body = await res.json() as { data?: { team?: AccountRow[] } };
      setTeam(body.data?.team ?? []);
    }
  }, [user, hotelId]);
  useEffect(() => { void loadTeam(); }, [loadTeam]);

  const handleRemoveMember = async (m: AccountRow) => {
    if (!user || !hotelId) return;
    if (m.role === 'admin') return;
    if (m.accountId === user.accountId) return;
    const msg = lang === 'es'
      ? `Quitar acceso de ${m.displayName} a este hotel? La cuenta sigue existiendo pero ya no podrá entrar a este hotel.`
      : `Remove ${m.displayName}'s access to this hotel? The account stays alive but won't be able to access this hotel anymore.`;
    if (!confirm(msg)) return;
    const res = await fetchWithAuth(
      `/api/auth/team?hotelId=${hotelId}&accountId=${m.accountId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      alert(body.error ?? 'Failed to remove access');
      return;
    }
    void loadTeam();
  };

  return (
    <>
      {/* Existing team members for the selected hotel — visible to
          admin/owner/GM. Admins are included since they implicitly
          have access to every hotel. */}
      {team.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <h3 style={subHeadingStyle}>
            {lang === 'es' ? 'Miembros del equipo' : 'Team members'} ({team.length})
          </h3>
          {team.map(m => {
            // Admins can't be edited/removed from this owner-facing
            // surface. Owners can't remove themselves (would lock
            // themselves out of their own hotel). Self-edit is allowed
            // for changing display name / password.
            const canEdit = m.role !== 'admin';
            const canRemove = m.role !== 'admin' && m.accountId !== user.accountId;
            return (
              <div key={m.accountId} style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: '12px 14px',
                display: 'flex', alignItems: 'center', gap: '12px',
              }}>
                <div style={{
                  width: '34px', height: '34px', borderRadius: '50%',
                  background: m.role === 'admin' ? 'var(--amber-dim)' : 'rgba(100,116,139,0.12)',
                  border: `1px solid ${m.role === 'admin' ? 'var(--amber-border)' : 'var(--border)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {m.role === 'admin'
                    ? <Shield size={14} color="var(--amber)" />
                    : <User size={14} color="var(--text-muted)" />
                  }
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {m.displayName}
                    {m.accountId === user.accountId && (
                      <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
                        {lang === 'es' ? '(tú)' : '(you)'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {roleLabel(m.role)} · {m.email}
                  </div>
                </div>
                {canEdit && (
                  <button
                    onClick={() => setEditMember(m)}
                    aria-label={lang === 'es' ? `Editar ${m.displayName}` : `Edit ${m.displayName}`}
                    style={iconBtnStyle}
                  >
                    <Pencil size={13} />
                  </button>
                )}
                {canRemove && (
                  <button
                    onClick={() => handleRemoveMember(m)}
                    aria-label={lang === 'es' ? `Quitar acceso de ${m.displayName}` : `Remove ${m.displayName}`}
                    title={lang === 'es' ? 'Quitar acceso a este hotel' : 'Remove access to this hotel'}
                    style={revokeBtnStyle}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Edit team member modal (owners/GMs) ───────────────────────── */}
      {editMember && hotelId && (
        <EditMemberModal
          member={editMember}
          hotelId={hotelId}
          isSelf={editMember.accountId === user.accountId}
          onClose={() => setEditMember(null)}
          onSaved={() => { setEditMember(null); void loadTeam(); }}
        />
      )}
    </>
  );
}

function EditMemberModal({ member, hotelId, isSelf, onClose, onSaved }: {
  member: AccountRow;
  hotelId: string;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { lang } = useLang();
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<AssignableRole>(member.role === 'admin' ? 'owner' : (member.role as AssignableRole));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { hotelId, accountId: member.accountId };
      if (displayName.trim() && displayName.trim() !== member.displayName) payload.displayName = displayName.trim();
      if (!isSelf && role !== member.role) payload.role = role;
      if (password) {
        if (password.length < 6) { setError(lang === 'es' ? 'La contraseña debe tener al menos 6 caracteres' : 'Password must be at least 6 characters'); return; }
        payload.password = password;
      }
      if (Object.keys(payload).length === 2) {
        setError(lang === 'es' ? 'Nada cambió' : 'Nothing changed');
        return;
      }
      const res = await fetchWithAuth('/api/auth/team', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Failed to save');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      title={lang === 'es' ? `Editar ${member.displayName}` : `Edit ${member.displayName}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={labelStyle}>{lang === 'es' ? 'Nombre' : 'Name'}</label>
        <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={labelStyle}>{lang === 'es' ? 'Correo' : 'Email'}</label>
        <input type="email" value={member.email} readOnly style={{ ...inputStyle, opacity: 0.6 }} />
      </div>
      {!isSelf && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={labelStyle}>{lang === 'es' ? 'Rol' : 'Role'}</label>
          <select value={role} onChange={e => setRole(e.target.value as AssignableRole)} style={{ ...inputStyle, height: '42px' }}>
            {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label style={labelStyle}>
          {lang === 'es' ? 'Nueva contraseña (opcional)' : 'New password (optional)'}
        </label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={lang === 'es' ? 'Dejar en blanco para mantener actual' : 'Leave blank to keep current'}
          style={inputStyle}
        />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <button disabled={saving} onClick={submit} style={primaryBtnStyle(saving)}>
        {saving
          ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
          : (lang === 'es' ? 'Guardar' : 'Save changes')}
      </button>
    </ModalShell>
  );
}
