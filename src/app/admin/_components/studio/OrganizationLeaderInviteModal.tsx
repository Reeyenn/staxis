'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';

import { fetchWithAuth } from '@/lib/api-fetch';
import { JOB_CATEGORIES } from '@/lib/organization-access';

import { Btn, Caps, FONT_SERIF } from './kit';
import { Backdrop, MODAL_CARD } from './surface-kit';

interface OrganizationLeaderInviteModalProps {
  organization: { id: string; name: string };
  onClose: () => void;
  onFinished: () => void;
}

interface InvitePayload {
  ok?: boolean;
  data?: {
    inviteLink?: string;
    emailSent?: boolean;
    emailError?: string | null;
  };
  error?: string | { message?: string };
}

const LEADER_PROFILES = [
  ['organization_owner', 'Organization owner'],
  ['organization_admin', 'Organization administrator'],
] as const;

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function apiError(payload: InvitePayload, fallback: string): string {
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  return fallback;
}

export function OrganizationLeaderInviteModal({
  organization,
  onClose,
  onFinished,
}: OrganizationLeaderInviteModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [email, setEmail] = useState('');
  const [accessProfile, setAccessProfile] = useState<(typeof LEADER_PROFILES)[number][0]>('organization_owner');
  const [jobCategory, setJobCategory] = useState('owner_principal');
  const [jobTitle, setJobTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ link: string; emailSent: boolean; emailError: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const cleanEmail = email.trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail);

  savingRef.current = saving;

  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    emailRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (result) dialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [result]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!emailValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/admin/organizations/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: organization.id,
          email: cleanEmail,
          accessProfile,
          jobCategory,
          jobTitle: jobTitle.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as InvitePayload;
      if (!response.ok || payload.ok !== true || !payload.data?.inviteLink) {
        setError(apiError(payload, 'Could not create the organization invitation.'));
        return;
      }
      setResult({
        link: payload.data.inviteLink,
        emailSent: payload.data.emailSent === true,
        emailError: payload.data.emailError ?? null,
      });
    } catch (caught) {
      setError(`Network error: ${caught instanceof Error ? caught.message : 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const finish = () => {
    onFinished();
    onClose();
  };

  return (
    <Backdrop onClose={() => { if (!saving) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-leader-title"
        aria-describedby="organization-leader-description"
        onClick={(event) => event.stopPropagation()}
        style={{ ...MODAL_CARD, width: 520 }}
      >
        <Caps>Company access</Caps>
        <h3
          id="organization-leader-title"
          style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 8px' }}
        >
          Invite a leader to <span style={{ fontStyle: 'italic' }}>{organization.name}</span>
        </h3>
        <p id="organization-leader-description" className="studio-modal-copy">
          This bootstraps the customer side of the company. Staxis remains separate and never becomes a company member.
        </p>

        {result ? (
          <div>
            <div className="studio-modal-preview" role="status">
              <Caps size={9}>{result.emailSent ? 'Invitation sent' : 'Invitation ready'}</Caps>
              <p>
                {result.emailSent
                  ? `The secure invitation was emailed to ${cleanEmail}.`
                  : `Email delivery was unavailable. Copy the secure link and send it to ${cleanEmail}.`}
              </p>
              {result.emailError && !result.emailSent ? <small>{result.emailError}</small> : null}
            </div>
            <div className="studio-modal-actions">
              <Btn
                variant="forest"
                size="lg"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(result.link);
                    setCopied(true);
                  } catch {
                    setError('The link could not be copied automatically. Please try again.');
                  }
                }}
              >
                {copied ? 'Link copied' : 'Copy invite link'}
              </Btn>
              <Btn variant="ghost" size="lg" onClick={finish}>Done</Btn>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label className="studio-modal-field">
              <span>Email address</span>
              <input
                ref={emailRef}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="leader@company.com"
                autoComplete="email"
                disabled={saving}
                aria-invalid={email.length > 0 && !emailValid}
                required
              />
            </label>
            <label className="studio-modal-field">
              <span>Company access profile</span>
              <select
                value={accessProfile}
                onChange={(event) => {
                  const next = event.target.value as typeof accessProfile;
                  setAccessProfile(next);
                  setJobCategory(next === 'organization_owner' ? 'owner_principal' : 'executive');
                }}
                disabled={saving}
              >
                {LEADER_PROFILES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="studio-modal-field">
              <span>Job category</span>
              <select value={jobCategory} onChange={(event) => setJobCategory(event.target.value)} disabled={saving}>
                {JOB_CATEGORIES.map((category) => <option key={category} value={category}>{titleCase(category)}</option>)}
              </select>
            </label>
            <label className="studio-modal-field">
              <span>Exact job title (optional)</span>
              <input
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
                maxLength={120}
                placeholder="President, VP of Operations, Regional Director…"
                disabled={saving}
              />
            </label>

            <div className="studio-modal-preview" aria-live="polite">
              <Caps size={9}>Access preview</Caps>
              <p>
                <strong>{cleanEmail || 'This person'}</strong> will receive {accessProfile === 'organization_owner'
                  ? 'full company control, including billing and ownership transfer'
                  : 'company administration without billing or ownership transfer'} across <strong>{organization.name}</strong>.
              </p>
              <small>The email-specific link expires in seven days and grants nothing until accepted.</small>
            </div>

            {error ? <div className="studio-modal-error" role="alert">{error}</div> : null}
            <div className="studio-modal-actions">
              <Btn type="submit" variant="forest" size="lg" disabled={!emailValid || saving}>
                {saving ? 'Creating…' : 'Create invitation'}
              </Btn>
              <Btn variant="ghost" size="lg" onClick={onClose} disabled={saving}>Cancel</Btn>
            </div>
          </form>
        )}
        {result && error ? <div className="studio-modal-error" role="alert">{error}</div> : null}
      </div>
    </Backdrop>
  );
}
