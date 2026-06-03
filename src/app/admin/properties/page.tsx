'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/properties — Owner cockpit ("Admin Studio", June 2026 redesign).
 *
 * Full-bleed dark editorial console with a light blurred sticky header and
 * five surfaces (Onboarding · Live hotels · System & Agent · Money · ML).
 * All visual + interaction work lives in _components/studio/*; this route
 * file is just the auth gate + the studio mount.
 *
 * Auth: admin role only — only Reeyen has that role today. The server
 * component at src/app/admin/layout.tsx redirects non-admins before any
 * HTML ships; the client check below is defense-in-depth during the brief
 * auth-load window. Entered via the global Header "Admin" nav link.
 *
 * No AppLayout here on purpose: the studio is a standalone owner cockpit
 * with its own header (the "Staxis" wordmark links back to the app), so the
 * staff-app chrome (nav, floating chat, voice) would only get in the way.
 */

import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { ShieldAlert } from 'lucide-react';
import { StudioShell } from '@/app/admin/_components/studio/StudioShell';
import { FONT_SERIF } from '@/app/admin/_components/studio/kit';
import '@/app/admin/_components/studio/studio.css';

export default function AdminPropertiesPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <div className="admin-studio" style={{ minHeight: '100vh', background: 'var(--bg)' }}>
        <div style={{ padding: '120px 24px', textAlign: 'center', fontFamily: FONT_SERIF, color: 'var(--ink)' }}>
          {authLoading
            ? <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} />
            : (
              <>
                <ShieldAlert size={32} color="var(--terracotta)" style={{ marginBottom: 12 }} />
                <p style={{ fontSize: 22, fontStyle: 'italic', letterSpacing: '-0.02em' }}>Admin access only.</p>
              </>
            )}
        </div>
      </div>
    );
  }

  return <StudioShell />;
}
