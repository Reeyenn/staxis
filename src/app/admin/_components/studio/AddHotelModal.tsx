'use client';

/* ───────────────────────────────────────────────────────────────────────
   AddHotelModal — create a hotel directly from the Live-hotels tab.

   Opened from the "+ Add hotel" control at the top of the Hotels column. Unlike
   the light-styled CreateHotelModal (a lean INVITE generator that hands the
   owner a signup link to fill everything in themselves), this is a DIRECT admin
   create: put in as much or as little as you want (name + rooms are optional),
   and the hotel appears in the fleet immediately with no PMS ("No system
   detected"). Admins already see every property, so it's ready to configure
   (Sections, Inventory, …) right away — the signup link is optional, only for
   handing the hotel to an outside owner later.

   Posts to the SAME /api/admin/properties/create route the invite flow uses —
   every field there is optional with a sensible default. Studio chrome (dark
   Backdrop + light MODAL_CARD), matching SectionsModal / CoveragePickerModal.
   English-only (admin studio surface).
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Backdrop, MODAL_CARD } from './surface-kit';
import { Btn, Caps, FONT_SERIF, FONT_SANS, FONT_MONO, useRiseIn } from './kit';

export interface AddHotelModalProps {
  /** Close without creating (Backdrop / Cancel). */
  onClose: () => void;
  /** A hotel was created — parent refetches the fleet list. Does NOT close the
   *  modal (the success view shows the optional signup link + Open-hotel). */
  onCreated: (propertyId: string) => void;
}

interface CreatedResult {
  propertyId: string;
  name: string;
  signupUrl: string | null;
}

export function AddHotelModal({ onClose, onCreated }: AddHotelModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Synchronous re-entrancy latch — `submitting` state commits async, so a fast
  // double-click / Enter+click could otherwise fire two POSTs (the create route
  // has no idempotency key → duplicate hotels).
  const submittingRef = useRef(false);
  // Timer for the "Copied" flash — cleared on unmount so a late tick can't
  // setState after the modal closes.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [name, setName] = useState('');
  const [rooms, setRooms] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState(false);

  useRiseIn(cardRef, { dy: 26, dur: 440 });
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

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
        signupUrl: (json.data.signupUrl as string | null) ?? null,
      });
    } catch (e) {
      // A dropped/timed-out response could mean the hotel WAS created
      // server-side (the route has no idempotency key). Warn the admin to check
      // the fleet before retrying rather than implying a clean failure.
      setError(
        `Couldn't confirm the result${e instanceof Error && e.message ? ` (${e.message})` : ''} — the hotel may or may not have been created. Check the fleet below before trying again.`,
      );
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const copyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link:', text);
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
              It&apos;s now in your fleet with no PMS connected — set its sections right from its card.
              The owner signup link below is optional: hand it to an outside owner, or ignore it and
              manage the hotel yourself.
            </p>

            {created.signupUrl && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 6 }}>
                  <Caps size={9}>Owner signup link (optional)</Caps>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    readOnly
                    value={created.signupUrl}
                    onFocus={(e) => e.target.select()}
                    style={{ flex: 1, boxSizing: 'border-box', fontSize: 12, fontFamily: FONT_MONO, padding: '9px 11px', border: '1px solid var(--rule)', borderRadius: 9, background: '#fff', color: 'var(--ink)', outline: 'none' }}
                  />
                  <Btn variant="ghost" onClick={() => copyLink(created.signupUrl!)}>{copied ? 'Copied' : 'Copy'}</Btn>
                </div>
              </div>
            )}

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
              Put in as much or as little as you want — you can fill the rest in later. It joins the
              fleet right away with no PMS connected.
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
