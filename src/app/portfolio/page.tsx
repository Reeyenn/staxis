'use client';

/**
 * /portfolio — cross-property landing for owners with access to 2+
 * hotels. Single-property users never land here (post-login routes
 * them to /dashboard); if a single-property user navigates here
 * directly, we bounce them back to /dashboard so they don't see an
 * empty "grid of 1" screen.
 *
 * Layout:
 *   • Header (global, shared)
 *   • PortfolioSummaryBanner — totals + anomaly chip
 *   • AnomalyList — plain-English problem rows
 *   • Property grid — one PropertyTile per property
 */

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { usePortfolio } from '@/contexts/PortfolioContext';
import { Header } from '@/components/layout/Header';
import { PropertyTile } from './_components/PropertyTile';
import { PortfolioSummaryBanner } from './_components/PortfolioSummaryBanner';
import { AnomalyList } from './_components/AnomalyList';
import { fetchWithAuth } from '@/lib/api-fetch';
import type {
  PortfolioTileData,
  PortfolioAnomaly,
  PortfolioModuleAverages,
  PortfolioSummary,
} from '@/lib/portfolio/types';

type SnapshotPayload = {
  tiles: PortfolioTileData[];
  averages: PortfolioModuleAverages[];
  anomalies: PortfolioAnomaly[];
  summary: PortfolioSummary;
};

const sansFont = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";

export default function PortfolioPage() {
  const { user, loading: authLoading } = useAuth();
  const { lang } = useLang();
  const { isMultiProperty, switchToProperty } = usePortfolio();
  const router = useRouter();

  const [snapshot, setSnapshot] = useState<SnapshotPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auth bounce: signed-out users go to /signin; single-property users
  // go to /dashboard (no grid of 1). The bounce lives in an effect so
  // it runs after AuthContext finishes loading.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/signin');
      return;
    }
    // We only bounce single-property users away AFTER PortfolioContext
    // has loaded properties. PortfolioContext reads from PropertyContext
    // which has its own loading state — but `isMultiProperty` is false
    // both while loading AND when truly single-property. To avoid
    // bouncing during the brief loading window, we check the snapshot
    // separately below.
  }, [user, authLoading, router]);

  const loadSnapshot = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithAuth('/api/portfolio/housekeeping-tiles');
      const body = await res.json().catch(() => null) as { ok?: boolean; data?: SnapshotPayload; error?: string } | null;
      if (!res.ok || !body?.ok || !body.data) {
        setError(body?.error ?? `Request failed (${res.status})`);
        setSnapshot(null);
      } else {
        setSnapshot(body.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load portfolio');
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    void loadSnapshot();
  }, [authLoading, user, loadSnapshot]);

  // Bounce single-property users AFTER we know their property count.
  // EXACT-1 only — distinct.size === 0 means the user has no properties
  // (handled by the EmptyState below), and bouncing them to /dashboard
  // would either land them on an unconfigured dashboard or kick off a
  // /dashboard→/onboarding chain. Showing the empty-state card is
  // more honest. We also require !isMultiProperty so a property that
  // had no data (no tile) doesn't make a 2-property user look "single".
  useEffect(() => {
    if (loading || !snapshot) return;
    const distinct = new Set(snapshot.tiles.map(t => t.propertyId));
    if (distinct.size === 1 && !isMultiProperty) {
      router.replace('/dashboard');
    }
  }, [loading, snapshot, isMultiProperty, router]);

  if (authLoading || loading) {
    return (
      <PageShell>
        <LoadingState lang={lang} />
      </PageShell>
    );
  }

  if (error) {
    return (
      <PageShell>
        <ErrorState message={error} onRetry={() => { setLoading(true); void loadSnapshot(); }} lang={lang} />
      </PageShell>
    );
  }

  if (!snapshot || snapshot.tiles.length === 0) {
    return (
      <PageShell>
        <EmptyState lang={lang} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PortfolioSummaryBanner summary={snapshot.summary} />
      <AnomalyList anomalies={snapshot.anomalies} />
      <div style={{
        padding: 'clamp(16px, 3vw, 32px) clamp(16px, 3vw, 48px)',
        display: 'grid',
        gap: '16px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
      }}>
        {snapshot.tiles.map(tile => {
          const isAnomaly = snapshot.anomalies.some(a => a.propertyId === tile.propertyId);
          return (
            <PropertyTile
              key={`${tile.propertyId}:${tile.module}`}
              data={tile}
              isAnomaly={isAnomaly}
              onClick={() => switchToProperty(tile.propertyId, '/housekeeping')}
            />
          );
        })}
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--snow-bg)' }}>
      <Header />
      {children}
    </div>
  );
}

function LoadingState({ lang }: { lang: 'en' | 'es' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '80px 0',
      fontFamily: sansFont, color: 'var(--snow-ink2)',
    }}>
      <div className="spinner" style={{ width: '24px', height: '24px', marginRight: '12px' }} />
      {lang === 'es' ? 'Cargando portafolio…' : 'Loading portfolio…'}
    </div>
  );
}

function ErrorState({ message, onRetry, lang }: { message: string; onRetry: () => void; lang: 'en' | 'es' }) {
  return (
    <div style={{
      margin: '40px auto', maxWidth: '480px',
      padding: '24px',
      background: 'var(--snow-bg)',
      border: '1px solid var(--snow-rule)', borderRadius: '12px',
      fontFamily: sansFont, textAlign: 'center',
    }}>
      <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--snow-ink)', margin: '0 0 8px' }}>
        {lang === 'es' ? 'No se pudo cargar' : 'Something went wrong'}
      </h2>
      <p style={{ fontSize: '13px', color: 'var(--snow-ink2)', margin: '0 0 16px' }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          padding: '8px 16px', borderRadius: '8px',
          border: '1px solid var(--snow-rule)', background: 'var(--snow-bg)',
          fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
          color: 'var(--snow-ink)', cursor: 'pointer',
        }}
      >
        {lang === 'es' ? 'Reintentar' : 'Retry'}
      </button>
    </div>
  );
}

function EmptyState({ lang }: { lang: 'en' | 'es' }) {
  return (
    <div style={{
      margin: '40px auto', maxWidth: '480px',
      padding: '32px 24px', textAlign: 'center',
      fontFamily: sansFont, color: 'var(--snow-ink2)',
    }}>
      <h2 style={{ fontSize: '17px', fontWeight: 600, color: 'var(--snow-ink)', margin: '0 0 8px' }}>
        {lang === 'es' ? 'No hay propiedades' : 'No properties yet'}
      </h2>
      <p style={{ fontSize: '13px', lineHeight: 1.5, margin: 0 }}>
        {lang === 'es'
          ? 'Agrega una propiedad para empezar a ver el portafolio.'
          : 'Add a property to start seeing the portfolio view.'}
      </p>
    </div>
  );
}
