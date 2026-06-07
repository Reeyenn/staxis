'use client';

/**
 * Admin "Invite a hotel" modal.
 *
 * Phase M1 (2026-05-14) created hotels here by keying in name + rooms +
 * timezone + PMS + brand. Reworked 2026-06-07 into a LEAN invite generator:
 * at 300+ hotels the admin shouldn't hand-key each property's details. This
 * screen now does exactly one thing — generate (or email) a single-use
 * onboarding link. The hotel's owner enters their hotel name, room count,
 * timezone, and connects their PMS THEMSELVES during the onboarding wizard
 * (Step 4 "Hotel Details" + Step 6 "Connect PMS").
 *
 * Posts to /api/admin/properties/create which:
 *   1. Creates the property with a PLACEHOLDER name (owner renames it in the
 *      wizard) + the admin as owner_id placeholder
 *   2. Mints a single-use, 7-day owner/GM-role join code
 *   3. Returns the join code + signup URL for the admin to share
 *
 * The signup URL is shown after success in a copyable block (or emailed).
 */

import React, { useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { X, Building2, Check, Copy, AlertCircle } from 'lucide-react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Btn } from './_snow';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (propertyId: string) => void;
}

interface CreatedResult {
  propertyId: string;
  joinCode: string | null;
  signupUrl: string | null;
  expiresAt: string | null;
  warning?: string;
  emailSent?: boolean;
  emailError?: string | null;
  inviteRole?: 'owner' | 'general_manager';
}

type DeliveryMode = 'copy' | 'email';

export function CreateHotelModal({ open, onClose, onCreated }: Props) {
  const [ownerEmail, setOwnerEmail] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [inviteRole, setInviteRole] = useState<'owner' | 'general_manager'>('owner');
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('copy');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState<'code' | 'url' | null>(null);

  if (!open) return null;

  const reset = () => {
    setOwnerEmail(''); setIsTest(false);
    setInviteRole('owner'); setDeliveryMode('copy');
    setSubmitting(false); setError(null); setResult(null); setCopied(null);
  };

  const handleClose = () => { reset(); onClose(); };

  const submit = async () => {
    setError(null);
    // The only thing this flow validates: when delivering by email, an
    // email address is required. Everything else (hotel name, room count,
    // timezone, PMS…) is collected from the owner during onboarding.
    if (deliveryMode === 'email') {
      const emailTrimmed = ownerEmail.trim();
      if (!emailTrimmed || !emailTrimmed.includes('@')) {
        setError('Email is required when sending the invite by email.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/admin/properties/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          isTest,
          ownerEmail: ownerEmail.trim() || undefined,
          inviteRole,
          sendEmail: deliveryMode === 'email',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error || `Server returned ${res.status}`);
        return;
      }
      setResult(json.data as CreatedResult);
      onCreated?.(json.data.propertyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string, kind: 'code' | 'url') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard API rejects in non-secure contexts; fall back to prompt.
      window.prompt('Copy this:', text);
    }
  };

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
        fontFamily: FONT_SANS,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.paper, borderRadius: 18,
          width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
          border: `1px solid ${T.rule}`,
          boxShadow: '0 28px 64px -20px rgba(31,35,28,0.30)',
        }}
      >
        <div style={{
          padding: '18px 22px', borderBottom: `1px solid ${T.rule}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <Caps>{result ? (result.signupUrl ? 'Invite created' : 'Invite incomplete') : 'Invite a hotel'}</Caps>
            <h2 style={{
              fontFamily: FONT_SERIF, fontSize: 24, fontWeight: 400,
              letterSpacing: '-0.02em', color: T.ink, margin: '2px 0 0',
              lineHeight: 1.15, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Building2 size={18} color={T.caramelDeep} />
              {result?.signupUrl ? 'Send the' : 'Generate an'} <span style={{ fontStyle: 'italic' }}>{result?.signupUrl ? 'signup link' : 'onboarding link'}</span>
            </h2>
          </div>
          <button
            onClick={handleClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: 6, color: T.ink3, display: 'flex',
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 22 }}>
          {result ? (
            <SuccessView result={result} onCopy={copy} copied={copied} onClose={handleClose} />
          ) : (
            <>
              {error && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 14px', marginBottom: 14,
                  background: T.warmDim, borderRadius: 12,
                  border: `1px solid rgba(184,92,61,0.25)`,
                  color: T.warm, fontSize: 13,
                }}>
                  <AlertCircle size={14} />
                  {error}
                </div>
              )}

              <p style={{
                fontSize: 13.5, color: T.ink2, lineHeight: 1.6, margin: '0 0 18px',
                fontFamily: FONT_SERIF, fontStyle: 'italic',
              }}>
                Generate a one-time link and send it to the hotel. They enter their
                hotel name, room count, and connect their PMS themselves during
                onboarding — you don&apos;t fill any of that in here.
              </p>

              <Caps style={{ marginBottom: 12, display: 'block' }}>
                Invite the {inviteRole === 'owner' ? 'owner' : 'general manager'}
              </Caps>

              <Field label="Their role at the hotel *">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'owner' | 'general_manager')}
                  className="input"
                >
                  <option value="owner">Owner</option>
                  <option value="general_manager">General manager</option>
                </select>
              </Field>

              <Field label="How to send the invite *">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn
                    variant={deliveryMode === 'copy' ? 'primary' : 'ghost'}
                    size="md"
                    onClick={() => setDeliveryMode('copy')}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Copy link
                  </Btn>
                  <Btn
                    variant={deliveryMode === 'email' ? 'primary' : 'ghost'}
                    size="md"
                    onClick={() => setDeliveryMode('email')}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Send by email
                  </Btn>
                </div>
              </Field>

              <Field label={deliveryMode === 'email' ? 'Their email * (we\'ll send the invite here)' : 'Their email (optional — for the audit log)'}>
                <input
                  type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}
                  className="input" placeholder="owner@hotel.com"
                  required={deliveryMode === 'email'}
                />
              </Field>

              <label style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13, cursor: 'pointer', marginTop: 12, color: T.ink2,
              }}>
                <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
                Test hotel (excluded from fleet aggregates)
              </label>

              <div style={{ display: 'flex', gap: 8, marginTop: 22 }}>
                <Btn
                  variant="ghost" size="md"
                  onClick={handleClose}
                  disabled={submitting}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Cancel
                </Btn>
                <Btn
                  variant="primary" size="md"
                  onClick={submit}
                  disabled={submitting}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  {submitting ? 'Creating…' : (deliveryMode === 'email' ? 'Create & email link' : 'Create & copy link')}
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessView({
  result, onCopy, copied, onClose,
}: {
  result: CreatedResult;
  onCopy: (text: string, kind: 'code' | 'url') => void;
  copied: 'code' | 'url' | null;
  onClose: () => void;
}) {
  return (
    <div>
      {/* Only claim success when a real signup link came back. If the join
          code failed to mint, signupUrl is null — show an honest failure
          state (the warning block below carries the retry hint) instead of
          a green "link ready" banner that points at nothing. */}
      {result.signupUrl ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', marginBottom: 18,
          background: T.sageDim, borderRadius: 12,
          border: `1px solid rgba(104,131,114,0.30)`,
          color: T.sageDeep, fontSize: 13, lineHeight: 1.5,
        }}>
          <Check size={16} />
          {result.emailSent
            ? 'Invite emailed. Link below is a copyable backup — expires in 7 days.'
            : 'Onboarding link ready. Send it to the hotel — it expires in 7 days.'}
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', marginBottom: 18,
          background: T.warmDim, borderRadius: 12,
          border: `1px solid rgba(184,92,61,0.25)`,
          color: T.warm, fontSize: 13, lineHeight: 1.5,
        }}>
          <AlertCircle size={16} />
          Invite link couldn&apos;t be generated. The hotel was created but has no
          working signup link yet — see the note below, then retry from the hotel&apos;s page.
        </div>
      )}

      {result.emailSent === false && result.emailError && (
        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: 'rgba(215,176,126,0.14)', borderRadius: 12,
          border: `1px solid rgba(140,106,51,0.25)`,
          color: T.caramelDeep, fontSize: 12,
        }}>
          ⚠ Email send failed ({result.emailError}). The link below still works — copy and send it manually.
        </div>
      )}

      {result.warning && (
        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: 'rgba(215,176,126,0.14)', borderRadius: 12,
          border: `1px solid rgba(140,106,51,0.25)`,
          color: T.caramelDeep, fontSize: 12,
        }}>
          ⚠ {result.warning}
        </div>
      )}

      {result.signupUrl && (
        <Field label="Signup URL (send to owner)">
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text" value={result.signupUrl} readOnly
              className="input" style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 12 }}
              onFocus={(e) => e.target.select()}
            />
            <Btn variant="ghost" size="md" onClick={() => onCopy(result.signupUrl!, 'url')}>
              {copied === 'url' ? <Check size={14} /> : <Copy size={14} />}
            </Btn>
          </div>
        </Field>
      )}

      {result.joinCode && (
        <Field label="Join code (owner can paste at /signup)">
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text" value={result.joinCode} readOnly
              className="input"
              style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 14, letterSpacing: '0.06em' }}
              onFocus={(e) => e.target.select()}
            />
            <Btn variant="ghost" size="md" onClick={() => onCopy(result.joinCode!, 'code')}>
              {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
            </Btn>
          </div>
        </Field>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <Btn
          variant="ghost" size="md"
          onClick={() => window.open(`/admin/properties/${result.propertyId}`, '_blank')}
          style={{ flex: 1, justifyContent: 'center' }}
        >
          Open hotel
        </Btn>
        <Btn variant="primary" size="md" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>
          Done
        </Btn>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'block', marginBottom: 6,
      }}>
        <Caps>{label}</Caps>
      </label>
      {children}
    </div>
  );
}
