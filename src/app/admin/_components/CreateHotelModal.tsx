'use client';

/**
 * Phase M1 (2026-05-14) — admin "Create new hotel" modal.
 *
 * The only path that creates a property in the product. Posts to
 * /api/admin/properties/create which:
 *   1. Inserts the property with the admin as owner_id placeholder
 *   2. Mints a single-use, 7-day owner-role join code
 *   3. Returns the join code + signup URL for the admin to share
 *
 * UI design intent: the form is intentionally short (5 required fields,
 * 4 optional). At 300 hotels we're going to fill this out 3+ times a day
 * — every extra field is friction. PMS connection, billing, branding can
 * happen post-creation in the per-property triage view.
 *
 * The signup URL is shown after success in a copyable block. Owner gets
 * the URL out-of-band (Slack, email — admin's choice).
 */

import React, { useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { X, Building2, Check, Copy, AlertCircle } from 'lucide-react';

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
  // Phase M1.5 additions:
  emailSent?: boolean;
  emailError?: string | null;
  inviteRole?: 'owner' | 'general_manager';
}

type DeliveryMode = 'copy' | 'email';

// Browser default timezone (admin's local) is the right initial guess —
// most Staxis admins create hotels in their own timezone or near-by.
function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

// Curated list of common US hotel timezones, plus the user's detected
// browser timezone if it isn't already in the list. Full IANA list via
// Intl.supportedValuesOf is 400+ entries which is overkill for a hotel
// admin form — they'd scroll forever. The "Other..." escape hatch lets
// them type any IANA name they need.
function buildTimezoneOptions(detected: string): string[] {
  const common = [
    'America/New_York',     // Eastern
    'America/Chicago',      // Central
    'America/Denver',       // Mountain
    'America/Phoenix',      // Mountain (no DST — Arizona)
    'America/Los_Angeles',  // Pacific
    'America/Anchorage',    // Alaska
    'Pacific/Honolulu',     // Hawaii
    'America/Puerto_Rico',  // Atlantic
    'UTC',
  ];
  if (!common.includes(detected)) common.unshift(detected);
  return common;
}

export function CreateHotelModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [totalRooms, setTotalRooms] = useState<number | ''>('');
  const initialTz = defaultTimezone();
  const [timezone, setTimezone] = useState(initialTz);
  const [tzMode, setTzMode] = useState<'preset' | 'custom'>('preset');
  const [customTz, setCustomTz] = useState('');
  const [pmsType, setPmsType] = useState<string>('');
  const [brand, setBrand] = useState('');
  const [propertyKind, setPropertyKind] = useState('limited_service');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [isTest, setIsTest] = useState(false);
  // Phase M1.5: invite role + delivery mode
  const [inviteRole, setInviteRole] = useState<'owner' | 'general_manager'>('owner');
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('copy');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState<'code' | 'url' | null>(null);

  if (!open) return null;

  const reset = () => {
    setName(''); setTotalRooms(''); setTimezone(initialTz); setTzMode('preset');
    setCustomTz(''); setPmsType(''); setBrand(''); setPropertyKind('limited_service');
    setOwnerEmail(''); setIsTest(false);
    setInviteRole('owner'); setDeliveryMode('copy');
    setSubmitting(false); setError(null); setResult(null); setCopied(null);
  };

  const handleClose = () => { reset(); onClose(); };

  const submit = async () => {
    setError(null);
    const finalTz = tzMode === 'custom' ? customTz.trim() : timezone;
    if (!name.trim() || name.trim().length < 3) { setError('Name must be at least 3 characters.'); return; }
    if (typeof totalRooms !== 'number' || totalRooms < 1) { setError('Total rooms must be at least 1.'); return; }
    if (!finalTz) { setError('Timezone is required.'); return; }
    // Phase M1.5: if delivery is "email", the email field is required.
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
          name: name.trim(),
          totalRooms,
          timezone: finalTz,
          pmsType: pmsType || undefined,
          brand: brand.trim() || undefined,
          propertyKind,
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
      // clipboard API rejects in non-secure contexts; fall back to alert.
      window.prompt('Copy this:', text);
    }
  };

  const tzOptions = buildTimezoneOptions(initialTz);

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-primary)', borderRadius: '12px',
          width: '100%', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto',
          border: '1px solid var(--border)',
        }}
      >
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 700 }}>
            <Building2 size={16} color="var(--amber)" />
            {result ? 'Hotel created' : 'New hotel'}
          </h2>
          <button onClick={handleClose} className="btn btn-ghost" style={{ padding: '4px' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '20px' }}>
          {result ? (
            <SuccessView result={result} onCopy={copy} copied={copied} onClose={handleClose} />
          ) : (
            <>
              {error && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px 12px', marginBottom: '14px',
                  background: 'var(--red-dim, rgba(239,68,68,0.1))', borderRadius: '8px',
                  color: 'var(--red)', fontSize: '13px',
                }}>
                  <AlertCircle size={14} />
                  {error}
                </div>
              )}

              <Field label="Hotel name *">
                <input
                  type="text" value={name} onChange={(e) => setName(e.target.value)}
                  className="input" placeholder="e.g. Hampton Inn Beaumont"
                  maxLength={100}
                />
              </Field>

              <Field label="Total rooms *">
                <input
                  type="number" value={totalRooms} onChange={(e) => {
                    const v = e.target.value;
                    setTotalRooms(v === '' ? '' : Number(v));
                  }}
                  className="input" placeholder="e.g. 80"
                  min={1} max={2000}
                />
              </Field>

              <Field label="Timezone *">
                {tzMode === 'preset' ? (
                  <>
                    <select
                      value={timezone}
                      onChange={(e) => {
                        if (e.target.value === '__other__') { setTzMode('custom'); }
                        else setTimezone(e.target.value);
                      }}
                      className="input"
                    >
                      {tzOptions.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                      <option value="__other__">Other (enter IANA name)…</option>
                    </select>
                  </>
                ) : (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text" value={customTz} onChange={(e) => setCustomTz(e.target.value)}
                      className="input" placeholder="e.g. Europe/Madrid"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button" onClick={() => setTzMode('preset')}
                      className="btn btn-secondary" style={{ whiteSpace: 'nowrap' }}
                    >
                      Pick from list
                    </button>
                  </div>
                )}
              </Field>

              <div style={{ height: '1px', background: 'var(--border)', margin: '14px 0' }} />
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>Optional</p>

              <Field label="PMS">
                <select
                  value={pmsType} onChange={(e) => setPmsType(e.target.value)}
                  className="input"
                >
                  <option value="">— None / set up later —</option>
                  <option value="choice_advantage">Choice Advantage</option>
                  <option value="manual_csv">Manual CSV upload</option>
                </select>
              </Field>

              <Field label="Brand">
                <input
                  type="text" value={brand} onChange={(e) => setBrand(e.target.value)}
                  className="input" placeholder="e.g. Marriott, Hilton, IHG"
                  maxLength={100}
                />
              </Field>

              <Field label="Property kind">
                <select
                  value={propertyKind} onChange={(e) => setPropertyKind(e.target.value)}
                  className="input"
                >
                  <option value="limited_service">Limited service</option>
                  <option value="full_service">Full service</option>
                  <option value="extended_stay">Extended stay</option>
                  <option value="resort">Resort</option>
                </select>
              </Field>

              <div style={{ height: '1px', background: 'var(--border)', margin: '14px 0' }} />
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Invite the {inviteRole === 'owner' ? 'owner' : 'general manager'}
              </p>

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
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setDeliveryMode('copy')}
                    className={`btn ${deliveryMode === 'copy' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeliveryMode('email')}
                    className={`btn ${deliveryMode === 'email' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    Send by email
                  </button>
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
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '13px', cursor: 'pointer', marginTop: '8px',
              }}>
                <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
                Test hotel (excluded from fleet aggregates)
              </label>

              <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
                <button
                  onClick={handleClose} className="btn btn-secondary"
                  style={{ flex: 1, justifyContent: 'center' }}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  onClick={submit} className="btn btn-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                  disabled={submitting || !name.trim() || totalRooms === '' || totalRooms < 1}
                >
                  {submitting ? 'Creating…' : 'Create hotel'}
                </button>
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
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px', marginBottom: '16px',
        background: 'var(--green-dim, rgba(34,197,94,0.1))', borderRadius: '8px',
        color: 'var(--green)', fontSize: '13px',
      }}>
        <Check size={16} />
        {result.emailSent
          ? 'Hotel created and invite emailed. Link below is a copyable backup — expires in 7 days.'
          : 'Hotel created. Send the owner the signup link below — it expires in 7 days.'}
      </div>

      {result.emailSent === false && result.emailError && (
        <div style={{
          padding: '10px 12px', marginBottom: '12px',
          background: 'var(--amber-dim, rgba(245,158,11,0.1))', borderRadius: '8px',
          color: 'var(--amber)', fontSize: '12px',
        }}>
          ⚠ Email send failed ({result.emailError}). The link below still works — copy and send it manually.
        </div>
      )}

      {result.warning && (
        <div style={{
          padding: '10px 12px', marginBottom: '12px',
          background: 'var(--amber-dim, rgba(245,158,11,0.1))', borderRadius: '8px',
          color: 'var(--amber)', fontSize: '12px',
        }}>
          ⚠ {result.warning}
        </div>
      )}

      {result.signupUrl && (
        <Field label="Signup URL (send to owner)">
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text" value={result.signupUrl} readOnly
              className="input" style={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button" onClick={() => onCopy(result.signupUrl!, 'url')}
              className="btn btn-secondary" style={{ whiteSpace: 'nowrap' }}
            >
              {copied === 'url' ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </Field>
      )}

      {result.joinCode && (
        <Field label="Join code (alternative — owner can paste at /signup)">
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text" value={result.joinCode} readOnly
              className="input"
              style={{ flex: 1, fontFamily: 'monospace', fontSize: '14px', letterSpacing: '0.05em' }}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button" onClick={() => onCopy(result.joinCode!, 'code')}
              className="btn btn-secondary" style={{ whiteSpace: 'nowrap' }}
            >
              {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </Field>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <button
          onClick={() => window.open(`/admin/properties/${result.propertyId}`, '_blank')}
          className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }}
        >
          Open hotel
        </button>
        <button onClick={onClose} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>
          Done
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <label style={{
        display: 'block', fontSize: '12px', fontWeight: 600,
        color: 'var(--text-secondary)', marginBottom: '6px',
      }}>
        {label}
      </label>
      {children}
    </div>
  );
}
