'use client';

/* ───────────────────────────────────────────────────────────────────────
   AddHotelModal — create a hotel (and optionally invite its first person)
   directly from the Live-hotels tab.

   Opened from an organization's "+ Add hotel" action or the Independent Hotels
   toolbar. This is a DIRECT platform-admin create: name + rooms are optional,
   and the hotel appears immediately with no PMS and no customer accounts. An
   organization-scoped launch assigns the new shell to that organization in the
   same request.

   FIRST PERSON (optional, 2026-07-31). Filling in the email turns this into one
   motion: create the hotel, then send the SAME first-person invitation the My
   Hotel → People control sends. There is exactly ONE invite system (house rule
   since migration 0315) — this modal calls /api/admin/properties/invite-first-person,
   the identical route FirstPersonInviteDialog posts to, sequenced after the
   create returns a hotel id. It does not mint codes or send mail itself.

   Ordering and honesty:
     • The email format is checked BEFORE the create fires, so a typo never
       leaves a hotel behind. The invite route can only bind to a hotel that
       already exists, so create-then-invite is the only possible order.
     • If the create succeeds and the invite does NOT, the modal says exactly
       that, keeps the hotel visible, offers a retry that re-sends only the
       invitation (never a second hotel), and points at the People control.
       It must never imply an invitation went out when none did.
     • A created-but-undelivered invitation surfaces the onboarding link so the
       admin can send it directly.

   Posts to /api/admin/properties/create. Studio chrome (dark Backdrop + light
   MODAL_CARD), matching SectionsModal / CoveragePickerModal.
   English-only (admin studio surface).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { Backdrop, MODAL_CARD } from './surface-kit';
import { Btn, Caps, FONT_SERIF, FONT_SANS, useRiseIn } from './kit';

export interface AddHotelModalProps {
  /** Close without creating (Backdrop / Cancel). */
  onClose: () => void;
  /** Exact organization to receive the new hotel. Omitted means independent. */
  organizationId?: string;
  organizationName?: string;
  /** A hotel was created — parent refetches the directory. Does not close the
   *  modal so the admin can open the new hotel or confirm completion. */
  onCreated: (propertyId: string) => void;
  /** Test seam only. Production always uses the authenticated request helper. */
  request?: typeof fetchWithAuth;
}

/** The only two roles the first person may receive (server enforces this too). */
type FirstPersonRole = 'owner' | 'general_manager';

const ROLE_LABEL: Record<FirstPersonRole, string> = {
  owner: 'Owner',
  general_manager: 'General Manager',
};

// Advisory mirror of the server's isValidEmail. Identical to the check
// FirstPersonInviteDialog runs before posting the same route.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteSent {
  invitedEmail: string;
  assignedRole: FirstPersonRole;
  signupUrl: string;
  /** False when the invitation exists but the email could not be delivered. */
  emailSent: boolean;
}

interface CreatedResult {
  propertyId: string;
  name: string;
  /** Whether the admin asked for an invitation on this create at all. */
  inviteRequested: boolean;
  /** Present only when an invitation actually exists. */
  invite: InviteSent | null;
  /** Present when the hotel exists but its invitation did not go out. */
  inviteError: string | null;
}

type InviteOutcome =
  | { ok: true; invite: InviteSent }
  | { ok: false; message: string };

export function AddHotelModal({
  onClose,
  onCreated,
  organizationId,
  organizationName,
  request = fetchWithAuth,
}: AddHotelModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Synchronous re-entrancy latch — `submitting` state commits async, so a fast
  // double-click / Enter+click could otherwise fire two POSTs (the create route
  // has no idempotency key → duplicate hotels).
  const submittingRef = useRef(false);
  const retryingRef = useRef(false);
  const [name, setName] = useState('');
  const [rooms, setRooms] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<FirstPersonRole>('owner');
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useRiseIn(cardRef, { dy: 26, dur: 440 });

  /**
   * The one invite call. Same route, same body shape, same guarded mint as the
   * People control's first-person invitation — this is a caller of that system,
   * not a second one.
   */
  const sendInvite = async (
    hotelId: string,
    normalizedEmail: string,
    assignedRole: FirstPersonRole,
  ): Promise<InviteOutcome> => {
    try {
      const res = await request('/api/admin/properties/invite-first-person', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hotelId, email: normalizedEmail, role: assignedRole }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data) {
        return { ok: false, message: json.error || `Server returned ${res.status}` };
      }
      return {
        ok: true,
        invite: {
          invitedEmail: (json.data.invitedEmail as string) || normalizedEmail,
          assignedRole: (json.data.assignedRole as FirstPersonRole) || assignedRole,
          signupUrl: (json.data.signupUrl as string) || '',
          emailSent: json.data.emailSent === true,
        },
      };
    } catch (e) {
      return {
        ok: false,
        message: `Couldn't reach the server${e instanceof Error && e.message ? ` (${e.message})` : ''}.`,
      };
    }
  };

  const submit = async () => {
    setError(null);
    // Client-side mirrors of the server rules — advisory only; the route is the
    // source of truth. Both fields are OPTIONAL (blank = a placeholder the admin
    // or a future owner can rename; 1 room until set).
    const trimmed = name.trim();
    if (trimmed && (trimmed.length < 3 || trimmed.length > 100)) {
      setError('Hotel name must be 3–100 characters (or leave it blank for now).');
      return;
    }
    let totalRooms: number | undefined;
    if (rooms.trim()) {
      const n = Number(rooms);
      if (!Number.isInteger(n) || n < 1 || n > 2000) {
        setError('Rooms must be a whole number between 1 and 2000 (or leave it blank).');
        return;
      }
      totalRooms = n;
    }

    // The first person is optional. When one IS given, reject a malformed
    // address here so a doomed submission never leaves a hotel behind: the
    // create is not idempotent and the invite cannot run before it.
    const normalizedEmail = email.trim().toLowerCase();
    const wantsInvite = normalizedEmail.length > 0;
    if (wantsInvite && !EMAIL_RX.test(normalizedEmail)) {
      setError('Enter a valid email for the first person, or leave it blank to invite later.');
      return;
    }

    if (submittingRef.current) return;  // guard against a double-fire before setState commits
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await request('/api/admin/properties/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(trimmed ? { name: trimmed } : {}),
          ...(totalRooms !== undefined ? { totalRooms } : {}),
          ...(organizationId ? { organizationId } : {}),
          isTest,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error || `Server returned ${res.status}`);
        return;
      }
      const propertyId = json.data.propertyId as string;
      // Refetch the fleet NOW so the new card is already there behind the
      // success view when the admin clicks Done / Open hotel.
      onCreated(propertyId);
      const base = {
        propertyId,
        name: (json.data.name as string) || trimmed || 'New hotel',
        inviteRequested: wantsInvite,
      };
      if (!wantsInvite) {
        setCreated({ ...base, invite: null, inviteError: null });
        return;
      }
      // The hotel now exists. Whatever happens next, the admin sees the truth
      // about the invitation separately from the truth about the hotel.
      const outcome = await sendInvite(propertyId, normalizedEmail, role);
      setCreated(outcome.ok
        ? { ...base, invite: outcome.invite, inviteError: null }
        : { ...base, invite: null, inviteError: outcome.message });
    } catch (e) {
      // A dropped/timed-out response could mean the hotel WAS created
      // server-side (the route has no idempotency key). Warn the admin to check
      // the fleet before retrying rather than implying a clean failure.
      setError(
        `Couldn't confirm the result${e instanceof Error && e.message ? ` (${e.message})` : ''}. The hotel may or may not have been created. Check the fleet below before trying again.`,
      );
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  /** Re-send ONLY the invitation for the hotel that already exists. */
  const retryInvite = async () => {
    if (!created || retryingRef.current) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_RX.test(normalizedEmail)) {
      setCreated({ ...created, inviteError: 'Enter a valid email for the first person.' });
      return;
    }
    retryingRef.current = true;
    setRetrying(true);
    try {
      const outcome = await sendInvite(created.propertyId, normalizedEmail, role);
      setCreated(outcome.ok
        ? { ...created, invite: outcome.invite, inviteError: null }
        : { ...created, invite: null, inviteError: outcome.message });
    } finally {
      setRetrying(false);
      retryingRef.current = false;
    }
  };

  const openCreatedHotel = () => {
    if (!created) return;
    // PropertyContext's fleet predates this create. Persist the selection and
    // do a full navigation so the fresh property list includes the new hotel.
    localStorage.setItem('hotelops-active-property', created.propertyId);
    window.location.href = '/home';
  };

  /** Deep link to the exact hotel's People control, the same target the fleet
   *  cards use. Persist the selection so People opens on this hotel. */
  const peopleHref = created
    ? `/company?tab=people&pid=${encodeURIComponent(created.propertyId)}`
    : '';
  const rememberPeopleHotel = () => {
    if (!created) return;
    try {
      localStorage.setItem('hotelops-active-property', created.propertyId);
    } catch {
      // The pid query parameter remains authoritative when storage is unavailable.
    }
  };

  const copySignupLink = async () => {
    const url = created?.invite?.signupUrl;
    if (!url) return;
    setCopyError(null);
    if (!await copyToClipboard(url)) {
      setCopyError('Copy failed. Select the link and copy it manually.');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  return (
    <Backdrop onClose={() => { if (!submitting) onClose(); }}>
      <div
        ref={cardRef}
        className="admin-studio"
        onClick={(e) => e.stopPropagation()}
        style={{ ...MODAL_CARD, width: 460, fontFamily: FONT_SANS }}
      >
        <Caps>{created ? 'Hotel created' : 'Add a hotel'}</Caps>

        {created ? (
          <>
            <h3 style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 10px' }}>
              <span style={{ fontStyle: 'italic' }}>{created.name}</span> is in your fleet
            </h3>

            {created.inviteError ? (
              /* The hotel is real. The invitation is not. Say both. */
              <div style={alertBox} role="alert">
                <strong style={{ display: 'block', marginBottom: 4 }}>The hotel was created. The invitation was not sent.</strong>
                <span style={{ display: 'block', marginBottom: 6 }}>{created.inviteError}</span>
                <span style={{ display: 'block' }}>
                  Nobody has been emailed. Try again below, or invite {email.trim().toLowerCase() || 'the first person'} from the hotel&apos;s People control.
                </span>
              </div>
            ) : created.invite ? (
              <div style={created.invite.emailSent ? noticeBox : cautionBox} role="status">
                <strong style={{ display: 'block', marginBottom: 4 }}>
                  {created.invite.emailSent ? 'Invitation sent' : 'Invitation ready, email not delivered'}
                </strong>
                <span>
                  {created.invite.invitedEmail} is invited as {ROLE_LABEL[created.invite.assignedRole]}.
                  {created.invite.emailSent
                    ? ' They start setup from the link in that email.'
                    : ' Copy the link below and send it to them directly.'}
                </span>
              </div>
            ) : null}

            {created.invite?.signupUrl ? (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', marginBottom: 6 }}><Caps size={9}>First-person onboarding link</Caps></label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={created.invite.signupUrl} readOnly aria-label="First-person onboarding link" style={inputStyle} />
                  <Btn variant="ghost" onClick={() => void copySignupLink()}>{copied ? 'Copied' : 'Copy'}</Btn>
                </div>
                {copyError && <div style={{ fontSize: 11.5, color: 'var(--terracotta-deep)', marginTop: 5 }}>{copyError}</div>}
              </div>
            ) : null}

            {!created.inviteRequested && (
              <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 16px', lineHeight: 1.5 }}>
                {organizationName
                  ? <>It&apos;s assigned to {organizationName} with no customer accounts. Add the first person from the hotel&apos;s People action when you&apos;re ready.</>
                  : <>It&apos;s now an independent hotel with no customer accounts. Add the first person from the hotel&apos;s People action when you&apos;re ready.</>}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {created.inviteError && (
                <Btn variant="primary" onClick={() => void retryInvite()} disabled={retrying}>
                  {retrying ? 'Sending…' : 'Send invitation again'}
                </Btn>
              )}
              {(created.inviteError || !created.invite) && (
                <Btn variant="ghost" href={peopleHref} onClick={rememberPeopleHotel}>People control →</Btn>
              )}
              {!created.inviteError && <Btn variant="primary" onClick={openCreatedHotel}>Open hotel →</Btn>}
              <Btn variant="ghost" onClick={onClose}>Done</Btn>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '6px 0 4px' }}>
              New <span style={{ fontStyle: 'italic' }}>hotel</span>
            </h3>
            <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 18px', lineHeight: 1.5 }}>
              Put in as much or as little as you want. You can fill the rest in later. It will be
              {organizationName ? ` assigned to ${organizationName}` : ' independent'} with no customer accounts yet.
            </p>

            {error && <div style={errorBox} role="alert">{error}</div>}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 6 }}><Caps size={9}>Hotel name (optional)</Caps></label>
              <input
                autoFocus
                aria-label="Hotel name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Comfort Suites Beaumont"
                maxLength={100}
                onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) void submit(); }}
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 6 }}><Caps size={9}>Rooms (optional)</Caps></label>
              <input
                type="number"
                aria-label="Rooms (optional)"
                min={1}
                max={2000}
                value={rooms}
                onChange={(e) => setRooms(e.target.value)}
                placeholder="e.g. 60"
                onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) void submit(); }}
                style={inputStyle}
              />
            </div>

            {/* First person — optional. Blank keeps the old flow exactly:
                create the hotel now, invite from People later. */}
            <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14, marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 6 }}><Caps size={9}>First person&apos;s email (optional)</Caps></label>
              <input
                type="email"
                aria-label="First person's email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@example.com"
                autoComplete="email"
                onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) void submit(); }}
                style={inputStyle}
              />
              <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 6, lineHeight: 1.45 }}>
                Fill this in and they get their setup invitation the moment the hotel is created. Leave it blank to invite someone later from the hotel&apos;s People control.
              </div>
              {email.trim() !== '' && (
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'block', marginBottom: 6 }}><Caps size={9}>Their role</Caps></label>
                  <select
                    aria-label="First person's role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as FirstPersonRole)}
                    style={inputStyle}
                  >
                    <option value="owner">Owner</option>
                    <option value="general_manager">General Manager</option>
                  </select>
                  <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 6, lineHeight: 1.45 }}>
                    They see this during signup but cannot change it.
                  </div>
                </div>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink)', cursor: 'pointer', marginTop: 4, marginBottom: 6 }}>
              <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
              Test hotel (a demo / test property)
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <Btn variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Btn>
              <Btn variant="primary" onClick={submit} disabled={submitting}>
                {submitting
                  ? (email.trim() ? 'Creating and inviting…' : 'Creating…')
                  : (email.trim() ? 'Create hotel and invite' : 'Create hotel')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </Backdrop>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 13,
  padding: '9px 11px',
  border: '1px solid var(--rule)',
  borderRadius: 9,
  background: '#fff',
  color: 'var(--ink)',
  outline: 'none',
  fontFamily: FONT_SANS,
};

const errorBox: React.CSSProperties = {
  padding: '11px 13px',
  marginBottom: 14,
  background: 'var(--terracotta-dim)',
  border: '1px solid rgba(194,86,46,.3)',
  borderRadius: 12,
  color: 'var(--terracotta-deep)',
  fontSize: 12.5,
  fontFamily: FONT_SANS,
  lineHeight: 1.45,
};

// Louder than errorBox: this one reports a half-completed action, so it must
// read as a state of the world rather than a rejected form field.
const alertBox: React.CSSProperties = {
  ...errorBox,
  border: '1px solid rgba(194,86,46,.55)',
};

const noticeBox: React.CSSProperties = {
  padding: '11px 13px',
  marginBottom: 14,
  background: 'rgba(60,156,104,.1)',
  border: '1px solid rgba(60,156,104,.35)',
  borderRadius: 12,
  color: 'var(--ink)',
  fontSize: 12.5,
  fontFamily: FONT_SANS,
  lineHeight: 1.45,
};

const cautionBox: React.CSSProperties = {
  ...noticeBox,
  background: 'rgba(201,154,46,.12)',
  border: '1px solid rgba(201,154,46,.4)',
};
