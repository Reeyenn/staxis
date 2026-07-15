'use client';

export const dynamic = 'force-dynamic';

import React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Clock3,
  KeyRound,
  Mail,
  Moon,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sun,
} from 'lucide-react';
import { CxLogo } from '@/components/concourse/icons';
import { InstallStaxisCard } from '@/components/pwa/InstallStaxisCard';
import { supabase } from '@/lib/supabase';
import { readEnvelope } from '@/lib/api-envelope';
import type {
  ClaimPhonePairingResponse,
  CompletePhonePairingResponse,
  ResendPhonePairingResponse,
  VerifyPhonePairingResponse,
} from '@/lib/phone-pairing-contract';
import styles from './page.module.css';

type Stage = 'opening' | 'code' | 'verifying' | 'finish-error' | 'success' | 'error';

interface PendingPhoneHandoff {
  challengeToken: string;
  code: string;
  verified?: VerifyPhonePairingResponse;
  accessToken?: string;
  sessionCreated: boolean;
  completionConfirmed: boolean;
}

class PairingRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PairingRequestError';
  }
}

const RESEND_COOLDOWN_SECONDS = 10;
const WINDOW_NAME_PREFIX = 'staxis-phone-pairing:';
const REQUEST_RETRY_DELAYS_MS = [0, 250, 700] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function postPairingWithRetry<T>(
  path: string,
  body: Record<string, string>,
  fallbackError: string,
  authorization?: string,
): Promise<T> {
  let lastError: PairingRequestError | null = null;

  for (let attempt = 0; attempt < REQUEST_RETRY_DELAYS_MS.length; attempt += 1) {
    if (REQUEST_RETRY_DELAYS_MS[attempt] > 0) {
      await wait(REQUEST_RETRY_DELAYS_MS[attempt]);
    }
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const result = await readEnvelope<T>(response, fallbackError);
      if (!result.error && result.data) return result.data;

      const status = result.status ?? response.status;
      const retryable = status >= 500;
      lastError = new PairingRequestError(
        result.error ?? fallbackError,
        retryable,
        status,
      );
      if (!retryable) throw lastError;
    } catch (error) {
      if (error instanceof PairingRequestError && !error.retryable) throw error;
      lastError = error instanceof PairingRequestError
        ? error
        : new PairingRequestError(fallbackError, true);
    }
  }

  throw lastError ?? new PairingRequestError(fallbackError, true);
}

function pairingTokenFromFragment(fragment: string): string | null {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const token = params.get('pair');
  return token && /^[0-9a-f]{64}$/i.test(token) ? token : null;
}

function takePairingToken(): string | null {
  const fragmentToken = pairingTokenFromFragment(window.location.hash);
  const windowNameToken = window.name.startsWith(WINDOW_NAME_PREFIX)
    ? window.name.slice(WINDOW_NAME_PREFIX.length)
    : null;
  if (window.name.startsWith(WINDOW_NAME_PREFIX)) window.name = '';
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (fragmentToken) return fragmentToken;
  return windowNameToken && /^[0-9a-f]{64}$/i.test(windowNameToken)
    ? windowNameToken
    : null;
}

function accessTokenHasMfaVerified(accessToken: string): boolean {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return false;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const claims = JSON.parse(window.atob(payload)) as { mfa_verified?: unknown };
    return claims.mfa_verified === true;
  } catch {
    return false;
  }
}

export default function PhoneSignInPage() {
  const startedRef = React.useRef(false);
  const codeRef = React.useRef<HTMLInputElement>(null);
  const successHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const baselineAccessTokenRef = React.useRef<string | null>(null);
  const pendingHandoffRef = React.useRef<PendingPhoneHandoff | null>(null);
  const [stage, setStage] = React.useState<Stage>('opening');
  const [challengeToken, setChallengeToken] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [code, setCode] = React.useState('');
  const [codeError, setCodeError] = React.useState('');
  const [error, setError] = React.useState('');
  const [resending, setResending] = React.useState(false);
  const [resendCooldown, setResendCooldown] = React.useState(RESEND_COOLDOWN_SECONDS);
  const [now, setNow] = React.useState(() => Date.now());
  const [dark, setDark] = React.useState(false);

  React.useEffect(() => {
    const saved = window.localStorage.getItem('staxis-phone-theme');
    const preferDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDark(saved ? saved === 'dark' : preferDark);
  }, []);

  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const token = takePairingToken();
    // Clear the secret before any navigation, analytics, screenshot sharing,
    // or Referer-producing request can capture it. It remains only in this
    // effect's closure long enough to exchange for a separate challenge.
    void (async () => {
      try {
        const { data: existingAuth } = await supabase.auth.getSession();
        baselineAccessTokenRef.current = existingAuth.session?.access_token ?? null;

        if (!token) {
          // A reload after completion can land here with a clean URL. If the
          // OTP session and trust cookie already exist, recover the
          // success/install screen instead of incorrectly demanding a QR.
          if (existingAuth.session) {
            if (accessTokenHasMfaVerified(existingAuth.session.access_token)) {
              setStage('success');
              return;
            }
            const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
            if (
              !refreshError &&
              refreshed.session &&
              accessTokenHasMfaVerified(refreshed.session.access_token)
            ) {
              setStage('success');
              return;
            }
          }
          throw new PairingRequestError(
            'This phone link is missing or no longer valid. Create a new QR code from Staxis on the desktop.',
            false,
          );
        }

        const claimed = await postPairingWithRetry<ClaimPhonePairingResponse>(
          '/api/auth/phone-pairing/claim',
          { token },
          'This QR code is invalid, expired, or already used.',
        );
        setChallengeToken(claimed.challengeToken);
        setExpiresAt(claimed.expiresAt);
        setNow(Date.now());
        setResendCooldown(RESEND_COOLDOWN_SECONDS);

        // Global human-2FA switch off: the server issued the code itself (no
        // email) and returned it, so run the existing verify → session →
        // complete → refresh sequence directly instead of showing the code
        // screen. Fail-safe: absent/malformed bypassCode falls through to
        // the normal code screen (2FA-on behavior); if the auto-verify hits
        // a bad-code error, finishPendingHandoff already lands back on the
        // code screen where "Send a new code" emails a real code.
        if (typeof claimed.bypassCode === 'string' && /^\d{6}$/.test(claimed.bypassCode)) {
          pendingHandoffRef.current = {
            challengeToken: claimed.challengeToken,
            code: claimed.bypassCode,
            sessionCreated: false,
            completionConfirmed: false,
          };
          await finishPendingHandoff();
          return;
        }

        setStage('code');
        window.requestAnimationFrame(() => codeRef.current?.focus());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open this phone sign-in.');
        setStage('error');
      }
    })();
  }, []);

  React.useEffect(() => {
    if (stage !== 'code') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setResendCooldown((value) => Math.max(0, value - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [stage, expiresAt]);

  React.useEffect(() => {
    if (stage !== 'success') return;
    const frame = window.requestAnimationFrame(() => successHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [stage]);

  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : 0;
  const secondsLeft = expiresAtMs ? Math.max(0, Math.ceil((expiresAtMs - now) / 1_000)) : 0;
  const codeExpired = stage === 'code' && expiresAtMs > 0 && secondsLeft === 0;

  const resend = async () => {
    if (!challengeToken || resending || resendCooldown > 0) return;
    setResending(true);
    setError('');
    try {
      const response = await fetch('/api/auth/phone-pairing/resend', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeToken }),
      });
      const result = await readEnvelope<ResendPhonePairingResponse>(
        response,
        'Could not send another code. Create a new QR code on the desktop.',
      );
      if (result.error || !result.data) {
        throw new Error(result.error ?? 'Could not send another code. Create a new QR code on the desktop.');
      }
      setExpiresAt(result.data.expiresAt);
      setNow(Date.now());
      setCode('');
      setCodeError('');
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      window.requestAnimationFrame(() => codeRef.current?.focus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code.');
    } finally {
      setResending(false);
    }
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challengeToken || code.length !== 6 || codeExpired) return;
    pendingHandoffRef.current = {
      challengeToken,
      code,
      sessionCreated: false,
      completionConfirmed: false,
    };
    await finishPendingHandoff();
  };

  async function finishPendingHandoff() {
    const pending = pendingHandoffRef.current;
    if (!pending) return;
    setStage('verifying');
    setError('');
    setCodeError('');

    let phase: 'verify' | 'auth' | 'complete' | 'refresh' = pending.verified
      ? pending.accessToken
        ? pending.completionConfirmed
          ? 'refresh'
          : 'complete'
        : 'auth'
      : 'verify';

    try {
      if (!pending.verified) {
        phase = 'verify';
        pending.verified = await postPairingWithRetry<VerifyPhonePairingResponse>(
          '/api/auth/phone-pairing/verify',
          { challengeToken: pending.challengeToken, code: pending.code },
          'The code is incorrect, expired, or already used.',
        );
      }

      // Auth-plane only: all pairing data reads/writes stay behind service-
      // role API routes. This consumes a one-time Supabase token only after
      // our independently emailed code has been verified.
      if (!pending.accessToken) {
        phase = 'auth';
        const { data: currentAuth } = await supabase.auth.getSession();
        const recoveredSession = currentAuth.session &&
          currentAuth.session.access_token !== baselineAccessTokenRef.current
          ? currentAuth.session
          : null;

        if (recoveredSession) {
          pending.accessToken = recoveredSession.access_token;
          pending.sessionCreated = true;
        } else {
          const { data: authData, error: authError } = await supabase.auth.verifyOtp({
            token_hash: pending.verified.hashedToken,
            type: 'magiclink',
          });
          if (authError || !authData.session) {
            const retryable = !authError?.status || authError.status >= 500;
            throw new PairingRequestError(
              'Could not establish the phone session. Check your connection and try again.',
              retryable,
              authError?.status,
            );
          }
          pending.accessToken = authData.session.access_token;
          pending.sessionCreated = true;
        }
      }

      if (!pending.completionConfirmed) {
        phase = 'complete';
        const completed = await postPairingWithRetry<CompletePhonePairingResponse>(
          '/api/auth/phone-pairing/complete',
          { completionToken: pending.verified.completionToken },
          'Could not confirm the secure phone session. Check your connection and try again.',
          pending.accessToken,
        );
        if (!completed.success) {
          throw new PairingRequestError('Could not finish securing this phone.', false);
        }
        pending.completionConfirmed = true;
      }

      // The completion transaction wrote mfa_verified_sessions. Refresh once
      // so the custom access-token hook adds mfa_verified=true before any app
      // page or RLS read is allowed to run.
      phase = 'refresh';
      let refreshed = false;
      for (let attempt = 0; attempt < REQUEST_RETRY_DELAYS_MS.length; attempt += 1) {
        if (REQUEST_RETRY_DELAYS_MS[attempt] > 0) {
          await wait(REQUEST_RETRY_DELAYS_MS[attempt]);
        }
        const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
        if (
          !refreshError &&
          refreshData.session &&
          accessTokenHasMfaVerified(refreshData.session.access_token)
        ) {
          refreshed = true;
          break;
        }
      }
      if (!refreshed) {
        throw new PairingRequestError(
          'This phone is secured, but the session still needs to refresh. Check your connection and try again.',
          true,
        );
      }

      pendingHandoffRef.current = null;
      // verifyOtp announces SIGNED_IN before completion adds the MFA claim.
      // A one-time hard rehydrate prevents global providers from retaining an
      // RLS-filtered empty hotel list fetched during that narrow window. The
      // clean-URL branch above recognizes the refreshed MFA session and shows
      // the success/install screen without another handoff request.
      window.location.replace('/phone-signin');
    } catch (err) {
      const requestError = err instanceof PairingRequestError
        ? err
        : new PairingRequestError('Could not finish the phone sign-in. Check your connection and try again.', true);

      if (phase === 'verify' && !requestError.retryable) {
        pendingHandoffRef.current = null;
        setCode('');
        setCodeError(requestError.message);
        setStage('code');
        window.requestAnimationFrame(() => codeRef.current?.focus());
        return;
      }

      if ((phase === 'auth' || phase === 'complete') && !requestError.retryable) {
        if (pending.sessionCreated && !pending.completionConfirmed) {
          await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
        }
        pendingHandoffRef.current = null;
        setError(requestError.message);
        setStage('error');
        return;
      }

      // Transport/5xx uncertainty may mean completion already committed.
      // Preserve every capability in memory and never sign out here; the
      // retry-safe server accepts the same exact session/grant idempotently.
      pendingHandoffRef.current = pending;
      setError(requestError.message);
      setStage('finish-error');
    }
  }

  const toggleTheme = () => {
    setDark((value) => {
      const next = !value;
      window.localStorage.setItem('staxis-phone-theme', next ? 'dark' : 'light');
      return next;
    });
  };

  return (
    <main className={`${styles.shell} ${dark ? styles.dark : ''}`}>
      <div className={styles.ambient} aria-hidden="true" />
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand} aria-label="Staxis home">
          <span className={styles.brandMark}><CxLogo size={22} color="currentColor" /></span>
          <span>Staxis</span>
        </Link>
        <button type="button" className={styles.themeButton} onClick={toggleTheme} aria-label={dark ? 'Use light appearance' : 'Use dark appearance'}>
          {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
        </button>
      </header>

      <section className={styles.content}>
        {stage === 'opening' && (
          <div className={styles.card} role="status">
            <div className={styles.heroIcon}><Smartphone size={30} aria-hidden="true" /></div>
            <p className={styles.eyebrow}>Secure phone sign-in</p>
            <h1>Opening Staxis…</h1>
            <p className={styles.lead}>Checking your one-time QR code and sending an email.</p>
            <div className={styles.loadingBar} aria-hidden="true"><span /></div>
          </div>
        )}

        {stage === 'code' && (
          <div className={styles.card}>
            <div className={styles.heroIcon}><Mail size={30} aria-hidden="true" /></div>
            <p className={styles.eyebrow}>Check your email</p>
            <h1>Enter your 6-digit code</h1>
            <p className={styles.lead}>We sent a short-lived code to the registered email on this Staxis account.</p>

            <form className={styles.form} onSubmit={verify}>
              <label htmlFor="phone-code">Email code</label>
              <div className={`${styles.codeField}${codeError ? ` ${styles.codeFieldError}` : ''}`}>
                <KeyRound size={20} aria-hidden="true" />
                <input
                  ref={codeRef}
                  id="phone-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  disabled={codeExpired}
                  aria-invalid={Boolean(codeError)}
                  aria-describedby={codeError ? 'phone-code-help phone-code-error' : 'phone-code-help'}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                    setCodeError('');
                  }}
                  placeholder="000000"
                />
              </div>
              <div id="phone-code-help" className={styles.codeMeta}>
                <span className={codeExpired ? styles.expired : ''}>
                  <Clock3 size={14} aria-hidden="true" />
                  {codeExpired ? 'Code expired' : `Expires in 0:${String(secondsLeft).padStart(2, '0')}`}
                </span>
                <button
                  type="button"
                  onClick={() => void resend()}
                  disabled={resending || resendCooldown > 0}
                >
                  {resending
                    ? 'Sending…'
                    : resendCooldown > 0
                      ? `Resend in ${resendCooldown}s`
                      : 'Send a new code'}
                </button>
              </div>

              {error && <div className={styles.error} role="alert">{error}</div>}
              {codeError && <div id="phone-code-error" className={styles.error} role="alert">{codeError}</div>}

              <button className={styles.primaryButton} type="submit" disabled={code.length !== 6 || codeExpired}>
                Verify and sign in <ArrowRight size={18} aria-hidden="true" />
              </button>
            </form>

            <div className={styles.securityNote}>
              <ShieldCheck size={18} aria-hidden="true" />
              <span><strong>Protected handoff.</strong> The QR code alone cannot sign this phone in.</span>
            </div>
          </div>
        )}

        {stage === 'verifying' && (
          <div className={styles.card} role="status">
            <div className={styles.heroIcon}><ShieldCheck size={30} aria-hidden="true" /></div>
            <p className={styles.eyebrow}>Code accepted</p>
            <h1>Securing this phone…</h1>
            <p className={styles.lead}>Creating your Staxis session and remembering this device.</p>
            <div className={styles.loadingBar} aria-hidden="true"><span /></div>
          </div>
        )}

        {stage === 'finish-error' && (
          <div className={styles.card} role="alert">
            <div className={`${styles.heroIcon} ${styles.errorIcon}`}><RefreshCw size={29} aria-hidden="true" /></div>
            <p className={styles.eyebrow}>Connection interrupted</p>
            <h1>Finish securing this phone</h1>
            <p className={styles.lead}>{error}</p>
            <button className={styles.primaryButton} type="button" onClick={() => void finishPendingHandoff()}>
              Try the secure step again <RefreshCw size={18} aria-hidden="true" />
            </button>
            <Link className={styles.secondaryButton} href="/signin">Use regular sign-in instead</Link>
          </div>
        )}

        {stage === 'success' && (
          <div className={`${styles.card} ${styles.successCard}`}>
            <div className={`${styles.heroIcon} ${styles.successIcon}`}><Check size={32} strokeWidth={2.5} aria-hidden="true" /></div>
            <p className={styles.eyebrow}>Phone connected</p>
            <h1 ref={successHeadingRef} tabIndex={-1}>You’re in</h1>
            <p className={styles.lead} role="status">Staxis is signed in and this phone is remembered.</p>

            <InstallStaxisCard appearance={dark ? 'dark' : 'light'} />

            <button className={styles.primaryButton} type="button" onClick={() => window.location.replace('/home')}>
              Continue to Staxis <ArrowRight size={18} aria-hidden="true" />
            </button>
          </div>
        )}

        {stage === 'error' && (
          <div className={styles.card} role="alert">
            <div className={`${styles.heroIcon} ${styles.errorIcon}`}><RefreshCw size={29} aria-hidden="true" /></div>
            <p className={styles.eyebrow}>Phone sign-in stopped</p>
            <h1>Open a new QR code</h1>
            <p className={styles.lead}>{error}</p>
            <Link className={styles.secondaryButton} href="/signin">Use regular sign-in instead</Link>
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        <ShieldCheck size={14} aria-hidden="true" /> One-time tokens · Registered email only · Device remembered
      </footer>
    </main>
  );
}
