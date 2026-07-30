'use client';

/* ───────────────────────────────────────────────────────────────────────
   AddHotelModal — create a hotel directly from the Live-hotels tab.

   Opened from an organization's "+ Add hotel" action or the Independent Hotels
   toolbar. This is a DIRECT platform-admin create: name + rooms are optional,
   and the hotel appears immediately with no PMS and no customer accounts. An
   organization-scoped launch assigns the new shell to that organization in the
   same request; inviting the first person is a separate People action.

   Posts to /api/admin/properties/create. Studio chrome (dark Backdrop + light
   MODAL_CARD), matching SectionsModal / CoveragePickerModal.
   English-only (admin studio surface).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
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
}

interface CreatedResult {
  propertyId: string;
  name: string;
}

export function AddHotelModal({
  onClose,
  onCreated,
  organizationId,
  organizationName,
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
      const res = await fetchWithAuth('/api/admin/properties/create', {
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
      // Refetch the fleet NOW so the new card is already there behind the
      // success view when the admin clicks Done / Open hotel.
      onCreated(json.data.propertyId as string);
      setCreated({
        propertyId: json.data.propertyId,
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
            <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 16px', lineHeight: 1.5 }}>
              {organizationName
                ? <>It&apos;s assigned to {organizationName} with no customer accounts. Add the first person from the hotel&apos;s People action when you&apos;re ready.</>
                : <>It&apos;s now an independent hotel with no customer accounts. Add the first person from the hotel&apos;s People action when you&apos;re ready.</>}
            </p>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="primary" onClick={openCreatedHotel}>Open hotel →</Btn>
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

            {error && <div style={errorBox}>{error}</div>}

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
