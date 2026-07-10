'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ConcourseBar — the connected pill bar (replaces Header in AppLayout).
//
// Wires ConcourseBarView to the real app: section pills from the section
// registry (filtered by the per-hotel toggles + the financials capability
// gate, exactly like the old Header), logo → /home hub, EN/ES → the shared
// language context, gear → /settings, and an avatar dropdown that keeps
// everything the old header offered: who you are, hotel switching, the full
// 5-language list, Admin (owners), and sign out.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
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

export function ConcourseBar() {
  const { user, signOut } = useAuth();
  const { properties, activeProperty, setActivePropertyId } = useProperty();
  const can = useCan();
  const { lang, locale, setLocale } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const enabled = useEnabledSections();
  const [menuOpen, setMenuOpen] = React.useState(false);

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
  const items: BarItem[] = SECTION_LIST
    .filter((m) => {
      if (!enabled[m.key]) return false;
      if (m.key === 'financials') return !!user && can('view_financials');
      return true;
    })
    .map((m) => ({
      key: m.key,
      label: lang === 'es' ? m.label_es : m.label_en,
      active: pathname === m.navHref || pathname.startsWith(m.navHref + '/'),
      badge: m.key === 'staxis' ? pendingCount : undefined,
      onClick: () => router.push(m.navHref),
    }));

  // Admin is owner-only and not a per-hotel section — its own pill, far side.
  if (user?.role === 'admin') {
    items.push({
      key: 'admin',
      label: lang === 'es' ? 'Admin.' : 'Admin',
      active: pathname.startsWith('/admin'),
      onClick: () => router.push('/admin/properties'),
    });
  }

  const initial = (user?.displayName?.[0] ?? user?.username?.[0] ?? 'U').toUpperCase();

  const avatar = user ? (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className="cx-avatarbtn"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label={lang === 'es' ? 'Menú de usuario' : 'User menu'}
        aria-expanded={menuOpen}
      >
        {initial}
      </button>
      {menuOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setMenuOpen(false)} />
          <div className="cx-menu">
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

            <button
              type="button"
              className="cx-menu-item cx-danger"
              onClick={() => { void signOut(); setMenuOpen(false); }}
            >
              {t('signOut', lang)}
            </button>
          </div>
        </>
      )}
    </div>
  ) : undefined;

  return (
    <ConcourseBarView
      items={items}
      lang={locale === 'en' ? 'en' : locale === 'es' ? 'es' : null}
      onLang={(l) => setLocale(l)}
      gearActive={pathname.startsWith('/settings')}
      onGear={() => router.push('/settings')}
      onLogo={() => router.push('/home')}
      homeLabel={lang === 'es' ? 'Inicio' : 'Home'}
      settingsLabel={lang === 'es' ? 'Configuración' : 'Settings'}
      avatar={avatar}
    />
  );
}
