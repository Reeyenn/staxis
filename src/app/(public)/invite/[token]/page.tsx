'use client';


export const dynamic = 'force-dynamic';
// /invite/[token] — Accept an email invite. The owner/admin generated this
// link from Settings → Account & Team → Invite by email. We only need the
// user to set a display name + password; the email + hotel + role were
// pre-decided when the invite was created.
//
// This page shows WHAT IS BEING ACCEPTED before it asks for anything. It used
// to ask a stranger for their full name and a password over a blank page: no
// who, no where, no what job. Somebody who cannot see what they are joining
// cannot tell this from a phishing page with the same layout.
//
// RLS BUG CLASS: the visitor is not signed in, so both the preview and the
// acceptance go through /api routes that use the service role. This page must
// never call `supabase.from(...)` — the anon role returns 200 with [] and the
// screen silently renders empty. See CLAUDE.md.

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';

interface InvitePreview {
  email: string;
  roleLabel: string;
  scope: 'company' | 'hotel';
  companyName: string | null;
  hotelNames: string[];
  coversAllIncludingFuture: boolean;
  invitedByName: string | null;
}

/** "Port Arthur Inn", "Port Arthur Inn and Lufkin Inn", "Port Arthur Inn and 2 more". */
function describeHotels(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/** The one line that says what this invitation actually is. */
export function describeInviteScope(preview: InvitePreview): string {
  if (preview.scope === 'company') {
    const company = preview.companyName ?? 'the company';
    if (preview.coversAllIncludingFuture) {
      return `${company}, across every hotel it runs`;
    }
    return preview.hotelNames.length > 0
      ? `${company}, for ${describeHotels(preview.hotelNames)}`
      : company;
  }
  return describeHotels(preview.hotelNames);
}

export default function AcceptInvitePage() {
  const { lang } = useLang();
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'unusable'>('loading');
  const [previewToken, setPreviewToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ email: string } | null>(null);

  useEffect(() => {
    setPreview(null);
    setPreviewToken('');
    setDisplayName('');
    setPassword('');
    setConfirm('');
    setSubmitting(false);
    setError('');
    setDone(null);
    if (!token) {
      setPreviewState('unusable');
      return;
    }
    const controller = new AbortController();
    setPreviewState('loading');
    void (async () => {
      try {
        const res = await fetch('/api/auth/invite-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => ({})) as { ok?: boolean; data?: InvitePreview };
        if (controller.signal.aborted) return;
        if (res.ok && body.ok && body.data) {
          setPreview(body.data);
          setPreviewToken(token);
          setPreviewState('ready');
        } else {
          setPreview(null);
          setPreviewState('unusable');
        }
      } catch {
        if (!controller.signal.aborted) {
          setPreview(null);
          setPreviewState('unusable');
        }
      }
    })();
    return () => { controller.abort(); };
  }, [token]);

  const previewReady = previewState === 'ready' && previewToken === token && preview !== null;
  const previewLoading = !done && Boolean(token) && !previewReady && previewState !== 'unusable';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!previewReady || !preview) {
      setError('Invitation details are still loading. Try again when they are ready.');
      return;
    }
    if (!displayName.trim()) {
      setError('Enter your full name.');
      return;
    }
    if (!password) {
      setError('Enter a password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName: displayName.trim(), password }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; data?: { email?: string } };
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Failed to accept invite');
        setSubmitting(false);
        return;
      }
      setDone({ email: body.data?.email ?? '' });
    } catch {
      setError('Something went wrong.');
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>

        <div style={{ marginBottom: '32px', textAlign: 'center' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '11px',
            background: 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
          </div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', marginBottom: '6px' }}>
            {'Accept your invitation'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.5 }}>
            {'Set your name and password to activate the account.'}
          </p>
        </div>

        {previewLoading && (
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', padding: '20px', marginBottom: '16px',
              textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px',
            }}
          >
            {'Loading invitation details…'}
          </div>
        )}

        {previewReady && preview && !done && (
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '16px 18px', marginBottom: '16px',
            display: 'flex', flexDirection: 'column', gap: '10px',
          }}>
            <PreviewRow
              label={'You are joining'}
              value={describeInviteScope(preview)}
            />
            <PreviewRow label={'As'} value={preview.roleLabel} />
            {preview.invitedByName && (
              <PreviewRow label={'Invited by'} value={preview.invitedByName} />
            )}
            <PreviewRow label={'Your sign in email'} value={preview.email} />
          </div>
        )}

        {previewState === 'unusable' && !done && (
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '20px', marginBottom: '16px',
            textAlign: 'center',
          }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', margin: 0, lineHeight: 1.5 }}>
              {'This invitation link is not usable. It may have expired or already been used.'}
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
              {'Ask whoever invited you to send a new one.'}
            </p>
          </div>
        )}

        {done ? (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '24px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '12px' }}>
              {'Account created.'}
            </p>
            <button onClick={() => router.replace('/signin')} style={{
              height: '44px', borderRadius: 'var(--radius-md)',
              background: 'var(--navy-light)', color: '#FFFFFF',
              border: 'none', padding: '0 20px',
              fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '14px',
              cursor: 'pointer',
            }}>
              {'Sign in'}
            </button>
          </div>
        ) : previewReady ? (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <Input id="invite-display-name" label={'Full name'} value={displayName} onChange={setDisplayName} disabled={submitting} />
            <Input id="invite-password" label={'Password'} type="password" value={password} onChange={setPassword} disabled={submitting} autoComplete="new-password" />
            <Input id="invite-confirm-password" label={'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} autoComplete="new-password" />

            {error && <ErrorMsg>{error}</ErrorMsg>}

            <button type="submit" disabled={submitting || !displayName.trim() || !password || !confirm} style={submitStyle(submitting || !displayName.trim() || !password || !confirm)}>
              {submitting
                ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                : ('Create account')}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-sans)' }}>
        {label}
      </span>
      <span style={{ fontSize: '14px', color: 'var(--text-primary)', fontFamily: 'var(--font-sans)', lineHeight: 1.4, wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  );
}

function Input({ id, label, type='text', value, onChange, disabled, autoComplete }: { id: string; label: string; type?: string; value: string; onChange: (v: string)=>void; disabled?: boolean; autoComplete?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label htmlFor={id} style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text-secondary)', textTransform: 'uppercase', fontFamily: 'var(--font-sans)' }}>{label}</label>
      <input id={id} type={type} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} autoComplete={autoComplete}
        style={{ height: '44px', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', border: '1px solid var(--border)', padding: '0 14px', color: 'var(--text-primary)', fontSize: '15px', fontFamily: 'var(--font-sans)', outline: 'none', opacity: disabled ? 0.6 : 1 }} />
    </div>
  );
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return <p id="invite-form-error" role="alert" aria-live="assertive" style={{ fontSize: '13px', color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: 0 }}>{children}</p>;
}

function submitStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: '48px', marginTop: '4px',
    borderRadius: 'var(--radius-md)',
    background: disabled ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
    color: '#FFFFFF', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
