'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, LogOut, Globe, LayoutGrid, Settings, Bell } from 'lucide-react';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';

export function Header() {
  const { user, signOut } = useAuth();
  const { properties, activeProperty, setActivePropertyId } = useProperty();
  const { lang, setLang } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const [showPropMenu, setShowPropMenu] = React.useState(false);
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  const baseNavLinks = [
    { href: '/dashboard',    label: lang === 'es' ? 'Panel' : 'Dashboard' },
    { href: '/housekeeping', label: lang === 'es' ? 'Limpieza' : 'Housekeeping' },
    { href: '/maintenance',  label: lang === 'es' ? 'Mantenimiento' : 'Maintenance' },
    { href: '/inventory',    label: lang === 'es' ? 'Inventario' : 'Inventory' },
    { href: '/staff',        label: lang === 'es' ? 'Personal' : 'Staff' },
  ];

  // Owner/admin-only ML tab. AppUser.role is 'admin' | 'owner' | 'staff'
  // (see contexts/AuthContext.tsx). Reeyen has admin/owner; the J-login (his
  // dad) does not. Role-only gate — no ownerId match because Property doesn't
  // expose that column. Cockpit data is currently stubbed; restoring the link
  // so the page is reachable for development + future wiring.
  const isOwner = user?.role === 'owner' || user?.role === 'admin';
  // Admin-only Admin tab — fleet view across all properties for support
  // triage. Reeyen sees this; the J-login (owner role only) does not.
  // The page is gated server-side too via requireAdmin(), so even if the
  // link leaks through a UI bug a non-admin can't load the data.
  const isAdmin = user?.role === 'admin';
  const navLinks = [
    ...baseNavLinks,
    ...(isOwner ? [{ href: '/admin/ml', label: 'ML' }] : []),
    ...(isAdmin ? [{ href: '/admin/properties', label: 'Admin' }] : []),
    ...(isAdmin ? [{ href: '/admin/pms', label: 'PMS' }] : []),
  ];

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
      background: 'rgba(251, 249, 244, 0.85)',
      backdropFilter: 'blur(64px)',
      WebkitBackdropFilter: 'blur(64px)',
      boxShadow: '0 4px 24px -2px rgba(27,28,25,0.04)',
    }}>
      <div style={{
        maxWidth: '1920px', margin: '0 auto',
        padding: '0 32px', height: '64px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
      }}>

        {/* Left: Logo + Nav Links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          {/* Logo */}
          <span style={{
            fontFamily: 'var(--font-sans)', fontWeight: 600,
            fontSize: '20px', color: '#364262', letterSpacing: '-0.02em',
          }}>
            Staxis
          </span>

          {/* Nav Links */}
          <nav style={{ display: 'flex', gap: '24px' }}>
            {navLinks.map(link => {
              const isActive = pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  style={{
                    fontFamily: 'var(--font-sans)', fontWeight: 500,
                    fontSize: '18px', letterSpacing: '-0.01em',
                    color: isActive ? '#364262' : '#454652',
                    textDecoration: 'none',
                    borderBottom: isActive ? '2px solid #364262' : '2px solid transparent',
                    paddingBottom: '4px',
                    transition: 'color 0.15s ease',
                  }}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0 }}>

          {/* Notifications bell */}
          <button
            style={{
              padding: '8px', borderRadius: '8px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onClick={() => {}}
          >
            <Bell size={20} color="#364262" />
          </button>

          {/* Language toggle (standalone, visible at all times) */}
          <button
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            title={lang === 'en' ? 'Switch to Español' : 'Cambiar a English'}
            aria-label={lang === 'en' ? 'Switch language to Spanish' : 'Switch language to English'}
            style={{
              padding: '8px 10px', borderRadius: '8px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
              fontFamily: 'var(--font-sans)',
              fontWeight: 600, fontSize: '12px', color: '#364262',
              letterSpacing: '0.04em',
              transition: 'background 0.15s',
            }}
          >
            <Globe size={18} color="#364262" />
            {lang === 'en' ? 'EN' : 'ES'}
          </button>

          {/* Settings gear */}
          <button
            onClick={() => router.push('/settings')}
            style={{
              padding: '8px', borderRadius: '8px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
          >
            <Settings size={20} color="#364262" />
          </button>

          {/* User avatar */}
          {user && (
            <div style={{ position: 'relative', flexShrink: 0, marginLeft: '8px' }}>
              <button
                onClick={() => setShowUserMenu(v => !v)}
                style={{
                  width: '40px', height: '40px', borderRadius: '50%',
                  border: 'none', overflow: 'hidden', cursor: 'pointer',
                  background: '#eae8e3',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#364262', fontWeight: 600, fontSize: '16px', flexShrink: 0,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {(user.displayName?.[0] ?? user.username?.[0] ?? 'U').toUpperCase()}
              </button>

              {showUserMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setShowUserMenu(false)} />
                  <div style={{
                    position: 'absolute', right: 0, top: 'calc(100% + 8px)',
                    background: '#ffffff', border: '1px solid rgba(78,90,122,0.12)',
                    borderRadius: '12px', minWidth: '200px',
                    overflow: 'hidden', zIndex: 50,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                  }}>
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(78,90,122,0.08)' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>
                        {user.displayName ?? 'User'}
                      </div>
                      <div style={{ fontSize: '12px', color: '#454652', marginTop: '2px' }}>
                        {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
                      </div>
                    </div>

                    {/* Property selector inside dropdown */}
                    {properties.length > 0 && properties.map(p => (
                      <button key={p.id}
                        onClick={() => handleSwitchProperty(p.id)}
                        style={{
                          width: '100%', padding: '10px 16px', textAlign: 'left',
                          background: p.id === activeProperty?.id ? 'rgba(0,101,101,0.06)' : 'transparent',
                          color: p.id === activeProperty?.id ? '#004b4b' : '#1b1c19',
                          fontSize: '13px', fontWeight: p.id === activeProperty?.id ? 600 : 400,
                          cursor: 'pointer', border: 'none',
                          borderBottom: '1px solid rgba(78,90,122,0.06)',
                          fontFamily: 'var(--font-sans)',
                        }}
                      >
                        {p.name}
                      </button>
                    ))}

                    {/* Language toggle */}
                    <button
                      onClick={() => { setLang(lang === 'en' ? 'es' : 'en'); setShowUserMenu(false); }}
                      style={{
                        width: '100%', padding: '10px 16px',
                        display: 'flex', alignItems: 'center', gap: '8px',
                        background: 'transparent', border: 'none',
                        borderBottom: '1px solid rgba(78,90,122,0.06)',
                        color: '#1b1c19', fontSize: '13px',
                        cursor: 'pointer', fontFamily: 'var(--font-sans)',
                        textAlign: 'left',
                      }}
                    >
                      <Globe size={14} />
                      {lang === 'en' ? 'Español' : 'English'}
                    </button>

                    <button
                      onClick={() => { signOut(); setShowUserMenu(false); }}
                      style={{
                        width: '100%', padding: '10px 16px',
                        display: 'flex', alignItems: 'center', gap: '8px',
                        background: 'transparent', border: 'none',
                        color: '#ba1a1a', fontSize: '13px',
                        cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <LogOut size={14} />
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
