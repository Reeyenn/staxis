'use client';


export const dynamic = 'force-dynamic';

// The delivery settings now live under Settings → Reports → "Auto-send" tab.
// This standalone route is kept only so any old bookmarks / deep links still
// work; it renders the same NotificationsPanel inside a minimal page shell.
// It is no longer linked from the Settings menu.

import React from 'react';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { ChevronLeft, Bell } from 'lucide-react';
import { NotificationsPanel } from './_components/NotificationsPanel';

export default function NotificationsPage() {
  const router = useRouter();
  const { lang } = useLang();

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: 720 }}>
        <div>
          <button
            onClick={() => router.push('/settings')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', fontSize: '13px',
              cursor: 'pointer', padding: '0 0 12px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <ChevronLeft size={14} />
            {lang === 'es' ? 'Configuración' : 'Settings'}
          </button>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '17px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell size={15} color="var(--navy)" />
            {lang === 'es' ? 'Notificaciones' : 'Notifications'}
          </h1>
        </div>

        <NotificationsPanel />
      </div>
    </AppLayout>
  );
}
