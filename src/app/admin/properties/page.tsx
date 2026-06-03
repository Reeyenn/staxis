'use client';

export const dynamic = 'force-dynamic';

/**
 * /admin/properties — Owner cockpit ("Admin Studio", June 2026 redesign).
 *
 * The dark editorial "Studio" surfaces live INSIDE the normal app shell
 * (AppLayout) — same as every other section of the site — so the global
 * nav (Dashboard · Housekeeping · … · Admin), the notification bell, and the
 * floating assistant all stay on top. Only the admin *content* changed; this
 * is one page of the website, not a standalone app.
 *
 * All visual + interaction work lives in _components/studio/*; this route
 * file is just the app shell + auth gate + the studio mount.
 *
 * Auth: admin role only. The server component at src/app/admin/layout.tsx
 * redirects non-admins before any HTML ships; the client check below is
 * defense-in-depth during the brief auth-load window.
 */

import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { ShieldAlert } from 'lucide-react';
import { StudioShell } from '@/app/admin/_components/studio/StudioShell';
import { FONT_SERIF } from '@/app/admin/_components/studio/kit';
import '@/app/admin/_components/studio/studio.css';

export default function AdminPropertiesPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading || (user && user.role !== 'admin')) {
    return (
      <AppLayout>
        <div className="admin-studio">
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
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <StudioShell />
    </AppLayout>
  );
}
