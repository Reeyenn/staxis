'use client';

// Settings → Account & Team — the join-codes concern (active-codes list +
// generate-code modal + revoke), extracted verbatim from accounts/page.tsx
// in the by-concern file split.
//
// Codes are role-less: the staff member picks their role at /signup.
// Code generation just needs a hotelId; the API fixes validity at 7 days
// and max-uses at 100.
//
// Same hook shape as useInvites (state + rendered elements) — see the
// header comment there for why.

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { AssignableRole } from '@/lib/roles';
import type { AppUser } from '@/contexts/AuthContext';

import {
  CopyButton, ErrorBox, ModalShell,
  subHeadingStyle, revokeBtnStyle, primaryBtnStyle,
} from './shared';

interface CodeRow { id: string; code: string; role: AssignableRole | null; expires_at: string; max_uses: number; used_count: number }

// Build a full-URL signup link for a code.
//
// We always use the canonical production host (getstaxis.com) when the app
// is running outside of localhost — even if the user is currently viewing
// the app on the legacy hotelops-ai.vercel.app alias. Reeyen flagged this:
// the link shouldn't leak our pre-domain Vercel URL to staff.
//
// In development we still echo window.location.origin so localhost-based
// QA flows produce clickable local URLs.
const CANONICAL_SITE_URL = 'https://getstaxis.com';
function signupLinkFor(code: string): string {
  if (typeof window === 'undefined') return `/signup?code=${code}`;
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `${window.location.origin}/signup?code=${code}`;
  }
  return `${CANONICAL_SITE_URL}/signup?code=${code}`;
}

export function useJoinCodes(user: AppUser | null, hotelId: string): {
  /** The "Generate code" button's onClick (resets result/error, opens). */
  openModal: () => void;
  /** Active-codes list (null when there are none). */
  list: React.ReactNode;
  /** The generate-code modal (null when closed). */
  modal: React.ReactNode;
} {
  const { lang } = useLang();

  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeSubmitting, setCodeSubmitting] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [codeResult, setCodeResult] = useState<CodeRow | null>(null);

  const loadCodes = useCallback(async () => {
    if (!user || !hotelId) return;
    try {
      const res = await fetchWithAuth(`/api/auth/join-codes?hotelId=${hotelId}`);
      if (!res.ok) { setLoadError(true); return; } // don't render "no codes" for a failed load
      const body = await res.json() as { data?: { codes?: CodeRow[] } };
      setCodes(body.data?.codes ?? []);
      setLoadError(false);
    } catch (err) {
      console.error('[accounts:join-codes] load failed', err);
      setLoadError(true);
    }
  }, [user, hotelId]);

  useEffect(() => { void loadCodes(); }, [loadCodes]);

  const handleGenerateCode = async () => {
    if (!user || !hotelId) return;
    setCodeError('');
    setCodeSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/auth/join-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { joinCode?: CodeRow } };
      if (!res.ok || !body.ok) {
        setCodeError(body.error ?? 'Failed to generate code');
        return;
      }
      setCodeResult(body.data?.joinCode ?? null);
      void loadCodes();
    } catch (err) {
      console.error('[accounts:join-codes] generate failed', err);
      setCodeError(lang === 'es' ? 'No se pudo generar el código — revisa tu conexión' : 'Failed to generate the code — check your connection');
    } finally {
      setCodeSubmitting(false);
    }
  };

  const handleRevokeCode = async (id: string) => {
    if (!confirm(lang === 'es' ? '¿Revocar este código?' : 'Revoke this code?')) return;
    // A failed revoke must not look like success — the leaked code would stay
    // usable. Same alert idiom as TeamMembers.handleRemoveMember.
    try {
      const res = await fetchWithAuth(`/api/auth/join-codes?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        alert(body.error ?? (lang === 'es' ? 'No se pudo revocar el código. Sigue activo — intenta de nuevo.' : 'Failed to revoke the code. It is still active — try again.'));
        return;
      }
      void loadCodes();
    } catch (err) {
      console.error('[accounts:join-codes] revoke failed', err);
      alert(lang === 'es' ? 'No se pudo revocar el código — revisa tu conexión. Sigue activo.' : 'Failed to revoke the code — check your connection. It is still active.');
    }
  };

  // Active codes
  const list = loadError ? (
    <ErrorBox>
      {lang === 'es'
        ? 'No se pudieron cargar los códigos activos. Recarga la página para intentar de nuevo.'
        : 'Couldn’t load active codes. Refresh the page to try again.'}
    </ErrorBox>
  ) : codes.length > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <h3 style={subHeadingStyle}>{lang === 'es' ? 'Códigos activos' : 'Active codes'}</h3>
      {codes.map(c => (
        <div key={c.id} style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '10px 12px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', color: 'var(--text-primary)' }}>
              {c.code}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {lang === 'es' ? 'expira' : 'expires'} {new Date(c.expires_at).toLocaleDateString()}
            </div>
          </div>
          <CopyButton value={c.code} label={lang === 'es' ? 'Copiar código' : 'Copy code'} small />
          <button onClick={() => handleRevokeCode(c.id)} style={revokeBtnStyle} aria-label="Revoke">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  ) : null;

  // ─── Generate-join-code modal ──────────────────────────────────────────
  // Codes are role-less; the staff member picks their role at signup.
  // Validity is fixed at 7 days. No knobs to turn — just generate.
  const modal = showCodeModal ? (
    <ModalShell onClose={() => setShowCodeModal(false)} title={lang === 'es' ? 'Generar código' : 'Generate code'}>
      {codeResult ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Código creado. Compártelo con tu equipo:'
              : 'Code created. Share it with your team:'}
          </p>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '14px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{
              fontSize: '20px', fontWeight: 700, fontFamily: 'var(--font-mono)',
              letterSpacing: '0.1em', color: 'var(--text-primary)',
            }}>{codeResult.code}</span>
            <CopyButton value={codeResult.code} label={lang === 'es' ? 'Copiar código' : 'Copy code'} />
          </div>

          {/* Shareable link with code prefilled — Reeyen flagged that
              bare "/signup" was confusing because users can't type a
              path into Google. This is the full URL they can text to
              staff. Uses window.location.origin so localhost works
              in dev and getstaxis.com works in production. */}
          <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
            {lang === 'es' ? 'O comparte este enlace' : 'Or share this link'}
          </p>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '10px 12px',
            display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0,
          }}>
            <span style={{
              flex: 1, minWidth: 0, fontSize: '12px',
              fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {signupLinkFor(codeResult.code)}
            </span>
            <CopyButton value={signupLinkFor(codeResult.code)} label={lang === 'es' ? 'Copiar enlace' : 'Copy link'} />
          </div>

          <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Válido por una semana. Tu equipo elige su rol al crear la cuenta.'
              : 'Valid for one week. Your team picks their role when creating the account.'}
          </p>
          <button onClick={() => setShowCodeModal(false)} style={primaryBtnStyle(false)}>
            {lang === 'es' ? 'Cerrar' : 'Close'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Esto crea un código de una semana que tu equipo puede usar para registrarse en este hotel. Cada persona elige su propio rol cuando crea la cuenta.'
              : 'This creates a one-week code your team can use to sign up for this hotel. Each person picks their own role when they create their account.'}
          </p>
          {codeError && <ErrorBox>{codeError}</ErrorBox>}
          <button disabled={codeSubmitting} onClick={handleGenerateCode} style={primaryBtnStyle(codeSubmitting)}>
            {codeSubmitting
              ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
              : (lang === 'es' ? 'Generar' : 'Generate')}
          </button>
        </div>
      )}
    </ModalShell>
  ) : null;

  return {
    openModal: () => { setCodeResult(null); setCodeError(''); setShowCodeModal(true); },
    list,
    modal,
  };
}
