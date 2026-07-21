'use client';

// InviteStaffPanel — the single, unified "bring people in" surface.
//
// One invite system: the hotel has a shared join code, and the invite LINK is
// just that code in a URL ({origin}/signup?code=XXXX). Employees sign up
// through it, pick their department, and land as PENDING join requests the
// manager approves from the Directory. Email invites remain ONLY as the way to
// bring in a manager (general_manager) — line staff never need an email invite.
//
// Rendered in two places with the same behaviour:
//   • Staff → Directory, inside a modal (variant="modal", header + close).
//   • Settings → Account & Team, as an always-visible card (variant="card").
//
// APIs (all manage_team-gated, service-role behind the route):
//   • GET/POST/DELETE /api/auth/join-codes — the shared code + link + QR.
//   • GET/POST/DELETE /api/auth/invites    — the manager-only email invite.
//
// Styling uses global CSS variables (var(--…)) so the component drops cleanly
// into both the settings surface and the staff surface without importing
// either one's token module.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Check, RefreshCw, Trash2, Mail } from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import type { AssignableRole } from '@/lib/roles';

import styles from './InviteStaffPanel.module.css';

interface CodeRow {
  id: string;
  code: string;
  role: AssignableRole | null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  created_at?: string;
}

interface InviteRow {
  id: string;
  email: string;
  role: AssignableRole;
  expires_at: string;
}

type Lang = 'en' | 'es';

// Build the shareable signup URL for a code. Computed at render/click time so
// it always reflects the current origin. Mirrors the settings JoinCodes
// helper: on localhost we echo the real origin (so dev QA links are
// clickable); everywhere else we use the canonical getstaxis.com host so we
// never leak the pre-domain hotelops-ai.vercel.app alias to staff. SSR-safe.
function signupLinkFor(code: string): string {
  if (typeof window === 'undefined') return `/signup?code=${code}`;
  const { hostname, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${origin}/signup?code=${code}`;
  }
  return `https://getstaxis.com/signup?code=${code}`;
}

// A code is usable only if it hasn't expired AND hasn't hit its use cap. The
// join-codes GET already excludes revoked codes but returns expired/used-up
// ones, so we filter here and treat "no usable code" as "auto-create one".
function isUsable(c: CodeRow): boolean {
  const notExpired = new Date(c.expires_at).getTime() > Date.now();
  const hasUses = c.used_count < c.max_uses;
  return notExpired && hasUses;
}

export function InviteStaffPanel({
  hotelId, lang, variant = 'card', onClose,
}: {
  hotelId: string;
  lang: Lang;
  variant?: 'modal' | 'card';
  onClose?: () => void;
}) {
  // ── Join-code / link / QR state ─────────────────────────────────────────
  const [code, setCode] = useState<CodeRow | null>(null);
  const [codeLoading, setCodeLoading] = useState(true);
  const [codeError, setCodeError] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  // Guards the auto-create so a re-render mid-flight can't mint a second code.
  const creatingRef = useRef(false);

  // ── Email-invite (manager-only) state ───────────────────────────────────
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState(false);

  // ── Load (or auto-create) the active code ───────────────────────────────
  const loadCode = useCallback(async () => {
    if (!hotelId) return;
    setCodeError('');
    try {
      const res = await fetchWithAuth(`/api/auth/join-codes?hotelId=${hotelId}`);
      if (!res.ok) {
        setCodeError(lang === 'es' ? 'No se pudo cargar el enlace de invitación.' : "Couldn't load the invite link.");
        setCodeLoading(false);
        return;
      }
      const body = await res.json() as { data?: { codes?: CodeRow[] } };
      const usable = (body.data?.codes ?? []).find(isUsable) ?? null;
      if (usable) {
        setCode(usable);
        setCodeLoading(false);
        return;
      }
      // No usable code — auto-create one. Guard against concurrent creates.
      if (creatingRef.current) return;
      creatingRef.current = true;
      const created = await fetchWithAuth('/api/auth/join-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId }),
      });
      const cBody = await created.json() as { ok?: boolean; error?: string; data?: { joinCode?: CodeRow } };
      if (!created.ok || !cBody.ok || !cBody.data?.joinCode) {
        setCodeError(cBody.error ?? (lang === 'es' ? 'No se pudo crear el enlace de invitación.' : "Couldn't create the invite link."));
      } else {
        setCode(cBody.data.joinCode);
      }
    } catch (err) {
      console.error('[InviteStaffPanel] load code failed', err);
      setCodeError(lang === 'es' ? 'No se pudo cargar el enlace — revisa tu conexión.' : "Couldn't load the link — check your connection.");
    } finally {
      creatingRef.current = false;
      setCodeLoading(false);
    }
  }, [hotelId, lang]);

  useEffect(() => { setCodeLoading(true); void loadCode(); }, [loadCode]);

  // Render the QR whenever the active code changes.
  useEffect(() => {
    if (!code) { setQrDataUrl(''); return; }
    let active = true;
    QRCode.toDataURL(signupLinkFor(code.code), {
      width: 320, margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#1F231C', light: '#FFFFFF' },
    })
      .then(url => { if (active) setQrDataUrl(url); })
      .catch(err => { console.error('[InviteStaffPanel] QR render failed', err); });
    return () => { active = false; };
  }, [code]);

  const doCopy = async (value: string, which: 'link' | 'code') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      window.setTimeout(() => setCopied(c => (c === which ? null : c)), 1800);
    } catch {
      // Clipboard API fails on insecure origins / embedded contexts — fall
      // back to a prompt so the user can still grab the value.
      window.prompt(lang === 'es' ? 'Copiar:' : 'Copy:', value);
    }
  };

  // "New link" — revoke the current code and mint a fresh one. Confirmed
  // because the old link + QR stop working the moment we revoke.
  const handleNewLink = async () => {
    const msg = lang === 'es'
      ? 'Esto crea un enlace nuevo. El enlace y el código QR actuales dejarán de funcionar. ¿Continuar?'
      : 'This creates a fresh link. The current link and QR code will stop working. Continue?';
    if (!window.confirm(msg)) return;
    setRegenerating(true);
    setCodeError('');
    try {
      if (code) {
        const del = await fetchWithAuth(`/api/auth/join-codes?id=${code.id}`, { method: 'DELETE' });
        if (!del.ok) {
          setCodeError(lang === 'es' ? 'No se pudo reemplazar el enlace. Intenta de nuevo.' : "Couldn't replace the link. Try again.");
          setRegenerating(false);
          return;
        }
      }
      const created = await fetchWithAuth('/api/auth/join-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId }),
      });
      const cBody = await created.json() as { ok?: boolean; error?: string; data?: { joinCode?: CodeRow } };
      if (!created.ok || !cBody.ok || !cBody.data?.joinCode) {
        setCodeError(cBody.error ?? (lang === 'es' ? 'No se pudo crear el enlace nuevo.' : "Couldn't create the new link."));
      } else {
        setCode(cBody.data.joinCode);
      }
    } catch (err) {
      console.error('[InviteStaffPanel] new link failed', err);
      setCodeError(lang === 'es' ? 'No se pudo crear el enlace nuevo — revisa tu conexión.' : "Couldn't create the new link — check your connection.");
    } finally {
      setRegenerating(false);
    }
  };

  // ── Email invites (manager-only) ─────────────────────────────────────────
  const loadInvites = useCallback(async () => {
    if (!hotelId) return;
    try {
      const res = await fetchWithAuth(`/api/auth/invites?hotelId=${hotelId}`);
      if (!res.ok) return; // non-fatal; the list just stays empty
      const body = await res.json() as { data?: { invites?: InviteRow[] } };
      setInvites(body.data?.invites ?? []);
    } catch (err) {
      console.error('[InviteStaffPanel] load invites failed', err);
    }
  }, [hotelId]);

  useEffect(() => { void loadInvites(); }, [loadInvites]);

  const handleSendInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteError('');
    setInviteSuccess(false);
    setInviteSubmitting(true);
    try {
      // Role is intentionally fixed to general_manager: this section only ever
      // invites a manager. Line staff join through the code/link above.
      const res = await fetchWithAuth('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, email, role: 'general_manager' }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setInviteError(body.error ?? (lang === 'es' ? 'No se pudo enviar la invitación.' : 'Failed to send the invite.'));
        return;
      }
      setInviteSuccess(true);
      setInviteEmail('');
      void loadInvites();
    } catch (err) {
      console.error('[InviteStaffPanel] send invite failed', err);
      setInviteError(lang === 'es' ? 'No se pudo enviar la invitación — revisa tu conexión.' : 'Failed to send the invite — check your connection.');
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleRevokeInvite = async (id: string) => {
    if (!window.confirm(lang === 'es' ? '¿Revocar esta invitación?' : 'Revoke this invite?')) return;
    try {
      const res = await fetchWithAuth(`/api/auth/invites?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        window.alert(body.error ?? (lang === 'es' ? 'No se pudo revocar. Sigue activa — intenta de nuevo.' : 'Failed to revoke. It is still active — try again.'));
        return;
      }
      void loadInvites();
    } catch (err) {
      console.error('[InviteStaffPanel] revoke invite failed', err);
      window.alert(lang === 'es' ? 'No se pudo revocar — revisa tu conexión. Sigue activa.' : 'Failed to revoke — check your connection. It is still active.');
    }
  };

  // ── Styles (global CSS vars, theme-aware) ────────────────────────────────
  const link = code ? signupLinkFor(code.code) : '';

  const smallBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    height: '34px', padding: '0 12px', borderRadius: 'var(--radius-sm)',
    background: 'transparent', border: '1px solid var(--border)',
    color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)',
    fontSize: '13px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  };

  const body = (
    <div
      className={styles.panelBody}
      aria-busy={codeLoading || regenerating || inviteSubmitting}
    >
      {/* Header */}
      {variant === 'modal' ? (
        <div className={styles.modalHeader}>
          <h2>
            {lang === 'es' ? 'Invitar personal' : 'Invite staff'}
          </h2>
          {onClose && (
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label={lang === 'es' ? 'Cerrar' : 'Close'}
            >
              ×
            </button>
          )}
        </div>
      ) : (
        <div>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {lang === 'es' ? 'Invitar personal' : 'Invite staff'}
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Comparte el enlace o el código QR. Tu equipo se registra, elige su departamento y aparece para que lo apruebes.'
              : 'Share the link or QR code. Your team signs up, picks their department, and shows up for you to approve.'}
          </p>
        </div>
      )}

      {/* Loading / error / content */}
      {codeLoading ? (
        <div className={styles.primarySkeleton} role="status" aria-live="polite">
          <span className={styles.visuallyHidden}>
            {lang === 'es' ? 'Cargando enlace de invitación…' : 'Loading invite link…'}
          </span>
          <div className={styles.skeletonLink} aria-hidden="true">
            <span className={styles.skeletonLabel} />
            <div className={styles.skeletonFieldRow}>
              <span className={styles.skeletonField} />
              <span className={styles.skeletonButton} />
            </div>
          </div>
          <span className={styles.skeletonQr} aria-hidden="true" />
          <div className={styles.skeletonCode} aria-hidden="true">
            <span className={styles.skeletonCodeLine} />
            <span className={styles.skeletonHint} />
            <span className={styles.skeletonHint} />
          </div>
          <span className={styles.skeletonButton} aria-hidden="true" />
        </div>
      ) : codeError ? (
        <p style={{ fontSize: '13px', color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: 0 }}>
          {codeError}
        </p>
      ) : code ? (
        <>
          {/* (a) Invite link + Copy */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
              {lang === 'es' ? 'Enlace de invitación' : 'Invite link'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ flex: 1, minWidth: 0, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {link}
              </span>
              <button type="button" onClick={() => doCopy(link, 'link')} style={smallBtn} aria-label={lang === 'es' ? 'Copiar enlace' : 'Copy link'}>
                {copied === 'link'
                  ? <><Check size={14} strokeWidth={3} />{lang === 'es' ? '¡Copiado!' : 'Copied!'}</>
                  : <><Copy size={14} />{lang === 'es' ? 'Copiar' : 'Copy'}</>}
              </button>
            </div>
          </div>

          {/* (b) QR code */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt={lang === 'es' ? 'Código QR de invitación' : 'Invite QR code'}
                width={160} height={160}
                style={{ width: '160px', height: '160px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: '#FFFFFF', padding: '8px' }}
              />
            )}
          </div>

          {/* (c) The code itself, big monospace */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '26px', fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-primary)' }}>
                {code.code}
              </span>
              <button type="button" onClick={() => doCopy(code.code, 'code')} style={{ ...smallBtn, height: '30px', padding: '0 10px' }} aria-label={lang === 'es' ? 'Copiar código' : 'Copy code'}>
                {copied === 'code'
                  ? <Check size={13} strokeWidth={3} />
                  : <Copy size={13} />}
              </button>
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
              {lang === 'es' ? 'o pueden escribir este código al registrarse' : 'or they can type this code when they sign up'}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
              {lang === 'es'
                ? `Caduca el ${new Date(code.expires_at).toLocaleDateString()} · válido para ${code.max_uses} registros`
                : `Expires ${new Date(code.expires_at).toLocaleDateString()} · good for ${code.max_uses} sign-ups`}
            </span>
          </div>

          {/* New link */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button type="button" onClick={handleNewLink} disabled={regenerating} style={{ ...smallBtn, opacity: regenerating ? 0.6 : 1, cursor: regenerating ? 'not-allowed' : 'pointer' }}>
              <RefreshCw size={14} />
              {regenerating
                ? (lang === 'es' ? 'Creando…' : 'Creating…')
                : (lang === 'es' ? 'Nuevo enlace' : 'New link')}
            </button>
          </div>
        </>
      ) : null}

      {/* ─── Invite a manager by email ─────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Mail size={13} color="var(--text-muted)" />
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)' }}>
            {lang === 'es' ? 'Invitar a un gerente por correo' : 'Invite a manager by email'}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {lang === 'es'
            ? 'Solo para gerentes. El personal se une con el enlace de arriba.'
            : 'Managers only. Staff join with the link above.'}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="email"
            value={inviteEmail}
            onChange={e => { setInviteEmail(e.target.value); setInviteError(''); setInviteSuccess(false); }}
            placeholder="name@example.com"
            style={{ flex: 1, minWidth: '160px', height: '38px', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', border: '1px solid var(--border)', padding: '0 12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'var(--font-sans)', outline: 'none' }}
          />
          <button
            type="button"
            onClick={handleSendInvite}
            disabled={inviteSubmitting || !inviteEmail.trim()}
            style={{
              height: '38px', padding: '0 16px', borderRadius: 'var(--radius-md)',
              background: (inviteSubmitting || !inviteEmail.trim()) ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
              color: '#FFFFFF', border: 'none', fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
              cursor: (inviteSubmitting || !inviteEmail.trim()) ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap',
            }}
          >
            {inviteSubmitting
              ? (lang === 'es' ? 'Enviando…' : 'Sending…')
              : (lang === 'es' ? 'Enviar' : 'Send')}
          </button>
        </div>
        {inviteError && (
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--red)' }}>{inviteError}</p>
        )}
        {inviteSuccess && (
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--green, #22c55e)' }}>
            {lang === 'es' ? 'Invitación enviada.' : 'Invite sent.'}
          </p>
        )}

        {/* Pending manager invites — compact list with revoke */}
        {invites.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
            {invites.map(iv => (
              <div key={iv.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{iv.email}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
                    {lang === 'es' ? 'pendiente · caduca' : 'pending · expires'} {new Date(iv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <button type="button" onClick={() => handleRevokeInvite(iv.id)} aria-label={lang === 'es' ? 'Revocar' : 'Revoke'} style={{ width: '30px', height: '30px', borderRadius: 'var(--radius-sm)', background: 'transparent', border: '1px solid var(--red-border, rgba(239,68,68,0.3))', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--red)' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === 'card') {
    return (
      <div style={{ background: 'var(--bg-elevated, var(--bg-card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '18px' }}>
        {body}
      </div>
    );
  }
  return body;
}
