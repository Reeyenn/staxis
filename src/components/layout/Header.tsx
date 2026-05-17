'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Globe, Settings, Bell } from 'lucide-react';

// Snow design system — chevron mark from the locked Dashboard
// Explorations design. Drawn in a 64x64 viewBox so the strokes scale
// crisply at any size; markColor stays true black per design lock.
function ChevronMark({ size = 26, color = '#1A1F1B' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M18 28 L26 20 M18 38 L38 18 M28 38 L38 28 M28 48 L46 30"
        stroke={color}
        strokeWidth={4.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function Header() {
  const { user, signOut } = useAuth();
  const { properties, activeProperty, setActivePropertyId } = useProperty();
  const { lang, setLang } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  const baseNavLinks = [
    { href: '/dashboard',    label: lang === 'es' ? 'Panel' : 'Dashboard' },
    { href: '/housekeeping', label: lang === 'es' ? 'Limpieza' : 'Housekeeping' },
    { href: '/maintenance',  label: lang === 'es' ? 'Mantenimiento' : 'Maintenance' },
    { href: '/inventory',    label: lang === 'es' ? 'Inventario' : 'Inventory' },
    { href: '/staff',        label: lang === 'es' ? 'Personal' : 'Staff' },
    { href: '/front-desk',   label: lang === 'es' ? 'Recepción' : 'Front desk' },
  ];

  // ML and Admin tabs are both admin-only. Server-side gates on
  // /api/admin/* and /admin/* pages still enforce this independently.
  const isAdmin = user?.role === 'admin';
  const navLinks = [
    ...baseNavLinks,
    // ML stays "ML" in both locales — it's a proper noun the team uses
    // verbatim. Only "Admin" → "Administración" needs the swap.
    ...(isAdmin ? [{ href: '/admin/ml', label: 'ML' }] : []),
    ...(isAdmin ? [{ href: '/admin/properties', label: lang === 'es' ? 'Admin.' : 'Admin' }] : []),
  ];

  const handleSwitchProperty = (id: string) => {
    setActivePropertyId(id);
    sessionStorage.setItem('hotelops-session-selected', '1');
    setShowUserMenu(false);
  };

  const sansFont = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
  const ink = 'var(--snow-ink)';
  const ink2 = 'var(--snow-ink2)';
  const ink3 = 'var(--snow-ink3)';
  const rule = 'var(--snow-rule)';
  const sage = 'var(--snow-sage)';

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 40,
      background: 'var(--snow-bg)',
      borderBottom: `1px solid ${rule}`,
    }}>
      <div style={{
        maxWidth: '1920px', margin: '0 auto',
        padding: '0 48px', height: '64px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px',
      }}>

        {/* Left: Chevron + Staxis wordmark + property name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
          <ChevronMark size={26} color="var(--snow-mark)" />
          <span style={{
            fontFamily: sansFont, fontSize: '18px', fontWeight: 600,
            color: ink, letterSpacing: '-0.02em',
          }}>
            Staxis
          </span>
          {activeProperty && (
            <>
              <span style={{ width: 1, height: 14, background: rule, marginLeft: 7 }} />
              <span style={{
                fontFamily: sansFont, fontSize: '13px', color: ink2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
              }}>
                {activeProperty.name}
              </span>
            </>
          )}
        </div>

        {/* Center: Nav links */}
        <nav style={{ display: 'flex', gap: '24px' }}>
          {navLinks.map(link => {
            const isActive = pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                style={{
                  fontFamily: sansFont, fontWeight: isActive ? 600 : 400,
                  fontSize: '13px', color: isActive ? ink : ink3,
                  textDecoration: 'none',
                  borderBottom: isActive ? `1.5px solid ${sage}` : 'none',
                  paddingBottom: '2px',
                  transition: 'color 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* Right: controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>

          {/* Notifications bell */}
          <button
            style={{
              padding: '8px', borderRadius: '8px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onClick={() => {}}
            aria-label={lang === 'es' ? 'Notificaciones' : 'Notifications'}
          >
            <Bell size={18} color={ink2} />
          </button>

          {/* Language toggle */}
          <button
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            title={lang === 'en' ? 'Switch to Español' : 'Cambiar a English'}
            aria-label={lang === 'en' ? 'Switch language to Spanish' : 'Switch language to English'}
            style={{
              padding: '6px 10px', borderRadius: '8px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
              fontFamily: sansFont,
              fontWeight: 600, fontSize: '11px', color: ink2,
              letterSpacing: '0.04em',
              transition: 'background 0.15s',
            }}
          >
            <Globe size={16} color={ink2} />
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
            aria-label={lang === 'es' ? 'Configuración' : 'Settings'}
          >
            <Settings size={18} color={ink2} />
          </button>

          {/* User avatar + dropdown */}
          {user && (
            <div style={{ position: 'relative', flexShrink: 0, marginLeft: '4px' }}>
              <button
                onClick={() => setShowUserMenu(v => !v)}
                style={{
                  width: '34px', height: '34px', borderRadius: '50%',
                  border: `1px solid ${rule}`, overflow: 'hidden', cursor: 'pointer',
                  background: 'var(--snow-bg)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: ink, fontWeight: 600, fontSize: '13px', flexShrink: 0,
                  fontFamily: sansFont,
                }}
                aria-label={lang === 'es' ? 'Menú de usuario' : 'User menu'}
              >
                {(user.displayName?.[0] ?? user.username?.[0] ?? 'U').toUpperCase()}
              </button>

              {showUserMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setShowUserMenu(false)} />
                  <div style={{
                    position: 'absolute', right: 0, top: 'calc(100% + 8px)',
                    background: 'var(--snow-bg)', border: `1px solid ${rule}`,
                    borderRadius: '12px', minWidth: '220px',
                    overflow: 'hidden', zIndex: 50,
                    boxShadow: '0 8px 24px rgba(31,35,28,0.08)',
                  }}>
                    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${rule}` }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: ink, fontFamily: sansFont }}>
                        {user.displayName ?? 'User'}
                      </div>
                      <div style={{ fontSize: '11px', color: ink2, marginTop: '2px', fontFamily: sansFont }}>
                        {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
                      </div>
                    </div>

                    {/* Property selector inside dropdown */}
                    {properties.length > 0 && properties.map(p => (
                      <button key={p.id}
                        onClick={() => handleSwitchProperty(p.id)}
                        style={{
                          width: '100%', padding: '10px 16px', textAlign: 'left',
                          background: p.id === activeProperty?.id ? 'rgba(158,183,166,0.12)' : 'transparent',
                          color: p.id === activeProperty?.id ? 'var(--snow-sage-deep)' : ink,
                          fontSize: '13px', fontWeight: p.id === activeProperty?.id ? 600 : 400,
                          cursor: 'pointer', border: 'none',
                          borderBottom: `1px solid var(--snow-rule-soft)`,
                          fontFamily: sansFont,
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
                        borderBottom: `1px solid var(--snow-rule-soft)`,
                        color: ink, fontSize: '13px',
                        cursor: 'pointer', fontFamily: sansFont,
                        textAlign: 'left',
                      }}
                    >
                      <Globe size={14} />
                      {lang === 'en' ? 'Español' : 'English'}
                    </button>

                    <button
                      onClick={() => { void signOut(); setShowUserMenu(false); }}
                      style={{
                        width: '100%', padding: '10px 16px',
                        display: 'flex', alignItems: 'center', gap: '8px',
                        background: 'transparent', border: 'none',
                        color: 'var(--snow-warm)', fontSize: '13px',
                        cursor: 'pointer', fontFamily: sansFont,
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
