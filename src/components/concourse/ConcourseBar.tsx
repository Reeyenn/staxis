'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ConcourseBar — the connected pill bar (replaces Header in AppLayout).
//
// Wires ConcourseBarView to the real app: section pills from the section
// registry (filtered by the per-hotel toggles + the financials capability
// gate, exactly like the old Header), logo → /home hub, gear → /settings,
// and an avatar dropdown that keeps
// everything the old header offered: who you are, hotel switching, the full
// 5-language list, Admin (owners), and sign out.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t, LOCALE_META, SUPPORTED_LOCALES } from '@/lib/translations';
import { useCan } from '@/lib/capabilities/useCan';
import { useEnabledSections } from '@/lib/sections/useSectionEnabled';
import { SECTION_LIST } from '@/lib/sections/registry';
import { ConcourseBarView, type BarItem } from './ConcourseBarView';
import { SAMPLE_DECISIONS, QUEUE_COUNT_EVENT } from './sample-decisions';
import { PhoneHandoffDialog } from '@/components/phone-handoff/PhoneHandoffDialog';
import { InstallStaxisDialog } from '@/components/pwa/InstallStaxisDialog';
import { useInstallStaxis } from '@/contexts/InstallStaxisContext';
import { shouldShowMobileInstallReminder } from '@/lib/pwa-install';
import { Download, Smartphone } from 'lucide-react';
import { roleLabel } from '@/lib/roles';
import { MobileConcourseNav } from './MobileConcourseNav';

// Session-wide guard: the bar remounts on every route (each page renders its
// own AppLayout), and an unguarded prefetch effect re-fired the whole batch
// on every mount/re-render — ~25 concurrent server renders racing the page's
// own data load. Prefetch must run ONCE per browser session, on idle.
let PREFETCHED_THIS_SESSION = false;

export function ConcourseBar() {
  const { user, signOut } = useAuth();
  const { properties, activeProperty, loading: propertyLoading, setActivePropertyId } = useProperty();
  const can = useCan();
  const { lang, locale, setLocale } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const enabled = useEnabledSections();
  const { platform, installed } = useInstallStaxis();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [phoneHandoffOpen, setPhoneHandoffOpen] = React.useState(false);
  const [installStaxisOpen, setInstallStaxisOpen] = React.useState(false);
  // The bar wrap is a horizontal scroll container (mobile), which clips
  // anything hanging below it — so the menu is portaled to <body> at a
  // fixed position measured from the avatar button. The bar is sticky, so
  // the measured rect stays put while the menu is open.
  const avatarWrapRef = React.useRef<HTMLDivElement | null>(null);
  const avatarButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const installReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = React.useState<{ top: number; right: number } | null>(null);
  const toggleMenu = () => {
    const r = avatarWrapRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 10, right: Math.max(8, window.innerWidth - r.right) });
    setMenuOpen((v) => !v);
  };

  // Navigation feel: (1) prefetch every section's route payload once per
  // session, 2.5s after the bar settles — warm pill clicks WITHOUT racing the
  // current page's own data load; (2) light the clicked pill green immediately
  // (optimistic active) instead of waiting for the new pathname to arrive.
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  React.useEffect(() => { setPendingHref(null); }, [pathname]);
  const roleRef = React.useRef(user?.role);
  roleRef.current = user?.role ?? roleRef.current;
  React.useEffect(() => {
    if (PREFETCHED_THIS_SESSION) return;
    const idle = window.setTimeout(() => {
      PREFETCHED_THIS_SESSION = true;
      const hrefs = [...SECTION_LIST.map((m) => m.navHref), '/home', '/settings'];
      if (roleRef.current === 'admin') hrefs.push('/admin/properties');
      hrefs.forEach((h) => router.prefetch(h));
    }, 2500);
    return () => window.clearTimeout(idle);
  }, [router]);
  const go = (href: string) => { setPendingHref(href); router.push(href); };

  // Pending-decision badge on the Staxis pill. Seeded from the sample queue
  // (same Phase-1 footing as the queue page) and kept in sync while the user
  // approves/dismisses on /feed via the queue's broadcast event.
  const [pendingCount, setPendingCount] = React.useState(SAMPLE_DECISIONS.length);
  React.useEffect(() => {
    const h = (e: Event) => {
      const n = (e as CustomEvent).detail?.pending;
      if (typeof n === 'number') setPendingCount(n);
    };
    window.addEventListener(QUEUE_COUNT_EVENT, h);
    return () => window.removeEventListener(QUEUE_COUNT_EVENT, h);
  }, []);

  // Same visibility rules as the old Header: per-hotel section toggles hide
  // pills entirely; Financials additionally needs the view_financials
  // capability (server routes enforce the same gate independently).
  const items: BarItem[] = (propertyLoading ? [] : SECTION_LIST)
    .filter((m) => {
      if (!enabled[m.key]) return false;
      if (m.key === 'financials') return !!user && can('view_financials');
      return true;
    })
    .map((m) => ({
      key: m.key,
      label: lang === 'es' ? m.label_es : m.label_en,
      active: pendingHref
        ? pendingHref === m.navHref
        : pathname === m.navHref || pathname.startsWith(m.navHref + '/'),
      badge: m.key === 'staxis' ? pendingCount : undefined,
      onClick: () => go(m.navHref),
    }));

  // Admin is owner-only and not a per-hotel section — its own pill, far side.
  if (user?.role === 'admin') {
    items.push({
      key: 'admin',
      label: lang === 'es' ? 'Admin.' : 'Admin',
      active: pendingHref ? pendingHref === '/admin/properties' : pathname.startsWith('/admin'),
      onClick: () => go('/admin/properties'),
    });
  }

  const initial = (user?.displayName?.[0] ?? user?.username?.[0] ?? 'U').toUpperCase();
  const spanishRoleLabels: Record<string, string> = {
    admin: 'Admin',
    owner: 'Propietario',
    general_manager: 'Gerente general',
    front_desk: 'Recepción',
    housekeeping: 'Limpieza',
    maintenance: 'Mantenimiento',
    staff: 'Personal',
  };
  const roleName = user?.role
    ? (lang === 'es' ? spanishRoleLabels[user.role] : roleLabel(user.role))
    : '';
  const userName = user?.displayName ?? user?.username ?? (lang === 'es' ? 'Usuario' : 'User');
  const userMeta = [roleName, activeProperty?.name].filter(Boolean).join(' · ');
  const showInstallReminder = shouldShowMobileInstallReminder(
    platform,
    installed,
  );
  const closeInstallDialog = React.useCallback(
    () => setInstallStaxisOpen(false),
    [],
  );

  const avatar = user ? (
    <div ref={avatarWrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={avatarButtonRef}
        type="button"
        className="cx-avatarbtn"
        onClick={toggleMenu}
        aria-label={lang === 'es' ? 'Menú de usuario' : 'User menu'}
        aria-expanded={menuOpen}
      >
        {initial}
      </button>
      {menuOpen && menuPos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setMenuOpen(false)} />
          <div className="cx-menu" style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 50 }}>
            <div className="cx-menu-head">
              <div className="cx-menu-name">{user.displayName ?? 'User'}</div>
              <div className="cx-menu-role">
                {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
                {activeProperty ? ` · ${activeProperty.name}` : ''}
              </div>
            </div>

            {properties.length > 1 && (
              <>
                <div className="cx-menu-eyebrow">{lang === 'es' ? 'Hoteles' : 'Hotels'}</div>
                {properties.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cx-menu-item${p.id === activeProperty?.id ? ' cx-on' : ''}`}
                    onClick={() => {
                      setActivePropertyId(p.id);
                      sessionStorage.setItem('hotelops-session-selected', '1');
                      setMenuOpen(false);
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </>
            )}

            <div className="cx-menu-eyebrow">{lang === 'es' ? 'Idioma' : 'Language'}</div>
            {SUPPORTED_LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                className={`cx-menu-item${locale === l ? ' cx-on' : ''}`}
                onClick={() => { setLocale(l); setMenuOpen(false); }}
              >
                {LOCALE_META[l].nativeName}
              </button>
            ))}

            {platform === 'desktop' ? (
              <button
                type="button"
                className="cx-menu-item cx-phone-item"
                onClick={() => {
                  setMenuOpen(false);
                  setPhoneHandoffOpen(true);
                }}
              >
                <Smartphone size={16} aria-hidden="true" />
                Open on my phone
              </button>
            ) : null}

            {showInstallReminder ? (
              <button
                type="button"
                className="cx-menu-item cx-phone-item cx-install-item"
                onClick={() => {
                  setMenuOpen(false);
                  installReturnFocusRef.current = avatarButtonRef.current;
                  setInstallStaxisOpen(true);
                }}
              >
                <Download size={16} aria-hidden="true" />
                Add Staxis to Home Screen
              </button>
            ) : null}

            <button
              type="button"
              className="cx-menu-item cx-danger"
              onClick={() => { void signOut(); setMenuOpen(false); }}
            >
              {t('signOut', lang)}
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  ) : undefined;

  return (
    <>
      <MobileConcourseNav
        items={items}
        propertyOptions={properties.map((property) => ({ value: property.id, label: property.name }))}
        activePropertyId={activeProperty?.id ?? null}
        languageOptions={SUPPORTED_LOCALES.map((supportedLocale) => ({
          value: supportedLocale,
          label: LOCALE_META[supportedLocale].nativeName,
        }))}
        activeLocale={locale}
        userName={userName}
        userMeta={userMeta}
        userInitial={initial}
        homeLabel={lang === 'es' ? 'Inicio' : 'Home'}
        mobileTitle={pathname === '/inventory' || pathname.startsWith('/inventory/')
          ? (lang === 'es' ? 'Inventario' : 'Inventory')
          : undefined}
        menuLabel={lang === 'es' ? 'Abrir navegación' : 'Open navigation'}
        closeLabel={lang === 'es' ? 'Cerrar navegación' : 'Close navigation'}
        navigationLabel={lang === 'es' ? 'Navegación principal' : 'Main navigation'}
        sectionsLabel={lang === 'es' ? 'Secciones' : 'Sections'}
        accountLabel={lang === 'es' ? 'Cuenta' : 'Account'}
        propertyLabel={lang === 'es' ? 'Hotel' : 'Hotel'}
        languageLabel={lang === 'es' ? 'Idioma' : 'Language'}
        accountMenuLabel={lang === 'es'
          ? `Abrir menú de usuario de ${userName}`
          : `Open user menu for ${userName}`}
        settingsLabel={lang === 'es' ? 'Configuración' : 'Settings'}
        signOutLabel={t('signOut', lang)}
        installLabel={lang === 'es' ? 'Añadir Staxis a la pantalla de inicio' : 'Add Staxis to Home Screen'}
        showInstallAction={showInstallReminder}
        settingsActive={pathname.startsWith('/settings')}
        onHome={() => go('/home')}
        onSettings={() => go('/settings')}
        onSignOut={() => { void signOut(); }}
        onPropertyChange={(propertyId) => {
          setActivePropertyId(propertyId);
          sessionStorage.setItem('hotelops-session-selected', '1');
        }}
        onLanguageChange={(nextLocale) => {
          const supportedLocale = SUPPORTED_LOCALES.find((candidate) => candidate === nextLocale);
          if (supportedLocale) setLocale(supportedLocale);
        }}
        onInstall={(returnFocusElement) => {
          installReturnFocusRef.current = returnFocusElement;
          setInstallStaxisOpen(true);
        }}
      />
      <ConcourseBarView
        items={items}
        gearActive={pathname.startsWith('/settings')}
        onGear={() => go('/settings')}
        onLogo={() => go('/home')}
        homeLabel={lang === 'es' ? 'Inicio' : 'Home'}
        settingsLabel={lang === 'es' ? 'Configuración' : 'Settings'}
        avatar={avatar}
        // Away from the hub, the leftmost Staxis pill becomes a back-to-Home
        // control without changing the bar's visual language.
        showHome={pathname !== '/home'}
        desktopOnly
      />
      <PhoneHandoffDialog
        open={phoneHandoffOpen}
        onClose={() => setPhoneHandoffOpen(false)}
        returnFocusRef={avatarButtonRef}
      />
      <InstallStaxisDialog
        open={installStaxisOpen}
        onClose={closeInstallDialog}
        returnFocusRef={installReturnFocusRef}
      />
    </>
  );
}
