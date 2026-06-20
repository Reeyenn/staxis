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
import { Building2, LogOut } from 'lucide-react';
import AuthShell, { AuthPanel } from '@/components/AuthShell';

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
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#F2EFE8',
      }}>
        <div className="spinner" style={{ width: '36px', height: '36px', borderTopColor: '#C99644', borderColor: 'rgba(201,150,68,0.25)' }} />
      </div>
    );
  }

  return (
    <AuthShell
      maxWidth={460}
      subtitle={
        <>
          {t('selectProperty', lang)}
          {user && (
            <>
              <br />
              <span style={{ color: '#8A8F88' }}>{t('signedInAs', lang)} {user.username}</span>
            </>
          )}
        </>
      }
    >
      {/* Property list or empty state */}
      {properties.length === 0 ? (
        <AuthPanel>
          <Building2 size={32} color="#C99644" style={{ margin: '0 auto 16px' }} />
          <p style={{ fontSize: 15, fontWeight: 600, color: '#1F231C', marginBottom: 8 }}>
            {t('noPropertiesFound', lang)}
          </p>
          <p style={{ fontSize: 13, color: '#5C625C', lineHeight: 1.5 }}>
            {t('noPropertiesDesc', lang)}
          </p>
        </AuthPanel>
      ) : (
        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {properties.map(p => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.6)',
                border: '1px solid rgba(31,35,28,0.1)',
                borderRadius: 14,
                padding: '16px 18px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                textAlign: 'left',
                transition: 'border-color 150ms, background 150ms, box-shadow 150ms',
              }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.borderColor = '#C99644';
                el.style.background = '#fff';
                el.style.boxShadow = '0 8px 22px -12px rgba(201,150,68,0.55)';
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.borderColor = 'rgba(31,35,28,0.1)';
                el.style.background = 'rgba(255,255,255,0.6)';
                el.style.boxShadow = 'none';
              }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: 11,
                background: 'rgba(201,150,68,0.12)',
                border: '1px solid rgba(201,150,68,0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Building2 size={18} color="#C99644" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 15, fontWeight: 600, color: '#1F231C',
                  marginBottom: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 12, color: '#5C625C' }}>
                  {p.totalRooms} {t('rooms', lang)}
                </div>
              </div>
              <div style={{ fontSize: 18, color: '#C99644', flexShrink: 0 }}>→</div>
            </button>
          ))}
        </div>
      )}

      {/* Sign out */}
      <div style={{ marginTop: 28, textAlign: 'center' }}>
        <button
          onClick={handleSignOut}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'transparent', border: 'none',
            color: '#5C625C', fontSize: 13,
            cursor: 'pointer', fontFamily: 'inherit',
            padding: '8px 12px',
          }}
        >
          <LogOut size={13} />
          {t('signOut', lang)}
        </button>
      </div>
    </AuthShell>
  );
}
