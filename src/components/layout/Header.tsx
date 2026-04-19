'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { ChevronDown, LogOut, Globe, LayoutGrid } from 'lucide-react';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';

export function Header() {
  const { user, signOut } = useAuth();
  const { properties, activeProperty, setActivePropertyId } = useProperty();
  const { lang, setLang } = useLang();
  const router = useRouter();
  const [showPropMenu, setShowPropMenu] = React.useState(false);
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  const handleSwitchProperty = (id: string) => {
    setActivePropertyId(id);
    sessionStorage.setItem('hotelops-session-selected', '1');
    setShowPropMenu(false);
  };

  const handleGoToSelector = () => {
    sessionStorage.removeItem('hotelops-session-selected');
    setShowPropMenu(false);
    router.push('/property-selector');
  };

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 40,
      background: 'rgba(255, 255, 255, 0.92)',
      backdropFilter: 'blur(16px) saturate(180%)',
      WebkitBackdropFilter: 'blur(16px) saturate(180%)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        maxWidth: '1280px', margin: '0 auto',
        padding: '0 20px', height: '52px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <div style={{
            width: '28px', height: '28px', borderRadius: '7px',
            background: 'var(--navy-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
          </div>
          <span style={{
            fontFamily: 'var(--font-sans)', fontWeight: 600,
            fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '-0.01em',
          }}>
            Staxis
          </span>
        </div>

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>

          {/* Date */}
          <span className="header-date" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', marginRight: '4px' }}>
            {format(new Date(), 'EEEE, MMMM d', lang === 'es' ? { locale: esLocale } : undefined)}
          </span>

          {/* Language toggle - prominent for housekeeper adoption */}
          <button
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              background: lang === 'es' ? 'rgba(212,144,64,0.12)' : 'transparent',
              border: `1px solid ${lang === 'es' ? 'var(--amber-border)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-sm)', padding: '5px 10px',
              color: lang === 'es' ? 'var(--amber)' : 'var(--text-muted)',
              fontSize: '12px', fontWeight: 700,
              letterSpacing: '0.04em', cursor: 'pointer', fontFamily: 'var(--font-sans)',
              transition: 'all 150ms',
            }}
          >
            <Globe size={11} />
            {lang === 'en' ? 'ES' : 'EN'}
          </button>

          {/* Property selector */}
          {properties.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                className="header-property-btn"
                onClick={() => setShowPropMenu(v => !v)}
                style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', padding: '5px 12px',
                  color: 'var(--text-primary)', fontSize: '13px', fontWeight: 500,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                  maxWidth: '200px', fontFamily: 'var(--font-sans)', flexShrink: 1, minWidth: 0,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeProperty?.name ?? t('property', lang)}
                </span>
                <ChevronDown size={11} color="var(--text-muted)" />
              </button>

              {showPropMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setShowPropMenu(false)} />
                  <div style={{
                    position: 'absolute', right: 0, top: 'calc(100% + 4px)',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border-bright)',
                    borderRadius: 'var(--radius-lg)', minWidth: '200px',
                    overflow: 'hidden', zIndex: 50,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                  }}>
                    {properties.map(p => (
                      <button key={p.id}
                        onClick={() => handleSwitchProperty(p.id)}
                        style={{
                          width: '100%', padding: '10px 14px', textAlign: 'left',
                          background: p.id === activeProperty?.id ? 'var(--amber-dim)' : 'transparent',
                          color: p.id === activeProperty?.id ? 'var(--amber)' : 'var(--text-primary)',
                          fontSize: '13px', fontWeight: p.id === activeProperty?.id ? 600 : 400,
                          cursor: 'pointer', border: 'none',
                          borderBottom: '1px solid var(--border)',
                          fontFamily: 'var(--font-sans)',
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                    {properties.length > 1 && (
                      <button
                        onClick={handleGoToSelector}
                        style={{
                          width: '100%', padding: '10px 14px', textAlign: 'left',
                          background: 'transparent', border: 'none',
                          color: 'var(--text-muted)', fontSize: '12px',
                          cursor: 'pointer', fontFamily: 'var(--font-sans)',
                          display: 'flex', alignItems: 'center', gap: '6px',
                        }}
                      >
                        <LayoutGrid size={11} />
                        {t('allProperties', lang)}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* User avatar */}
          {user && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setShowUserMenu(v => !v)}
                style={{
                  width: '30px', height: '30px', borderRadius: '50%',
                  border: '1px solid var(--border)',
                  overflow: 'hidden', cursor: 'pointer',
                  background: 'var(--bg-elevated)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '12px', flexShrink: 0,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {(user.displayName?.[0] ?? user.username?.[0] ?? 'U').toUpperCase()}
              </button>

              {showUserMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setShowUserMenu(false)} />
                  <div style={{
                    position: 'absolute', right: 0, top: 'calc(100% + 4px)',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border-bright)',
                    borderRadius: 'var(--radius-lg)', minWidth: '180px',
                    overflow: 'hidden', zIndex: 50,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                  }}>
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {user.displayName ?? 'User'}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => { signOut(); setShowUserMenu(false); }}
                      style={{
                        width: '100%', padding: '10px 14px',
                        display: 'flex', alignItems: 'center', gap: '8px',
                        background: 'transparent', border: 'none',
                        color: 'var(--red)', fontSize: '13px',
                        cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <LogOut size={13} />
                      {t('signOut', lang)}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
