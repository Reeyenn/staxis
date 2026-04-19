'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  LayoutDashboard, BedDouble, Wrench, Package, Users,
  Bell, Settings, LogOut, Globe,
} from 'lucide-react';

export function Sidebar() {
  const pathname = usePathname();
  const { lang, setLang } = useLang();
  const { user, signOut } = useAuth();
  const { activeProperty } = useProperty();

  const navLinks = [
    { href: '/dashboard',    label: lang === 'es' ? 'Panel' : 'Dashboard',       icon: LayoutDashboard },
    { href: '/housekeeping', label: lang === 'es' ? 'Limpieza' : 'Housekeeping',  icon: BedDouble },
    { href: '/maintenance',  label: lang === 'es' ? 'Mantenimiento' : 'Maintenance', icon: Wrench },
    { href: '/inventory',    label: lang === 'es' ? 'Inventario' : 'Inventory',   icon: Package },
    { href: '/staff',        label: lang === 'es' ? 'Personal' : 'Staff',         icon: Users },
  ];

  return (
    <aside style={{
      width: '260px',
      minHeight: '100vh',
      background: '#364262',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      position: 'sticky',
      top: 0,
      height: '100vh',
      overflowY: 'auto',
    }}>
      {/* Logo + Property */}
      <div style={{ padding: '28px 24px 20px' }}>
        <div style={{
          fontFamily: 'var(--font-sans)', fontWeight: 700,
          fontSize: '22px', color: '#FFFFFF', letterSpacing: '-0.02em',
          marginBottom: '4px',
        }}>
          Staxis
        </div>
        {activeProperty && (
          <div style={{
            fontSize: '13px', fontWeight: 400, color: 'rgba(255,255,255,0.5)',
            letterSpacing: '0.01em',
          }}>
            {activeProperty.name}
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '0 20px 12px' }} />

      {/* Nav links */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '0 12px', flex: 1 }}>
        {navLinks.map(link => {
          const isActive = pathname.startsWith(link.href);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '11px 16px', borderRadius: '10px',
                fontFamily: 'var(--font-sans)', fontWeight: isActive ? 600 : 400,
                fontSize: '14px', letterSpacing: '0.01em',
                color: isActive ? '#FFFFFF' : 'rgba(255,255,255,0.55)',
                background: isActive ? 'rgba(255,255,255,0.12)' : 'transparent',
                textDecoration: 'none',
                transition: 'all 0.15s ease',
              }}
            >
              <Icon size={18} strokeWidth={isActive ? 2 : 1.6} style={{ opacity: isActive ? 1 : 0.6 }} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div style={{ padding: '0 12px 16px', marginTop: 'auto' }}>
        {/* Divider */}
        <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '0 8px 12px' }} />

        {/* Settings */}
        <Link
          href="/settings"
          style={{
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '10px 16px', borderRadius: '10px',
            fontFamily: 'var(--font-sans)', fontWeight: 400,
            fontSize: '13px', color: 'rgba(255,255,255,0.5)',
            textDecoration: 'none', transition: 'all 0.15s ease',
          }}
        >
          <Settings size={16} strokeWidth={1.6} />
          {lang === 'es' ? 'Configuración' : 'Settings'}
        </Link>

        {/* Language toggle */}
        <button
          onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
          style={{
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '10px 16px', borderRadius: '10px', width: '100%',
            fontFamily: 'var(--font-sans)', fontWeight: 400,
            fontSize: '13px', color: 'rgba(255,255,255,0.5)',
            background: 'transparent', border: 'none', cursor: 'pointer',
            textAlign: 'left', transition: 'all 0.15s ease',
          }}
        >
          <Globe size={16} strokeWidth={1.6} />
          {lang === 'en' ? 'Español' : 'English'}
        </button>

        {/* User + Sign out */}
        {user && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 16px', marginTop: '8px',
            borderRadius: '10px', background: 'rgba(255,255,255,0.06)',
          }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#FFFFFF', fontWeight: 600, fontSize: '13px',
              fontFamily: 'var(--font-sans)', flexShrink: 0,
            }}>
              {(user.displayName?.[0] ?? user.username?.[0] ?? 'U').toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '13px', fontWeight: 500, color: '#FFFFFF',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {user.displayName ?? 'User'}
              </div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
              </div>
            </div>
            <button
              onClick={() => signOut()}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '4px', display: 'flex', flexShrink: 0,
              }}
              title={lang === 'es' ? 'Cerrar sesión' : 'Sign out'}
            >
              <LogOut size={14} color="rgba(255,255,255,0.4)" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
