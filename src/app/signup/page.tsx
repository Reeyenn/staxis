'use client';

/**
 * Public signup page — landing for self-service trial.
 *
 * Flow:
 *   1. GM fills in email, password, hotel info
 *   2. POST /api/signup creates auth user + property + accounts row
 *   3. Response includes a Supabase access_token; we set the session
 *      and redirect to /onboarding to finish setup
 *
 * After /onboarding (services + staff questionnaire), they land on
 * /property-selector → /dashboard with a 14-day trial running.
 *
 * No auth required to access this page. Existing signed-in users get
 * bounced to /property-selector.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { Building2, Mail, Lock, MapPin, Hotel, ChevronRight, AlertCircle } from 'lucide-react';

const PROPERTY_KINDS = [
  { value: 'limited_service', label: 'Limited service (Comfort Suites, Holiday Inn Express, Hampton Inn…)' },
  { value: 'extended_stay',   label: 'Extended stay (Residence Inn, Candlewood, Staybridge…)' },
  { value: 'full_service',    label: 'Full service (Marriott, Hilton, Hyatt…)' },
  { value: 'boutique',        label: 'Boutique / independent' },
  { value: 'other',           label: 'Other' },
];

const TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
];

export default function SignupPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [ownerName, setOwnerName]       = useState('');
  const [hotelName, setHotelName]       = useState('');
  const [propertyKind, setPropertyKind] = useState('limited_service');
  const [totalRooms, setTotalRooms]     = useState('');
  const [timezone, setTimezone]         = useState('America/Chicago');
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState('');

  useEffect(() => {
    if (!loading && user) router.replace('/property-selector');
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password || !ownerName || !hotelName || !totalRooms) {
      setError('Please fill in every field above.');
      return;
    }
    const rooms = parseInt(totalRooms, 10);
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 5000) {
      setError('Total rooms must be a whole number between 1 and 5000.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, password, ownerName, hotelName,
          propertyKind, totalRooms: rooms, timezone,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Signup failed. Please try again.');
        setSubmitting(false);
        return;
      }

      // Hand the Supabase session to the browser client so subsequent
      // requests (and AuthContext's onAuthStateChange) see us as
      // signed in. After this resolves, /onboarding can fetch the
      // property using the same session.
      if (json.data.accessToken && json.data.refreshToken) {
        const { error: setErr } = await supabase.auth.setSession({
          access_token: json.data.accessToken,
          refresh_token: json.data.refreshToken,
        });
        if (setErr) {
          setError(`Signed up but couldn't sign you in automatically: ${setErr.message}. Try /signin.`);
          setSubmitting(false);
          return;
        }
        // Wait for getSession() to actually reflect the new session
        // before redirecting. setSession() is async but the in-memory
        // cache is updated synchronously; even so, give it a tick to
        // make sure other supabase clients in this tab (AuthContext's
        // onAuthStateChange, fetchWithAuth's getSession) see it.
        for (let i = 0; i < 20; i++) {
          const { data: { session: s } } = await supabase.auth.getSession();
          if (s?.access_token) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      router.replace(`/onboarding?propertyId=${json.data.propertyId}&fresh=1`);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'flex-start',
      padding: '32px 24px 64px',
    }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>

        {/* Logo */}
        <div style={{ marginBottom: '32px', textAlign: 'center' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '11px',
            background: 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '26px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '6px',
          }}>
            Start your account
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1.5 }}>
            Free during pilot. No credit card required.<br />
            Connect your PMS and Maria gets her dashboard tomorrow.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Account section */}
          <div className="card" style={{ padding: '20px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Your account
            </p>

            <div style={{ marginBottom: '12px' }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Mail size={13}/> Email</label>
              <input
                type="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                required autoComplete="email"
                placeholder="you@example.com"
                className="input"
              />
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Lock size={13}/> Password</label>
              <input
                type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                required minLength={8} autoComplete="new-password"
                placeholder="At least 8 characters"
                className="input"
              />
            </div>

            <div>
              <label className="label">Your name</label>
              <input
                type="text" value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                required autoComplete="name"
                placeholder="Jane Smith"
                className="input"
              />
            </div>
          </div>

          {/* Property section */}
          <div className="card" style={{ padding: '20px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Your property
            </p>

            <div style={{ marginBottom: '12px' }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Building2 size={13}/> Hotel name</label>
              <input
                type="text" value={hotelName}
                onChange={(e) => setHotelName(e.target.value)}
                required
                placeholder="Comfort Suites Beaumont"
                className="input"
              />
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Hotel size={13}/> Property type</label>
              <select value={propertyKind} onChange={(e) => setPropertyKind(e.target.value)} className="input">
                {PROPERTY_KINDS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label className="label">Total rooms</label>
                <input
                  type="number" min={1} max={5000} value={totalRooms}
                  onChange={(e) => setTotalRooms(e.target.value)}
                  required placeholder="74"
                  className="input"
                />
              </div>
              <div>
                <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><MapPin size={13}/> Timezone</label>
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="input">
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
            </div>
          </div>

          {error && (
            <div style={{
              padding: '12px 14px',
              background: 'var(--red-dim)',
              border: '1px solid var(--red-border, rgba(239,68,68,0.25))',
              borderRadius: '10px',
              display: 'flex', gap: '10px', alignItems: 'flex-start',
            }}>
              <AlertCircle size={16} color="var(--red)" style={{ flexShrink: 0, marginTop: '1px' }} />
              <p style={{ fontSize: '13px', color: 'var(--red)', lineHeight: 1.5 }}>{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="btn btn-primary"
            style={{ justifyContent: 'center', padding: '14px 0' }}
          >
            {submitting ? 'Creating your account…' : (
              <>Start trial <ChevronRight size={16} /></>
            )}
          </button>

          <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--text-muted)' }}>
            Already have an account? <Link href="/signin" style={{ color: 'var(--amber)' }}>Sign in</Link>
          </p>

          <p style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5, marginTop: '12px' }}>
            By continuing you agree to our terms of service. We don't share your data.
            Free during pilot. We'll let you know before billing turns on.
          </p>
        </form>
      </div>
    </div>
  );
}
