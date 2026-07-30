'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import React from 'react';
import { CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';

import AuthShell, { AuthError, AuthLabel, AuthPanel, authLinkStyle } from '@/components/AuthShell';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { notifyAuthorizationChanged } from '@/lib/hooks/use-authorization-refresh-key';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
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
  const { replace } = useReliableNavigation();
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
      setPreviewError('This invitation link is invalid or is no longer available.');
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
          throw new Error(responseError(body, 'Could not securely review this invitation.'));
        }
        setPreview(body.data);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPreviewError(caught instanceof Error
          ? caught.message
          : 'Could not securely review this invitation.');
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
        throw new Error(responseError(body, 'Could not accept invitation.'));
      }
      clearCompanyInvitationHandoff();
      notifyAuthorizationChanged();
      replace('/company');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not accept invitation.');
      setSubmitting(false);
    }
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || !preview || !token) return;
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
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
        throw new Error(responseError(body, 'Could not create account.'));
      }
      clearCompanyInvitationHandoff();
      setRegistered(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create account.');
    } finally {
      setSubmitting(false);
    }
  };

  const visiblePreviewError = previewError;
  const visibleError = error;

  return (
    <AuthShell subtitle={'Review your secure company access invitation'}>
      {loading || !tokenReady || previewLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 28 }}>
          <span className="spinner" aria-label={'Loading'} />
        </div>
      ) : registered ? (
        <AuthPanel>
          <CheckCircle2 size={34} color="#4F7A61" style={{ margin: '0 auto 12px' }} aria-hidden="true" />
          <h2 style={{ margin: '0 0 8px', color: '#1F231C', fontSize: 19 }}>{'Account and access ready'}</h2>
          <p style={{ margin: '0 0 18px', color: '#5C625C', fontSize: 13.5, lineHeight: 1.55 }}>
            {'Sign in to open Company & Access. No hotel access was inferred beyond this invitation.'}
          </p>
          <Link href="/signin?redirect=%2Fcompany" className="si-btn si-btn-on" style={{ textDecoration: 'none' }}>
            {'Sign in to Company & Access'}
          </Link>
        </AuthPanel>
      ) : visiblePreviewError || !preview ? (
        <AuthPanel>
          <AuthError style={{ textAlign: 'left' }}>{visiblePreviewError || 'This invitation cannot be reviewed.'}</AuthError>
          {token ? (
            <button
              type="button"
              className="si-btn si-btn-on"
              style={{ marginTop: 14 }}
              onClick={() => setPreviewNonce((current) => current + 1)}
            >
              {'Try secure review again'}
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
                  <strong style={{ display: 'block', color: '#1F231C', fontSize: 14 }}>{'Signed in and ready to verify'}</strong>
                  <span style={{ display: 'block', color: '#5C625C', fontSize: 12.5, lineHeight: 1.5, marginTop: 3 }}>{'Staxis will confirm this invitation matches your account email before granting anything.'}</span>
                </div>
              </div>
              {visibleError ? <AuthError id="company-invite-error">{visibleError}</AuthError> : null}
              <button type="button" aria-describedby={visibleError ? 'company-invite-error' : undefined} className={`si-btn ${submitting ? 'si-btn-off' : 'si-btn-on'}`} disabled={submitting} onClick={acceptExisting}>
                {submitting ? 'Verifying…' : 'Accept invitation'}
              </button>
              <Link href="/company" style={{ ...authLinkStyle, textAlign: 'center' }}>{'Return to Company & Access'}</Link>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: 'rgba(201,150,68,.10)', border: '1px solid rgba(201,150,68,.22)', color: '#4D4434', fontSize: 13, lineHeight: 1.45 }}>
                <KeyRound size={18} aria-hidden="true" />
                {'Already use Staxis?'}
                <Link href={COMPANY_INVITATION_SIGN_IN_HREF} style={{ ...authLinkStyle, fontWeight: 700, marginLeft: 'auto' }}>{'Sign in'}</Link>
              </div>
              <div style={{ height: 1, background: 'rgba(31,35,28,.10)' }} />
              <form
                onSubmit={register}
                aria-describedby={visibleError ? 'company-invite-error' : undefined}
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <AuthLabel htmlFor="company-invite-display-name">{'Full name'}</AuthLabel>
                  <input id="company-invite-display-name" className="si-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required minLength={2} maxLength={100} disabled={submitting} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <AuthLabel htmlFor="company-invite-password">{'Create password'}</AuthLabel>
                  <input id="company-invite-password" className="si-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={128} disabled={submitting} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <AuthLabel htmlFor="company-invite-confirm-password">{'Confirm password'}</AuthLabel>
                  <input id="company-invite-confirm-password" className="si-input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={128} disabled={submitting} />
                </div>
                {visibleError ? <AuthError id="company-invite-error">{visibleError}</AuthError> : null}
                <button
                  type="submit"
                  className={`si-btn ${submitting || displayName.trim().length < 2 || password.length < 8 || !confirmPassword ? 'si-btn-off' : 'si-btn-on'}`}
                  disabled={submitting || displayName.trim().length < 2 || password.length < 8 || !confirmPassword}
                >
                  {submitting ? 'Creating secure access…' : 'Create account and accept'}
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </AuthShell>
  );
}
