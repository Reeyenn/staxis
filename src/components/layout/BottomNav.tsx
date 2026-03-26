'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { LayoutDashboard, Sun, BedDouble, BarChart3, Settings, Calculator, Wrench, LayoutGrid } from 'lucide-react';

const navItems = [
  { href: '/dashboard',     icon: LayoutDashboard, key: 'dashboard'    as const },
  { href: '/morning-setup', icon: Sun,              key: 'morningSetup' as const },
  { href: '/war-room',      icon: LayoutGrid,       key: 'warRoom'      as const },
  { href: '/rooms',         icon: BedDouble,        key: 'rooms'        as const },
  { href: '/analytics',     icon: BarChart3,        key: 'analytics'    as const },
  { href: '/settings',      icon: Settings,         key: 'settings'     as const },
];

export function BottomNav() {
  const pathname = usePathname();
  const { lang } = useLang();

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
      background: 'rgba(10, 10, 10, 0.95)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderTop: '1px solid var(--border)',
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-around',
        maxWidth: '600px', margin: '0 auto',
        padding: '8px 8px 6px',
      }}>
        {navItems.map(({ href, icon: Icon, key }) => {
          const isActive = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                padding: '4px 4px 6px',
                textDecoration: 'none',
                gap: '3px',
                position: 'relative',
                minHeight: '52px',
              }}
            >
              {/* Active indicator dot */}
              {isActive && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: '4px',
                  height: '2px',
                  borderRadius: '0 0 2px 2px',
                  background: 'var(--amber)',
                }} />
              )}

              <Icon
                size={22}
                strokeWidth={isActive ? 2.2 : 1.6}
                color={isActive ? 'var(--amber)' : 'var(--text-muted)'}
                style={{ transition: 'color 150ms, stroke-width 150ms' }}
              />

              <span style={{
                fontSize: '10px',
                fontWeight: isActive ? 600 : 400,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: isActive ? 'var(--amber)' : 'var(--text-muted)',
                transition: 'color 150ms',
                lineHeight: 1,
                fontFamily: 'var(--font-sans)',
              }}>
                {t(key, lang)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
