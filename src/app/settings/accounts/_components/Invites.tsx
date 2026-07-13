'use client';

// Settings → Account & Team — the invite-by-email concern (pending-invites
// list + invite modal + revoke), extracted verbatim from accounts/page.tsx
// in the by-concern file split.
//
// Exposed as a hook (useConfirm-style: state + rendered elements) because
// the page composes the "Invite by email" button into a shared row with the
// join-codes button, while the list and modal render elsewhere — and invite
// state (typed email, last result) must survive the modal closing, exactly
// as it did when the state lived in the page component.

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { ASSIGNABLE_ROLES, roleLabel, type AssignableRole } from '@/lib/roles';
import type { AppUser } from '@/contexts/AuthContext';

import {
  ErrorBox, ModalShell,
  labelStyle, inputStyle, subHeadingStyle, revokeBtnStyle, primaryBtnStyle,
} from './shared';

interface InviteRow { id: string; email: string; role: AssignableRole; expires_at: string }

export function useInvites(user: AppUser | null, hotelId: string): {
  /** The "Invite by email" button's onClick (resets result/error, opens). */
  openModal: () => void;
  /** Pending-invites list (null when there are none). */
  list: React.ReactNode;
  /** The invite modal (null when closed). */
  modal: React.ReactNode;
} {
  const { lang } = useLang();

  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableRole>('housekeeping');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    if (!user || !hotelId) return;
    try {
      const res = await fetchWithAuth(`/api/auth/invites?hotelId=${hotelId}`);
      if (!res.ok) { setLoadError(true); return; } // don't render "no invites" for a failed load
      const body = await res.json() as { data?: { invites?: InviteRow[] } };
      setInvites(body.data?.invites ?? []);
      setLoadError(false);
    } catch (err) {
      console.error('[accounts:invites] load failed', err);
      setLoadError(true);
    }
  }, [user, hotelId]);

  useEffect(() => { void loadInvites(); }, [loadInvites]);

  const handleInviteSubmit = async () => {
    if (!user || !hotelId) return;
    setInviteError('');
    setInviteSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, email: inviteEmail.trim(), role: inviteRole }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { inviteLink?: string } };
      if (!res.ok || !body.ok) {
        setInviteError(body.error ?? 'Failed to send invite');
        return;
      }
      setInviteResult(body.data?.inviteLink ?? '');
      setInviteEmail('');
      void loadInvites();
    } catch (err) {
      console.error('[accounts:invites] send failed', err);
      setInviteError(lang === 'es' ? 'No se pudo enviar la invitación — revisa tu conexión' : 'Failed to send the invite — check your connection');
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleRevokeInvite = async (id: string) => {
    if (!confirm(lang === 'es' ? '¿Revocar esta invitación?' : 'Revoke this invite?')) return;
    // A failed revoke must not look like success — the invite link would stay
    // redeemable. Same alert idiom as TeamMembers.handleRemoveMember.
    try {
      const res = await fetchWithAuth(`/api/auth/invites?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        alert(body.error ?? (lang === 'es' ? 'No se pudo revocar la invitación. Sigue activa — intenta de nuevo.' : 'Failed to revoke the invite. It is still active — try again.'));
        return;
      }
      void loadInvites();
    } catch (err) {
      console.error('[accounts:invites] revoke failed', err);
      alert(lang === 'es' ? 'No se pudo revocar la invitación — revisa tu conexión. Sigue activa.' : 'Failed to revoke the invite — check your connection. It is still active.');
    }
  };

  // Pending invites
  const list = loadError ? (
    <ErrorBox>
      {lang === 'es'
        ? 'No se pudieron cargar las invitaciones pendientes. Recarga la página para intentar de nuevo.'
        : 'Couldn’t load pending invites. Refresh the page to try again.'}
    </ErrorBox>
  ) : invites.length > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <h3 style={subHeadingStyle}>{lang === 'es' ? 'Invitaciones pendientes' : 'Pending invites'}</h3>
      {invites.map(iv => (
        <div key={iv.id} style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '10px 12px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
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
  ) : null;

  // ─── Invite-by-email modal ──────────────────────────────────────────────
  const modal = showInviteModal ? (
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
  ) : null;

  return {
    openModal: () => { setInviteResult(null); setInviteError(''); setShowInviteModal(true); },
    list,
    modal,
  };
}
