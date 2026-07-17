'use client';

// JoinStatusGate — the full-screen state a signed-in account with ZERO
// property access sees. Staff who sign up with a shared join code now land
// PENDING (empty property_access + a join_requests row), so instead of the
// bare "No properties found" card we show them where they stand and let them
// wait for a manager to approve them.
//
// State comes from GET /api/auth/my-join-status (session-scoped, service-role
// backed — join_requests is deny-all RLS). We poll it every 3s WHILE pending
// (so approval feels live) and also on a manual "Check again" tap:
//   - pending  → "You're almost in" + hotel name + refresh + sign out
//   - denied   → declined message + sign out
//   - approved → the manager granted access; refresh the session (re-mint
//                claims) and hard-reload so PropertyContext picks up the new
//                property_access and routes them into the app
//   - null     → a genuinely property-less account (e.g. legacy) → fall back
//                to the app's existing "No properties found" message
//   - fetch error → same fall-back, so a flaky status read never traps the
//                user on a spinner
//
// Note on why a plain reload is enough on approval: the properties RLS
// (user_owns_property) and AuthContext both read property_access straight from
// the accounts row via auth.uid(), not from a JWT claim — so once the manager
// writes access, a reload surfaces the hotel with no stale-token dance. We
// still refreshSession() first as belt-and-suspenders.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Ban, LogOut, RefreshCw, Building2 } from 'lucide-react';
import type { Language } from '@/lib/translations';
import { t } from '@/lib/translations';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';

type JoinRequest = {
  status: 'pending' | 'approved' | 'denied';
  createdAt: string | null;
  decidedAt: string | null;
  hotelName: string | null;
};

type GateState = 'loading' | 'pending' | 'denied' | 'approved' | 'fallback';

export default function JoinStatusGate({
  lang,
  onSignOut,
}: {
  lang: Language;
  onSignOut: () => void | Promise<void>;
}) {
  const [state, setState] = useState<GateState>('loading');
  const [hotelName, setHotelName] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Guard against a reload firing twice (poll + manual overlap).
  const reloadingRef = useRef(false);

  const enterApp = useCallback(async () => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    setState('approved');
    // Re-mint the session so any downstream claim-based checks see the fresh
    // access, then hard-reload into PropertyContext's normal routing.
    try { await supabase.auth.refreshSession(); } catch { /* reload anyway */ }
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/auth/my-join-status');
      if (!res.ok) { setState('fallback'); return; }
      const body = await res.json().catch(() => null) as
        | { data?: { request?: JoinRequest | null } }
        | null;
      const request = body?.data?.request ?? null;
      if (!request) { setState('fallback'); return; }
      if (request.status === 'approved') { void enterApp(); return; }
      setHotelName(request.hotelName);
      setState(request.status === 'denied' ? 'denied' : 'pending');
    } catch (err) {
      // Session ended mid-poll → fetchWithAuth is already navigating; do nothing.
      if (err instanceof SessionEndedError) return;
      setState('fallback');
    }
  }, [enterApp]);

  // Initial load once on mount.
  useEffect(() => { void load(); }, [load]);

  // Auto-refetch every 3s, but ONLY while pending — the moment a manager taps
  // Approve, the waiting employee is pulled into the app within a few seconds
  // without touching "Check again". Terminal states (denied / fallback) stop
  // polling so a phone left on this screen isn't hammering the endpoint.
  useEffect(() => {
    if (state !== 'pending') return;
    const id = window.setInterval(() => { void load(); }, 3_000);
    return () => window.clearInterval(id);
  }, [state, load]);

  const handleCheckAgain = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    await load();
    setChecking(false);
  }, [checking, load]);

  // ── Shared shell ─────────────────────────────────────────────────────────
  const shell = (children: React.ReactNode) => (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '440px', textAlign: 'center' }}>
        <div style={{
          width: '48px', height: '48px', borderRadius: '12px',
          background: 'var(--amber)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px',
        }}>
          <span style={{ fontSize: '22px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
        </div>
        {children}
      </div>
    </div>
  );

  const signOutButton = (
    <button
      onClick={() => { void onSignOut(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        background: 'transparent', border: 'none',
        color: 'var(--text-muted)', fontSize: '13px',
        cursor: 'pointer', fontFamily: 'var(--font-sans)',
        padding: '8px 12px',
      }}
    >
      <LogOut size={13} />
      {t('signOut', lang)}
    </button>
  );

  // ── Loading (first fetch not yet resolved) ───────────────────────────────
  if (state === 'loading' || state === 'approved') {
    return shell(
      <div style={{
        width: '36px', height: '36px', margin: '0 auto',
        border: '3px solid rgba(37,99,235,0.15)',
        borderTopColor: 'var(--navy-light)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Fallback: genuinely property-less account (null request or read error).
  // Mirrors the app's existing "No properties found" empty state.
  if (state === 'fallback') {
    return shell(
      <>
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '40px 24px',
        }}>
          <Building2 size={32} color="var(--text-muted)" style={{ margin: '0 auto 16px' }} />
          <p style={{
            fontSize: '15px', fontWeight: 600,
            color: 'var(--text-primary)', marginBottom: '8px',
            fontFamily: 'var(--font-sans)',
          }}>
            {t('noPropertiesFound', lang)}
          </p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {t('noPropertiesDesc', lang)}
          </p>
        </div>
        <div style={{ marginTop: '32px' }}>{signOutButton}</div>
      </>
    );
  }

  // ── Denied ───────────────────────────────────────────────────────────────
  if (state === 'denied') {
    const hotel = hotelName
      ?? (lang === 'es' ? 'el hotel' : 'the hotel');
    return shell(
      <>
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '40px 24px',
        }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '50%',
            background: 'rgba(220,38,38,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <Ban size={24} color="#DC2626" />
          </div>
          <p style={{
            fontSize: '17px', fontWeight: 700,
            color: 'var(--text-primary)', marginBottom: '8px',
            fontFamily: 'var(--font-sans)',
          }}>
            {lang === 'es' ? 'Solicitud rechazada' : 'Request declined'}
          </p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {lang === 'es'
              ? `Tu solicitud para unirte a ${hotel} fue rechazada. Habla con tu gerente.`
              : `Your request to join ${hotel} was declined. Talk to your manager.`}
          </p>
        </div>
        <div style={{ marginTop: '32px' }}>{signOutButton}</div>
      </>
    );
  }

  // ── Pending ──────────────────────────────────────────────────────────────
  const hotel = hotelName ?? (lang === 'es' ? 'tu hotel' : 'your hotel');
  return shell(
    <>
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '40px 24px',
      }}>
        <div style={{
          width: '48px', height: '48px', borderRadius: '50%',
          background: 'rgba(201,150,68,0.14)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 16px',
        }}>
          <Clock size={24} color="#C99644" />
        </div>
        <p style={{
          fontSize: '18px', fontWeight: 700,
          color: 'var(--text-primary)', marginBottom: '6px',
          fontFamily: 'var(--font-sans)', letterSpacing: '-0.01em',
        }}>
          {lang === 'es' ? 'Ya casi estás dentro' : "You're almost in"}
        </p>
        <p style={{
          fontSize: '14px', fontWeight: 600,
          color: 'var(--text-primary)', marginBottom: '10px',
          fontFamily: 'var(--font-sans)',
        }}>
          {hotel}
        </p>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '20px' }}>
          {lang === 'es'
            ? 'Tu gerente solo necesita aprobarte — vuelve a revisar pronto.'
            : 'Your manager just needs to approve you — check back soon.'}
        </p>
        <button
          onClick={() => { void handleCheckAgain(); }}
          disabled={checking}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            width: '100%', height: '42px',
            borderRadius: '12px',
            background: 'var(--amber)',
            border: 'none',
            color: '#FFFFFF', fontSize: '14px', fontWeight: 600,
            cursor: checking ? 'default' : 'pointer',
            fontFamily: 'var(--font-sans)',
            opacity: checking ? 0.7 : 1,
            transition: 'opacity .15s',
          }}
        >
          <RefreshCw size={15} style={checking ? { animation: 'spin 0.8s linear infinite' } : undefined} />
          {checking
            ? (lang === 'es' ? 'Revisando…' : 'Checking…')
            : (lang === 'es' ? 'Revisar de nuevo' : 'Check again')}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </button>
      </div>
      <div style={{ marginTop: '24px' }}>{signOutButton}</div>
    </>
  );
}
