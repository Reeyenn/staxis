'use client';


export const dynamic = 'force-dynamic';
// Split from 6094-line monolith on 2026-04-27. Each tab now lives in _components/:
// - ScheduleTab.tsx: the assignment board (who cleans what, in what order)
// - DeepCleanTab.tsx: Deep clean tab (config + records)
// - QualityTab.tsx: Quality & performance (merged Inspections + Performance,
//   June 2026 — replaces the former two separate tabs)
//
// This page.tsx is now just the tab orchestrator — routes between tabs,
// persists tab choice to localStorage, handles auth guards. No section
// functions remain in this file; they're all in _components/.

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScheduleTab } from './_components/ScheduleTab';
import { DeepCleanTab } from './_components/DeepCleanTab';
import { QualityTab } from './_components/QualityTab';
import { HousekeepingSetup } from './_components/HousekeepingSetup';
import { T, FONT_SANS, Card } from './_components/_snow';
import { canManageTeam } from '@/lib/roles';
import { useCan } from '@/lib/capabilities/useCan';
import { isHousekeepingSetupComplete } from '@/lib/housekeeping/setup-gate';

// ─── Tab config ──────────────────────────────────────────────────────────────

// The Rooms tab (a whole-hotel grid where a manager tapped a card to flip a
// room clean/dirty) was removed 2026-07-24. The PMS owns room cleanliness and
// Staxis only reads it, so that tap was discarded by the next report email
// 30-60 minutes later. A control that silently throws away what the user typed
// is worse than no control.
//
// The `schedule` key is a LABEL-ONLY misnomer, kept on purpose. The tab shows
// today's room assignments — it never held shift scheduling (who works which
// days, time off, open shifts, OT caps); that lives in Staff and stays there.
// It was relabelled "Board" on 2026-07-24, but the key string is load-bearing:
// `?tab=schedule` deep links, the saved `hk-tab` value in every existing
// manager's browser, and src/lib/worklist/core.ts all point at it. Rename the
// label freely; do not rename the key.
type TabKey = 'schedule' | 'quality' | 'deepclean';

const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'schedule',  label: 'Board',      labelEs: 'Tablero'        },
  { key: 'quality',   label: 'Quality',    labelEs: 'Calidad'        },
  { key: 'deepclean', label: 'Deep Clean', labelEs: 'Limpieza prof.' },
];

const housekeepingTabStore = {
  get(): string | null {
    try { return window.localStorage.getItem('hk-tab'); } catch { return null; }
  },
  set(tab: TabKey): void {
    try { window.localStorage.setItem('hk-tab', tab); } catch { /* storage can be blocked */ }
  },
};

// ─── First-run gate ──────────────────────────────────────────────────────────
// Housekeeping can't be planned until we know how this hotel actually works
// (who marks rooms clean, how long a room takes, who builds the board). The
// questionnaire runs once per hotel and is answered by management only. A
// housekeeper or front-desk clerk who opens the section first sees a calm
// hand-off note instead — never the questionnaire, never a broken empty page.
//
// WHO MAY ANSWER IT: a management role AND the `manage_clean_times` capability.
// That pair is exactly what PUT /api/housekeeping/setup enforces, and the two
// must stay identical. If this gate were the looser of the two, a manager whose
// clean-time permission had been switched off at this hotel would answer all
// seven screens, get a 403 on save, and be stuck in a retry loop with no way to
// reach any Housekeeping tab — the section would be permanently unreachable for
// them. If it were the stricter one, someone the server would happily accept
// could never get the questionnaire on screen.

function SetupNotice({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: '48px 24px', display: 'flex', justifyContent: 'center', fontFamily: FONT_SANS }}>
      <Card style={{ maxWidth: 460, textAlign: 'center' }} padding="28px 26px">
        <div style={{ fontSize: 17, fontWeight: 600, color: T.ink, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: T.ink2 }}>{body}</div>
      </Card>
    </div>
  );
}

/** For anyone who simply isn't the person who answers this. */
function SetupPendingNotice({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  return (
    <SetupNotice
      title={es ? 'Casi listo' : 'Almost ready'}
      body={es
        ? 'Tu gerente todavía tiene que terminar de configurar la limpieza. En cuanto lo haga, tu trabajo del día aparecerá aquí.'
        : 'Your manager still needs to finish setting up housekeeping. As soon as that’s done, your day’s work shows up here.'}
    />
  );
}

/**
 * For a manager whose clean-time permission was switched off at this hotel.
 * They would otherwise get the questionnaire and a save that can never succeed,
 * so they are told plainly who can unblock them instead.
 */
function SetupNoPermissionNotice({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  return (
    <SetupNotice
      title={es ? 'Falta un permiso' : 'One permission is missing'}
      body={es
        ? 'No tienes permiso para configurar la limpieza en este hotel. Pídele a tu dueño o a un administrador que te lo active, o que termine la configuración.'
        : 'You don’t have permission to set up housekeeping at this hotel. Ask your owner or an administrator to turn it on for you, or to finish the setup themselves.'}
    />
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function HousekeepingPage() {
  const [activeTab, setActiveTabState] = useState<TabKey>('schedule');
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});
  const { lang } = useLang();
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, activeProperty, loading: propLoading, refreshProperty } = useProperty();
  const can = useCan();
  const router = useRouter();

  // Auth guard — redirect if not logged in or no property
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/property-selector');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore tab on mount. A `?tab=` deep-link (e.g. from the worklist) wins
  // over the saved choice; otherwise fall back to localStorage.
  useEffect(() => {
    const valid: TabKey[] = ['schedule', 'quality', 'deepclean'];
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab && (valid as string[]).includes(urlTab)) {
      setActiveTabState(urlTab as TabKey);
      housekeepingTabStore.set(urlTab as TabKey);
      return;
    }
    const saved = housekeepingTabStore.get();
    // Legacy keys: the former Inspections / Performance tabs are now merged
    // into Quality, so anyone whose last tab was one of those lands on Quality.
    if (saved === 'inspections' || saved === 'performance') { setActiveTabState('quality'); return; }
    // The Rooms tab was removed 2026-07-24 (see the TabKey comment). Anyone
    // whose last tab was Rooms lands on the assignment board — the closest
    // surface, and the daily driver — rather than falling through to a
    // default by accident.
    if (saved === 'rooms') { setActiveTabState('schedule'); return; }
    if (saved && (valid as string[]).includes(saved)) setActiveTabState(saved as TabKey);
  }, []);

  const setActiveTab = (tab: TabKey) => {
    setActiveTabState(tab);
    housekeepingTabStore.set(tab);
  };

  useEffect(() => {
    tabRefs.current[activeTab]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  // Pull the freshly-saved answers into PropertyContext so the gate flips in
  // place — no hard reload, no losing the tab the manager was headed for.
  const handleSetupComplete = async () => {
    try {
      await refreshProperty();
    } catch {
      // Refresh failed (network / RLS race). A reload is the honest fallback:
      // the answers ARE saved, we just can't see them yet.
      window.location.reload();
    }
  };

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{
          minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', fontFamily: FONT_SANS,
        }}>
          <div className="animate-spin" style={{
            width: '28px', height: '28px',
            border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
          }} />
        </div>
      </AppLayout>
    );
  }

  // First-run gate. Deliberately requires a RESOLVED property (not just a
  // remembered id) on top of the loading guards above — activePropertyId is
  // read straight from localStorage on first paint and can point at a hotel
  // that isn't in this account's list yet, and a manager who finished setup
  // long ago must never see a flash of the questionnaire. When user or
  // property is missing we fall through to today's behavior and let the auth
  // guard above redirect.
  if (user && activeProperty && activeProperty.id === activePropertyId
      && !isHousekeepingSetupComplete(activeProperty.housekeepingSetup)) {
    const isManager = canManageTeam(user.role);
    return (
      <AppLayout>
        {!isManager
          ? <SetupPendingNotice lang={lang} />
          : !can('manage_clean_times')
            ? <SetupNoPermissionNotice lang={lang} />
            : (
              // Keyed on the hotel: switching hotels in the top bar re-renders
              // this page in place without unmounting anything, so without a key
              // the next hotel would inherit the previous hotel's half-answered
              // questionnaire — including a board photo stored under the other
              // hotel's folder. Same reason inventory keys its shell.
              <HousekeepingSetup
                key={activeProperty.id}
                propertyId={activeProperty.id}
                lang={lang}
                onComplete={handleSetupComplete}
              />
            )}
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {/* ── Snow sub-tab bar ──
          Sticky just below the floating pill bar. Frosted (not solid white)
          so it sits on the Concourse page wash without a color seam; 1px
          hairline rule on the bottom, 1.5px ink underline on the active tab. */}
      <div className="hk-tab-shell" style={{
        background: 'rgba(255,255,255,.72)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${T.rule}`,
        position: 'sticky', top: 64, zIndex: 10,
      }}>
        <nav className="hk-tab-list" aria-label={lang === 'es' ? 'Secciones de limpieza' : 'Housekeeping sections'}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key;
            const label = lang === 'es' ? tab.labelEs : tab.label;
            return (
              <button
                key={tab.key}
                ref={(node) => { tabRefs.current[tab.key] = node; }}
                onClick={() => setActiveTab(tab.key)}
                aria-current={isActive ? 'page' : undefined}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  minHeight: 44, padding: '8px 0 10px', position: 'relative',
                  fontFamily: FONT_SANS, fontSize: 14,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? T.ink : T.ink2,
                  borderBottom: isActive ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                  marginBottom: '-1px',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </div>

      <style>{`
        .hk-tab-shell { padding: 18px 48px 0; }
        .hk-tab-list {
          display: flex;
          gap: 28px;
          overflow-x: auto;
          overscroll-behavior-inline: contain;
          scrollbar-width: none;
        }
        .hk-tab-list::-webkit-scrollbar { display: none; }
        @media (max-width: 640px) {
          .hk-tab-shell { padding: 10px 16px 0; }
          .hk-tab-list { gap: 22px; scroll-snap-type: inline proximity; }
          .hk-tab-list > button { flex: 0 0 auto; scroll-snap-align: start; }
        }
      `}</style>

      {/* ── Tab content — keyed remount triggers the CSS .animate-in cascade ── */}
      <div key={activeTab} className="animate-in stagger-1">
        {activeTab === 'schedule'  && <ScheduleTab />}
        {activeTab === 'quality'   && <QualityTab />}
        {activeTab === 'deepclean' && <DeepCleanTab />}
      </div>
    </AppLayout>
  );
}
