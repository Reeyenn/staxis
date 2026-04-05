'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { LayoutDashboard, BedDouble, Settings } from 'lucide-react';

const navItems = [
  { href: '/dashboard',    icon: LayoutDashboard, key: 'dashboard'    as const },
  { href: '/housekeeping', icon: BedDouble,        key: 'housekeeping' as const },
  { href: '/settings',     icon: Settings,         key: 'settings'     as const },
];

export function BottomNav() {
  const pathname = usePathname();
  const { lang } = useLang();

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
      background: 'rgba(255, 255, 255, 0.95)',
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

              <Icon
                size={22}
                strokeWidth={isActive ? 2.2 : 1.6}
                color={isActive ? 'var(--navy)' : 'var(--text-muted)'}
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
