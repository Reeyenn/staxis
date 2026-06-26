'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { useCan } from '@/lib/capabilities/useCan';
import { APP_KEY_BY_HREF } from '@/lib/app-usage/registry';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Globe, Settings, ChevronDown } from 'lucide-react';
import { LanguageMenu } from '@/components/i18n/LanguageMenu';

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
  const { properties, activeProperty, setActivePropertyId, appUsage } = useProperty();
  const can = useCan();
  const { lang, setLang } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const [showUserMenu, setShowUserMenu] = React.useState(false);
  const [showNavMenu, setShowNavMenu] = React.useState(false);

  const baseNavLinks = [
    { href: '/feed',         label: 'Staxis' },
    { href: '/dashboard',    label: lang === 'es' ? 'Panel' : 'Dashboard' },
    { href: '/housekeeping', label: lang === 'es' ? 'Limpieza' : 'Housekeeping' },
    { href: '/communications', label: lang === 'es' ? 'Comunicación' : 'Communications' },
    { href: '/maintenance',  label: lang === 'es' ? 'Mantenimiento' : 'Maintenance' },
    { href: '/inventory',    label: lang === 'es' ? 'Inventario' : 'Inventory' },
    { href: '/staff',        label: lang === 'es' ? 'Personal' : 'Staff' },
  ];

  // Admin tab is admin-only. ML now lives inside the Admin cockpit as a
  // sub-tab — the top nav doesn't need a separate ML link.
  // Server-side gates on /api/admin/* and /admin/* pages still enforce
  // admin-only access independently.
  const isAdmin = user?.role === 'admin';
  // Financials is owner/GM/admin only (sensitive). The /financials page +
  // every /api/financials/* route enforce the same gate server-side.
  const showFinancials = !!user && can('view_financials');
  const navLinks = [
    ...baseNavLinks,
    ...(showFinancials ? [{ href: '/financials', label: lang === 'es' ? 'Finanzas' : 'Financials' }] : []),
  ];
  // "Staxis" (the decision feed) stays as the one visible tab; the other
  // pages collapse into a single dropdown to its right. Admin (owner-only)
  // sits as its own tab on the far right, outside the dropdown.
  const restLinks = navLinks.filter(l => l.href !== '/feed');
  const adminLink = isAdmin ? { href: '/admin/properties', label: lang === 'es' ? 'Admin.' : 'Admin' } : null;

  // Auto-light the nav: every app always shows, but the ones the hotel is
  // actually USING (real activity — see /api/app-usage) stay full-strength with
  // a small "live" dot, while not-yet-used apps go greyed and sink toward the
  // end. Dashboard is pinned first and Admin last; both are always "in use".
  // An app is greyed ONLY when its usage is an explicit `false`, so while the
  // map is loading (or a fetch failed → {}) nothing greys or reorders — no flash.
  // The page you're currently on is never greyed or sunk (so you can open an
  // unused app and start using it).
  const decoratedLinks = navLinks.map((link, i) => {
    const appKey = APP_KEY_BY_HREF[link.href];
    const isApp = !!appKey;
    const isActive = pathname.startsWith(link.href);
    const used = (appKey ? appUsage[appKey] !== false : true) || isActive;
    return {
      link,
      isApp,
      isActive,
      used,
      pinFirst: link.href === '/dashboard',
      pinLast: link.href.startsWith('/admin'),
      i,
    };
  });
  const orderedLinks = [...decoratedLinks].sort((a, b) => {
    if (a.pinFirst !== b.pinFirst) return a.pinFirst ? -1 : 1;
    if (a.pinLast !== b.pinLast) return a.pinLast ? 1 : -1;
    if (a.used !== b.used) return a.used ? -1 : 1;
    return a.i - b.i;
  });

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
        padding: '0 clamp(16px, 3vw, 48px)', height: '64px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px',
      }}>

        {/* Left: Chevron + Staxis wordmark + property name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, flexShrink: 1 }}>
          {/* Logo: chevron + wordmark — never shrinks */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0 }}>
            <ChevronMark size={26} color="var(--snow-mark)" />
            <span style={{
              fontFamily: sansFont, fontSize: '18px', fontWeight: 600,
              color: ink, letterSpacing: '-0.02em', whiteSpace: 'nowrap',
            }}>
              Staxis
            </span>
          </div>
          {activeProperty && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, marginLeft: '7px' }}>
              <span style={{ width: 1, height: 14, background: rule, flexShrink: 0 }} />
              <span style={{
                fontFamily: sansFont, fontSize: '13px', color: ink2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
              }}>
                {activeProperty.name}
              </span>
            </div>
          )}
        </div>

        {/* Center: Staxis tab + a dropdown holding every other page */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: '20px', minWidth: 0 }} className="header-nav-scroll">
          {/* Staxis (the decision feed) — always visible */}
          <Link
            href="/feed"
            style={{
              fontFamily: sansFont, fontWeight: pathname.startsWith('/feed') ? 600 : 400,
              fontSize: '13px', color: pathname.startsWith('/feed') ? ink : ink3,
              textDecoration: 'none',
              borderBottom: pathname.startsWith('/feed') ? `1.5px solid ${sage}` : 'none',
              paddingBottom: '2px', transition: 'color 0.15s ease', whiteSpace: 'nowrap',
            }}
          >
            Staxis
          </Link>

          {/* Everything else, collapsed into one dropdown */}
          <div style={{ position: 'relative' }}>
            {(() => {
              const activeRest = restLinks.find(l => pathname.startsWith(l.href));
              // Label the dropdown with the section you're actually on. When
              // you're NOT on a section page (Settings, the Staxis feed, an
              // Admin sub-page), show a neutral "Menu" instead of impersonating
              // the last-visited section — that made the menu read as
              // "Housekeeping" while you were really sitting on Settings.
              const displayLabel = activeRest?.label ?? (lang === 'es' ? 'Menú' : 'Menu');
              return (
                <button
                  onClick={() => setShowNavMenu(v => !v)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                    fontFamily: sansFont, fontWeight: activeRest ? 600 : 400, fontSize: '13px',
                    color: activeRest ? ink : ink3,
                    borderBottom: activeRest ? `1.5px solid ${sage}` : 'none',
                    paddingBottom: '2px', whiteSpace: 'nowrap',
                  }}
                  aria-label={lang === 'es' ? 'Menú' : 'Menu'}
                >
                  {displayLabel}
                  <ChevronDown
                    size={14}
                    color={activeRest ? ink : ink3}
                    style={{ transition: 'transform 0.2s ease', transform: showNavMenu ? 'rotate(180deg)' : 'none' }}
                  />
                </button>
              );
            })()}

            {showNavMenu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setShowNavMenu(false)} />
                <div style={{
                  position: 'absolute', left: 0, top: 'calc(100% + 10px)',
                  background: 'var(--snow-bg)', border: `1px solid ${rule}`,
                  borderRadius: '12px', minWidth: '210px', overflow: 'hidden', zIndex: 50,
                  boxShadow: '0 8px 24px rgba(31,35,28,0.08)',
                }}>
                  {/* Items ordered + greyed by real app usage (carried over from
                      the auto-lighting nav): in-use apps first with a sage live
                      dot, not-yet-used apps greyed and sunk to the bottom. */}
                  {orderedLinks.filter(o => o.link.href !== '/feed').map(({ link, isApp, isActive, used }) => {
                    const greyed = isApp && !used;
                    const showDot = isApp && used;
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setShowNavMenu(false)}
                        title={greyed
                          ? (lang === 'es' ? 'Aún no se usa — ábrelo para empezar' : 'Not in use yet — open it to get started')
                          : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '7px',
                          padding: '10px 16px',
                          fontFamily: sansFont, fontSize: '13px',
                          fontWeight: isActive ? 600 : 400,
                          color: isActive ? 'var(--snow-sage-deep)' : ink,
                          opacity: greyed ? 0.55 : 1,
                          background: isActive ? 'rgba(158,183,166,0.12)' : 'transparent',
                          textDecoration: 'none',
                          borderBottom: '1px solid var(--snow-rule-soft)',
                        }}
                      >
                        {showDot && (
                          <span aria-hidden="true" style={{
                            width: 5, height: 5, borderRadius: '50%',
                            background: sage, flexShrink: 0,
                          }} />
                        )}
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Admin — owner-only, its own tab on the far right of the dropdown */}
          {adminLink && (
            <Link
              href={adminLink.href}
              style={{
                fontFamily: sansFont, fontWeight: pathname.startsWith('/admin') ? 600 : 400,
                fontSize: '13px', color: pathname.startsWith('/admin') ? ink : ink3,
                textDecoration: 'none',
                borderBottom: pathname.startsWith('/admin') ? `1.5px solid ${sage}` : 'none',
                paddingBottom: '2px', transition: 'color 0.15s ease', whiteSpace: 'nowrap',
              }}
            >
              {adminLink.label}
            </Link>
          )}
        </nav>

        {/* Right: controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>

          {/* Language menu — app-wide 5-language switcher */}
          <LanguageMenu compact />

          {/* Settings gear — highlights when you're actually on Settings */}
          <button
            onClick={() => router.push('/settings')}
            style={{
              padding: '8px', borderRadius: '8px', border: 'none',
              background: pathname.startsWith('/settings') ? 'rgba(158,183,166,0.16)' : 'transparent',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            aria-label={lang === 'es' ? 'Configuración' : 'Settings'}
            aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
          >
            <Settings size={18} color={pathname.startsWith('/settings') ? ink : ink2} />
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
