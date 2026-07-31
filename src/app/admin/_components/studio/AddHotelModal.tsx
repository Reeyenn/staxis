'use client';

/* ───────────────────────────────────────────────────────────────────────
   AddHotelModal — create a hotel from the Live-hotels tab, then invite its
   first person without leaving the confirmation.

   Opened from an organization's "+ Add hotel" action or the Independent Hotels
   toolbar. This is a DIRECT platform-admin create: name + rooms are optional,
   and the hotel appears immediately with no PMS and no customer accounts. An
   organization-scoped launch assigns the new shell to that organization in the
   same request.

   INVITING (founder ruling, 2026-07-31, revised after seeing it live). The
   create FORM asks nothing about people. Once the hotel exists, the
   confirmation offers "Invite people", which opens the very same dialog the
   My Hotel → People control opens for a hotel that has no direct account yet:
   FirstPersonInviteDialog, imported from the company surface and rendered in
   place, pre-scoped to the hotel just created. It is lazy so the admin bundle
   only pays for it when an admin actually invites someone.

   There is exactly ONE invite system (house rule since migration 0315). This
   file no longer talks to any invite route at all: the dialog owns the whole
   invitation, including its own validation, busy, and failure states. This
   modal only listens for the receipt so the confirmation can say honestly
   whether an invitation exists, and never claims one when the dialog was
   dismissed without sending.

   Posts to /api/admin/properties/create. Studio chrome (dark Backdrop + light
   MODAL_CARD), matching SectionsModal / CoveragePickerModal.
   English-only (admin studio surface).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { FirstPersonInviteData } from '@/app/company/_components/HotelTeamDialogs';
import { Backdrop, MODAL_CARD } from './surface-kit';
import { Btn, Caps, FONT_SERIF, FONT_SANS, useRiseIn } from './kit';

/**
 * The exact dialog My Hotel → People renders for a hotel with no direct hotel
 * account, which is precisely what a freshly created hotel is. Lazy for the
 * same reason HotelTeamPanel loads it lazily: it is a heavy leaf that most
 * sessions never open.
 */
const LazyFirstPersonInviteDialog = React.lazy(async () => {
  const dialogs = await import('@/app/company/_components/HotelTeamDialogs');
  return { default: dialogs.FirstPersonInviteDialog };
});

export interface AddHotelModalProps {
  /** Close without creating (Backdrop / Cancel). */
  onClose: () => void;
  /** Exact organization to receive the new hotel. Omitted means independent. */
  organizationId?: string;
  organizationName?: string;
  /** A hotel was created — parent refetches the directory. Does not close the
   *  modal so the admin can invite, open the new hotel, or confirm completion. */
  onCreated: (propertyId: string) => void;
  /** Test seam only. Production always uses the authenticated request helper. */
  request?: typeof fetchWithAuth;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  general_manager: 'General Manager',
};

interface CreatedResult {
  propertyId: string;
  name: string;
}

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
  const [name, setName] = useState('');
  const [rooms, setRooms] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResult | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // The dialog's receipt, kept only so the confirmation behind it can report
  // the truth. Absent means nobody was invited from here, full stop.
  const [invited, setInvited] = useState<FirstPersonInviteData | null>(null);

  useRiseIn(cardRef, { dy: 26, dur: 440 });

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
      setCreated({
        propertyId,
        name: (json.data.name as string) || trimmed || 'New hotel',
      });
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

  return (
    <Backdrop onClose={() => { if (!submitting && !inviteOpen) onClose(); }}>
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

            {/* Only ever rendered from the dialog's own receipt. No receipt, no
                claim that anyone was invited. */}
            {invited ? (
              <div style={invited.emailSent ? noticeBox : cautionBox} role="status">
                <strong style={{ display: 'block', marginBottom: 4 }}>
                  {invited.emailSent ? 'Invitation sent' : 'Invitation ready, email not delivered'}
                </strong>
                <span>
                  {invited.invitedEmail} is invited as {ROLE_LABEL[invited.assignedRole] ?? invited.assignedRole}.
                  {invited.emailSent
                    ? ' They start setup from the link in that email.'
                    : ' Use the link from the invite window to send it to them directly.'}
                </span>
              </div>
            ) : null}

            <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 16px', lineHeight: 1.5 }}>
              {organizationName
                ? <>It&apos;s assigned to {organizationName}.</>
                : <>It&apos;s now an independent hotel.</>}
              {!invited && <> No customer accounts yet. Invite the first person now or later from People.</>}
            </p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {/* A hotel gets exactly ONE first-person invitation, so once it
                  exists the server refuses a second one for a different
                  address. Offering "invite again" here would be a dead end:
                  everything past the first person belongs to People. */}
              {invited
                ? <Btn variant="primary" onClick={openCreatedHotel}>Open hotel →</Btn>
                : <Btn variant="primary" onClick={() => setInviteOpen(true)}>Invite people</Btn>}
              <Btn variant="ghost" href={peopleHref} onClick={rememberPeopleHotel}>People control →</Btn>
              {!invited && <Btn variant="ghost" onClick={openCreatedHotel}>Open hotel →</Btn>}
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

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink)', cursor: 'pointer', marginTop: 4, marginBottom: 6 }}>
              <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
              Test hotel (a demo / test property)
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <Btn variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Btn>
              <Btn variant="primary" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create hotel'}
              </Btn>
            </div>
          </>
        )}
      </div>

      {/* The People control's own first-person dialog, scoped to the hotel that
          was just created. It portals above this modal and owns every part of
          the invitation, including its failure states. */}
      {created && inviteOpen ? (
        <React.Suspense fallback={null}>
          <LazyFirstPersonInviteDialog
            hotelId={created.propertyId}
            hotelName={created.name}
            onClose={() => setInviteOpen(false)}
            onInvited={(result) => setInvited(result)}
          />
        </React.Suspense>
      ) : null}
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
