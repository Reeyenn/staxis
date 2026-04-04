'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { Building2, LogOut } from 'lucide-react';

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

  // Auto-select when exactly 1 property
  useEffect(() => {
    if (authLoading || propLoading || !user) return;
    if (properties.length === 1) {
      setActivePropertyId(properties[0].id);
      sessionStorage.setItem('hotelops-session-selected', '1');
      router.replace('/dashboard');
    }
  }, [authLoading, propLoading, user, properties, setActivePropertyId, router]);

  const handleSelect = (id: string) => {
    setActivePropertyId(id);
    sessionStorage.setItem('hotelops-session-selected', '1');
    router.replace('/dashboard');
  };

  const handleSignOut = async () => {
    sessionStorage.removeItem('hotelops-session-selected');
    await signOut();
  };

  const isLoading = authLoading || propLoading;

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)',
      }}>
        <div style={{
          width: '40px', height: '40px',
          border: '3px solid rgba(37,99,235,0.15)',
          borderTopColor: 'var(--navy-light)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>

        {/* Header */}
        <div style={{ marginBottom: '40px', textAlign: 'center' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '12px',
            background: 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '24px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '8px',
          }}>
            {t('selectProperty', lang)}
          </h1>
          {user && (
            <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              {t('signedInAs', lang)} {user.username}
            </p>
          )}
        </div>

        {/* Property list or empty state */}
        {properties.length === 0 ? (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '40px 24px',
            textAlign: 'center',
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
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {properties.map(p => (
              <button
                key={p.id}
                onClick={() => handleSelect(p.id)}
                style={{
                  width: '100%',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '18px 20px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px',
                  textAlign: 'left',
                  transition: 'border-color 150ms, background 150ms',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(37,99,235,0.25)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(37,99,235,0.04)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card)';
                }}
              >
                <div style={{
                  width: '40px', height: '40px', borderRadius: '10px',
                  background: 'rgba(27,58,92,0.06)',
                  border: '1px solid rgba(27,58,92,0.12)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Building2 size={18} color="var(--navy)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '15px', fontWeight: 600,
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-sans)',
                    marginBottom: '2px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {p.totalRooms} {t('rooms', lang)}
                  </div>
                </div>
                <div style={{
                  fontSize: '18px', color: 'var(--text-muted)', fontWeight: 300, flexShrink: 0,
                }}>
                  →
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Sign out */}
        <div style={{ marginTop: '32px', textAlign: 'center' }}>
          <button
            onClick={handleSignOut}
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
        </div>

      </div>
    </div>
  );
}
