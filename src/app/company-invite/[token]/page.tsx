'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import React from 'react';
import { CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';

import AuthShell, { AuthError, AuthLabel, AuthPanel, authLinkStyle } from '@/components/AuthShell';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { localizeKnownMessage, type LocalizedMessagePair } from '@/lib/localized-ui-message';
import {
  clearCompanyInvitationHandoff,
  companyInvitationTokenFromPath,
  COMPANY_INVITATION_RESUME_PATH,
  COMPANY_INVITATION_SIGN_IN_HREF,
  readCompanyInvitationHandoff,
  storeCompanyInvitationHandoff,
} from '@/lib/company-access/invitation-handoff';
import {
  InvitationReviewCard,
  type CompanyInvitationPreview,
} from '../_components/InvitationReviewCard';

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: unknown;
}

function copy(lang: string, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

const PREVIEW_ERROR_MESSAGES = [
  ['This invitation link is invalid or is no longer available.', 'Este enlace de invitación no es válido o ya no está disponible.'],
  ['Could not securely review this invitation.', 'No se pudo revisar esta invitación de forma segura.'],
] as const satisfies readonly LocalizedMessagePair[];

const INVITATION_ACTION_ERROR_MESSAGES = [
  ['Could not accept invitation.', 'No se pudo aceptar la invitación.'],
  ['Passwords do not match.', 'Las contraseñas no coinciden.'],
  ['Could not create account.', 'No se pudo crear la cuenta.'],
] as const satisfies readonly LocalizedMessagePair[];

function responseError(body: Envelope<unknown>, fallback: string): string {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') {
    const value = body.error as Record<string, unknown>;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
  }
  return fallback;
}

export default function CompanyInvitationPage() {
  const params = useParams<{ token: string }>();
  const routeToken = params?.token ?? '';
  const { user, loading } = useAuth();
  const { lang } = useLang();
  const router = useRouter();
  const [token, setToken] = React.useState('');
  const [tokenReady, setTokenReady] = React.useState(false);
  const [preview, setPreview] = React.useState<CompanyInvitationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(true);
  const [previewError, setPreviewError] = React.useState('');
  const [previewNonce, setPreviewNonce] = React.useState(0);
  const [displayName, setDisplayName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [registered, setRegistered] = React.useState(false);

  // Keep the raw single-use capability in this tab's session storage. The
  // copied link necessarily arrives once in the browser URL, but it is
  // immediately replaced with a non-secret resume path and is never copied
  // into the sign-in or OTP query strings.
  React.useEffect(() => {
    setTokenReady(false);
    const tokenFromRoute = companyInvitationTokenFromPath(`/company-invite/${routeToken}`);
    if (tokenFromRoute && storeCompanyInvitationHandoff(tokenFromRoute)) {
      setToken(tokenFromRoute);
      if (window.location.pathname !== COMPANY_INVITATION_RESUME_PATH) {
        window.history.replaceState(window.history.state, '', COMPANY_INVITATION_RESUME_PATH);
      }
    } else if (routeToken === 'resume') {
      const storedPath = readCompanyInvitationHandoff();
      setToken(storedPath ? companyInvitationTokenFromPath(storedPath) ?? '' : '');
    } else {
      setToken('');
    }
    setTokenReady(true);
  }, [routeToken]);

  // Read language via a ref so this preview-loading effect does NOT depend on
  // `lang` — otherwise toggling EN/ES aborts + refetches the invitation preview
  // and flashes the spinner, even though the preview isn't language-dependent
  // (only the error copy is). See the deps array below.
  const langRef = React.useRef(lang);
  langRef.current = lang;

  React.useEffect(() => {
    if (!tokenReady) return;
    if (!token) {
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(copy(langRef.current, 'This invitation link is invalid or is no longer available.', 'Este enlace de invitación no es válido o ya no está disponible.'));
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError('');
    void (async () => {
      try {
        const response = await fetch('/api/company-access/invitations/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({})) as Envelope<CompanyInvitationPreview>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(responseError(body, copy(langRef.current, 'Could not securely review this invitation.', 'No se pudo revisar esta invitación de forma segura.')));
        }
        setPreview(body.data);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPreviewError(caught instanceof Error
          ? caught.message
          : copy(langRef.current, 'Could not securely review this invitation.', 'No se pudo revisar esta invitación de forma segura.'));
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    })();
    return () => controller.abort();
  }, [previewNonce, token, tokenReady]);

  const acceptExisting = async () => {
    if (submitting || !preview || !token) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/company-access/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ membershipId: string; grantId: string }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, copy(lang, 'Could not accept invitation.', 'No se pudo aceptar la invitación.')));
      }
      clearCompanyInvitationHandoff();
      router.replace('/company');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'Could not accept invitation.', 'No se pudo aceptar la invitación.'));
      setSubmitting(false);
    }
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || !preview || !token) return;
    if (password !== confirmPassword) {
      setError(copy(lang, 'Passwords do not match.', 'Las contraseñas no coinciden.'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/company-access/invitations/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName: displayName.trim(), password }),
      });
      const body = await response.json().catch(() => ({})) as Envelope<{ created: boolean; redirectTo: string }>;
      if (!response.ok || !body.ok) {
        throw new Error(responseError(body, copy(lang, 'Could not create account.', 'No se pudo crear la cuenta.')));
      }
      clearCompanyInvitationHandoff();
      setRegistered(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy(lang, 'Could not create account.', 'No se pudo crear la cuenta.'));
    } finally {
      setSubmitting(false);
    }
  };

  const visiblePreviewError = localizeKnownMessage(previewError, lang, PREVIEW_ERROR_MESSAGES);
  const visibleError = localizeKnownMessage(error, lang, INVITATION_ACTION_ERROR_MESSAGES);

  return (
    <AuthShell subtitle={copy(lang, 'Review your secure company access invitation', 'Revisa tu invitación segura de acceso a la empresa')}>
      {loading || !tokenReady || previewLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 28 }}>
          <span className="spinner" aria-label={copy(lang, 'Loading', 'Cargando')} />
        </div>
      ) : registered ? (
        <AuthPanel>
          <CheckCircle2 size={34} color="#4F7A61" style={{ margin: '0 auto 12px' }} aria-hidden="true" />
          <h2 style={{ margin: '0 0 8px', color: '#1F231C', fontSize: 19 }}>{copy(lang, 'Account and access ready', 'Cuenta y acceso listos')}</h2>
          <p style={{ margin: '0 0 18px', color: '#5C625C', fontSize: 13.5, lineHeight: 1.55 }}>
            {copy(lang, 'Sign in to open Company & Access. No hotel access was inferred beyond this invitation.', 'Inicia sesión para abrir Empresa y acceso. No se dedujo acceso a hoteles fuera de esta invitación.')}
          </p>
          <Link href="/signin?redirect=%2Fcompany" className="si-btn si-btn-on" style={{ textDecoration: 'none' }}>
            {copy(lang, 'Sign in to Company & Access', 'Iniciar sesión en Empresa y acceso')}
          </Link>
        </AuthPanel>
      ) : visiblePreviewError || !preview ? (
        <AuthPanel>
          <AuthError style={{ textAlign: 'left' }}>{visiblePreviewError || copy(lang, 'This invitation cannot be reviewed.', 'Esta invitación no se puede revisar.')}</AuthError>
          {token ? (
            <button
              type="button"
              className="si-btn si-btn-on"
              style={{ marginTop: 14 }}
              onClick={() => setPreviewNonce((current) => current + 1)}
            >
              {copy(lang, 'Try secure review again', 'Volver a intentar la revisión segura')}
            </button>
          ) : null}
        </AuthPanel>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <InvitationReviewCard preview={preview} lang={lang} />
          {user ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ padding: '14px 15px', borderRadius: 12, background: 'rgba(79,122,97,.09)', border: '1px solid rgba(79,122,97,.20)', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <ShieldCheck size={19} color="#4F7A61" aria-hidden="true" />
                <div>
                  <strong style={{ display: 'block', color: '#1F231C', fontSize: 14 }}>{copy(lang, 'Signed in and ready to verify', 'Sesión iniciada y lista para verificar')}</strong>
                  <span style={{ display: 'block', color: '#5C625C', fontSize: 12.5, lineHeight: 1.5, marginTop: 3 }}>{copy(lang, 'Staxis will confirm this invitation matches your account email before granting anything.', 'Staxis confirmará que esta invitación coincida con el correo de tu cuenta antes de conceder acceso.')}</span>
                </div>
              </div>
              {visibleError ? <AuthError id="company-invite-error">{visibleError}</AuthError> : null}
              <button type="button" aria-describedby={visibleError ? 'company-invite-error' : undefined} className={`si-btn ${submitting ? 'si-btn-off' : 'si-btn-on'}`} disabled={submitting} onClick={acceptExisting}>
                {submitting ? copy(lang, 'Verifying…', 'Verificando…') : copy(lang, 'Accept invitation', 'Aceptar invitación')}
              </button>
              <Link href="/company" style={{ ...authLinkStyle, textAlign: 'center' }}>{copy(lang, 'Return to Company & Access', 'Volver a Empresa y acceso')}</Link>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: 'rgba(201,150,68,.10)', border: '1px solid rgba(201,150,68,.22)', color: '#4D4434', fontSize: 13, lineHeight: 1.45 }}>
                <KeyRound size={18} aria-hidden="true" />
                {copy(lang, 'Already use Staxis?', '¿Ya usas Staxis?')}
                <Link href={COMPANY_INVITATION_SIGN_IN_HREF} style={{ ...authLinkStyle, fontWeight: 700, marginLeft: 'auto' }}>{copy(lang, 'Sign in', 'Iniciar sesión')}</Link>
              </div>
              <div style={{ height: 1, background: 'rgba(31,35,28,.10)' }} />
              <form
                onSubmit={register}
                aria-describedby={visibleError ? 'company-invite-error' : undefined}
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <AuthLabel htmlFor="company-invite-display-name">{copy(lang, 'Full name', 'Nombre completo')}</AuthLabel>
                  <input id="company-invite-display-name" className="si-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required minLength={2} maxLength={100} disabled={submitting} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <AuthLabel htmlFor="company-invite-password">{copy(lang, 'Create password', 'Crear contraseña')}</AuthLabel>
                  <input id="company-invite-password" className="si-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={128} disabled={submitting} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <AuthLabel htmlFor="company-invite-confirm-password">{copy(lang, 'Confirm password', 'Confirmar contraseña')}</AuthLabel>
                  <input id="company-invite-confirm-password" className="si-input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={128} disabled={submitting} />
                </div>
                {visibleError ? <AuthError id="company-invite-error">{visibleError}</AuthError> : null}
                <button
                  type="submit"
                  className={`si-btn ${submitting || displayName.trim().length < 2 || password.length < 8 || !confirmPassword ? 'si-btn-off' : 'si-btn-on'}`}
                  disabled={submitting || displayName.trim().length < 2 || password.length < 8 || !confirmPassword}
                >
                  {submitting ? copy(lang, 'Creating secure access…', 'Creando acceso seguro…') : copy(lang, 'Create account and accept', 'Crear cuenta y aceptar')}
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </AuthShell>
  );
}
