'use client';


export const dynamic = 'force-dynamic';
import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { isOnboardingInProgress, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import type { Property } from '@/types';
import { LanguageMenu } from '@/components/i18n/LanguageMenu';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { ChevronMark } from '@/components/AuthShell';
import { ArrowRight, BedDouble, Building2, LogOut, UserRound } from 'lucide-react';
import styles from './property-selector.module.css';

function SelectorChrome() {
  return (
    <header className={styles.topbar}>
      <div className={styles.topbarInner}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <ChevronMark size={24} color="var(--snow-mark, #1A1F1B)" />
          </span>
          <span className={styles.brandName}>Staxis</span>
        </div>
        <div className={styles.utilityControls}>
          <LanguageMenu compact />
          <ThemeToggle compact />
        </div>
      </div>
    </header>
  );
}

export default function PropertySelectorPage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { properties, loading: propLoading, setActivePropertyId } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  // Redirect unauthenticated users to sign-in
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/signin');
    }
  }, [user, authLoading, router]);

  // Route into the app — UNLESS this property's onboarding isn't finished,
  // in which case keep the owner in the wizard (a half-onboarded hotel has no
  // PMS and an empty dashboard). The server resolves the resume code. Full
  // navigation (not router.replace) so the API route's 302 is followed.
  const enter = (p: Property) => {
    // Mid-onboarding owner → resume the wizard, but only ONCE: if a prior
    // resume attempt already bounced us back here (guard set), fall through to
    // the dashboard instead of looping forever (see RESUME_GUARD_KEY).
    // Admins are NEVER pulled into onboarding — they manage hotels, they don't
    // own the signup, and routing them in would trap them in (and mutate)
    // someone else's wizard.
    if (
      user?.role !== 'admin' &&
      isOnboardingInProgress(p.onboardingCompletedAt, p.onboardingState) &&
      typeof window !== 'undefined' &&
      !sessionStorage.getItem(RESUME_GUARD_KEY)
    ) {
      sessionStorage.setItem(RESUME_GUARD_KEY, '1');
      window.location.href = `/api/onboard/resume?propertyId=${encodeURIComponent(p.id)}`;
      return;
    }
    setActivePropertyId(p.id);
    sessionStorage.setItem('hotelops-session-selected', '1');
    router.replace('/dashboard');
  };

  // Auto-select when exactly 1 property
  useEffect(() => {
    if (authLoading || propLoading || !user) return;
    if (properties.length === 1) {
      enter(properties[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, propLoading, user, properties]);

  const handleSelect = (id: string) => {
    const p = properties.find(x => x.id === id);
    if (p) enter(p);
  };

  const handleSignOut = async () => {
    sessionStorage.removeItem('hotelops-session-selected');
    sessionStorage.removeItem(RESUME_GUARD_KEY);
    await signOut();
  };

  const isLoading = authLoading || propLoading;

  if (isLoading) {
    return (
      <div className={styles.page}>
        <SelectorChrome />
        <main className={styles.loadingMain}>
          <div className={styles.loadingCard} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            <span>{t('loading', lang)}</span>
          </div>
        </main>
      </div>
    );
  }

  const copy = {
    eyebrow: lang === 'es' ? 'Acceso a propiedades' : 'Property access',
    description: lang === 'es'
      ? 'Elige el hotel que quieres abrir.'
      : 'Choose the hotel you want to open.',
    open: lang === 'es' ? 'Abrir propiedad' : 'Open property',
    available: lang === 'es' ? 'Propiedades disponibles' : 'Available properties',
  };

  return (
    <div className={styles.page}>
      <SelectorChrome />
      <main className={styles.main}>
        <section className={styles.panel} aria-labelledby="property-selector-title">
          <div className={styles.intro}>
            <div>
              <p className={styles.eyebrow}>{copy.eyebrow}</p>
              <h1 className={styles.title} id="property-selector-title">
                {t('selectProperty', lang)}
              </h1>
              <p className={styles.description}>{copy.description}</p>
            </div>
            {user && (
              <div className={styles.accountChip}>
                <UserRound size={16} aria-hidden="true" />
                <span className={styles.accountChipText}>
                  {t('signedInAs', lang)} <strong>{user.username}</strong>
                </span>
              </div>
            )}
          </div>

          {properties.length === 0 ? (
            <div className={styles.emptyState} role="status" aria-live="polite">
              <div className={styles.emptyIcon} aria-hidden="true">
                <Building2 size={28} />
              </div>
              <h2 className={styles.emptyTitle}>{t('noPropertiesFound', lang)}</h2>
              <p className={styles.emptyDescription}>{t('noPropertiesDesc', lang)}</p>
            </div>
          ) : (
            <ul className={styles.propertyGrid} aria-label={copy.available}>
              {properties.map((p, index) => (
                <li className={styles.propertyItem} key={p.id}>
                  <button
                    type="button"
                    className={styles.propertyCard}
                    onClick={() => handleSelect(p.id)}
                    aria-label={`${p.name}. ${p.totalRooms} ${t('rooms', lang)}. ${copy.open}.`}
                    style={{ animationDelay: `${100 + index * 55}ms` }}
                  >
                    <span className={styles.propertyIcon} aria-hidden="true">
                      <Building2 size={22} />
                    </span>
                    <span className={styles.propertyCopy}>
                      <span className={styles.propertyName}>{p.name}</span>
                      <span className={styles.propertyMeta}>
                        <BedDouble size={14} aria-hidden="true" />
                        {p.totalRooms} {t('rooms', lang)}
                      </span>
                    </span>
                    <span className={styles.openCue} aria-hidden="true">
                      <span>{copy.open}</span>
                      <ArrowRight size={18} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <footer className={styles.footer}>
            <button type="button" className={styles.signOut} onClick={handleSignOut}>
              <LogOut size={15} aria-hidden="true" />
              {t('signOut', lang)}
            </button>
          </footer>
        </section>
      </main>
    </div>
  );
}
