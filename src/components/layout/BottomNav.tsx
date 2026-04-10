'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { LayoutDashboard, BedDouble, Wrench, Package, ClipboardCheck, Users, Settings } from 'lucide-react';

const navItems = [
  { href: '/dashboard',    icon: LayoutDashboard, key: 'dashboard'        as const },
  { href: '/housekeeping', icon: BedDouble,        key: 'housekeeping'     as const },
  { href: '/maintenance',  icon: Wrench,           key: 'maintenance'      as const },
  { href: '/inventory',    icon: Package,           key: 'inventoryTracking' as const },
  { href: '/inspections',  icon: ClipboardCheck,    key: 'inspections'      as const },
  { href: '/staff',        icon: Users,             key: 'staff'            as const },
  { href: '/settings',     icon: Settings,         key: 'settings'         as const },
];

export function BottomNav() {
  const pathname = usePathname();
  const { lang } = useLang();

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
      background: 'rgba(255, 255, 255, 0.97)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderTop: '1px solid var(--border)',
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-around',
        maxWidth: '600px', margin: '0 auto',
        padding: '6px 4px 4px',
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
                padding: '6px 2px 4px',
                textDecoration: 'none',
                gap: '2px',
                position: 'relative',
                minHeight: '44px',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {/* Active indicator dot */}
              {isActive && (
                <div style={{
                  position: 'absolute', top: '0px', left: '50%', transform: 'translateX(-50%)',
                  width: '4px', height: '4px', borderRadius: '50%',
                  background: 'var(--navy)',
                }} />
              )}

              <Icon
                size={22}
                strokeWidth={isActive ? 2.2 : 1.6}
                color={isActive ? 'var(--navy)' : 'var(--text-muted)'}
                style={{ transition: 'color 150ms' }}
              />

              <span style={{
                fontSize: '10px',
                fontWeight: isActive ? 700 : 500,
                letterSpacing: '0.01em',
                textTransform: 'uppercase',
                color: isActive ? 'var(--navy)' : 'var(--text-muted)',
                transition: 'color 150ms',
                lineHeight: 1,
                fontFamily: 'var(--font-sans)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
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
