'use client';

// ═══════════════════════════════════════════════════════════════════════════
// /demo/concourse — login-free preview of the Concourse shell on sample data.
//
// Login-free showcase: no auth, no AppLayout, no Supabase — the
// middleware whitelists /demo/ so anyone with the link can click through the
// full shell: pill bar, hub with the glowing Ask bar + live-looking tiles,
// section pages, the Staxis approval queue, and EN/ES. Renders the SAME
// presentational components as the real app (ConcourseBarView, HomeHubView,
// QueueView), so what you approve here is what ships. Refresh resets;
// nothing persists.
// ═══════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React from 'react';
import { ConcourseBarView, type BarItem } from '@/components/concourse/ConcourseBarView';
import { HomeHubView, type HubTile } from '@/components/concourse/HomeHubView';
import { QueueView } from '@/components/concourse/QueueView';
import { AskHeroView } from '@/components/concourse/AskHero';
import { CxStyle } from '@/components/concourse/concourse-css';
import { CxIcon } from '@/components/concourse/icons';
import { SAMPLE_DECISIONS, QUEUE_COUNT_EVENT } from '@/components/concourse/sample-decisions';

type Lang = 'en' | 'es';
type View = 'home' | 'settings' | (typeof DEMO_TILES)[number]['key'];

// Sample tile content — verbatim from the design handoff.
const DEMO_TILES = [
  { key: 'staxis',         en: 'Staxis',         es: 'Staxis',         stEn: '3 approvals waiting',         stEs: '3 aprobaciones esperan',        tone: 'warn' as const, hot: true },
  { key: 'dashboard',      en: 'Dashboard',      es: 'Panel',          stEn: '87% · pacing +4% vs LW',      stEs: '87% · ritmo +4%',               tone: 'ok' as const },
  { key: 'housekeeping',   en: 'Housekeeping',   es: 'Limpieza',       stEn: '14 left · on pace for 3:00p', stEs: '14 restantes · a buen ritmo',   tone: 'ok' as const },
  { key: 'communications', en: 'Communications', es: 'Comunicación',   stEn: '2 unread · 6/8 confirmed',    stEs: '2 sin leer · 6/8 confirmados',  tone: 'warn' as const },
  { key: 'maintenance',    en: 'Maintenance',    es: 'Mantenimiento',  stEn: 'AC in 214 — high priority',   stEs: 'AC en 214 — prioridad alta',    tone: 'bad' as const },
  { key: 'inventory',      en: 'Inventory',      es: 'Inventario',     stEn: 'Towels low · order by Fri',   stEs: 'Toallas bajas · pedir el vie',  tone: 'bad' as const },
  { key: 'staff',          en: 'Staff',          es: 'Personal',       stEn: '6 on · Maria out sick',       stEs: '6 en turno · Maria enferma',    tone: 'warn' as const },
  { key: 'financials',     en: 'Financials',     es: 'Finanzas',       stEn: '+6.2% MTD · on budget',       stEs: '+6.2% del mes · en presupuesto', tone: 'ok' as const },
] as const;

const SETTINGS_ROWS = [
  { en: 'Profile', es: 'Perfil', sub_en: 'Name, phone, sign-in', sub_es: 'Nombre, teléfono, acceso' },
  { en: 'Language', es: 'Idioma', sub_en: 'English, Español, Kreyòl Ayisyen, Tagalog, Tiếng Việt', sub_es: 'English, Español, Kreyòl Ayisyen, Tagalog, Tiếng Việt' },
  { en: 'Notifications & SMS', es: 'Notificaciones y SMS', sub_en: 'What Staxis texts you about', sub_es: 'Sobre qué te escribe Staxis' },
  { en: 'Voice & wake word', es: 'Voz y palabra clave', sub_en: 'Talk settings', sub_es: 'Ajustes de voz' },
  { en: 'Sections on/off', es: 'Secciones sí/no', sub_en: 'Which departments this hotel uses', sub_es: 'Qué departamentos usa este hotel' },
];

export default function ConcourseDemoPage() {
  const [view, setView] = React.useState<View>('home');
  const [lang, setLang] = React.useState<Lang>('en');
  const [pending, setPending] = React.useState(SAMPLE_DECISIONS.length);
  const es = lang === 'es';

  // The queue broadcasts approvals — keep the demo badge live too.
  React.useEffect(() => {
    const h = (e: Event) => {
      const n = (e as CustomEvent).detail?.pending;
      if (typeof n === 'number') setPending(n);
    };
    window.addEventListener(QUEUE_COUNT_EVENT, h);
    return () => window.removeEventListener(QUEUE_COUNT_EVENT, h);
  }, []);

  const items: BarItem[] = DEMO_TILES.map((s) => ({
    key: s.key,
    label: es ? s.es : s.en,
    active: view === s.key,
    badge: s.key === 'staxis' ? pending : undefined,
    onClick: () => setView(s.key),
  }));

  const tiles: HubTile[] = DEMO_TILES.map((s) => ({
    key: s.key,
    label: es ? s.es : s.en,
    status: s.key === 'staxis'
      ? (es ? `${pending} aprobaciones esperan` : `${pending} approvals waiting`)
      : (es ? s.stEs : s.stEn),
    tone: s.key === 'staxis' && pending === 0 ? 'ok' : s.tone,
    hot: 'hot' in s && s.hot,
    onClick: () => setView(s.key),
  }));

  const now = new Date();
  const dateStr = now.toLocaleDateString(es ? 'es' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div
      className="cx-font"
      style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        background: 'radial-gradient(ellipse 1000px 500px at 50% 0%, #FFFFFF 0%, #F5F7F4 100%)',
      }}
    >
      <CxStyle />
      <ConcourseBarView
        items={items}
        gearActive={view === 'settings'}
        onGear={() => setView('settings')}
        onLogo={() => setView('home')}
        homeLabel={es ? 'Inicio' : 'Home'}
        settingsLabel={es ? 'Configuración' : 'Settings'}
        avatar={<div className="cx-avatarbtn" style={{ cursor: 'default' }}>R</div>}
        showHome={view !== 'home'}
      />

      {view === 'home' ? (
        <HomeHubView
          greeting={es ? 'Buenos días, Reeyen' : 'Good morning, Reeyen'}
          dateline={`${dateStr} · Comfort Suites Beaumont`}
          tiles={tiles}
          ask={
            <AskHeroView
              placeholder={es ? 'Pregunta o da una orden — “¿quién limpia la 204?”' : 'Ask or command — “who’s cleaning 204?”'}
              talkLabel={es ? 'Hablar' : 'Talk'}
              onSubmit={() => { /* demo — the live app answers here */ }}
              onTalk={() => { /* demo — the live app opens voice here */ }}
            />
          }
        />
      ) : view === 'staxis' ? (
        // NOT keyed by lang — a language flip must re-render strings in
        // place, never reset approve/dismiss state (badge would desync).
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <DemoHomeBtn es={es} onHome={() => setView('home')} />
          <QueueView lang={lang} />
        </div>
      ) : (
        <DemoSectionPage
          key={view}
          es={es}
          title={view === 'settings' ? (es ? 'Configuración' : 'Settings') : (es ? DEMO_TILES.find(s => s.key === view)!.es : DEMO_TILES.find(s => s.key === view)!.en)}
          isSettings={view === 'settings'}
          onHome={() => setView('home')}
        />
      )}

      {/* Bottom Ask capsule — inert in the demo (the live app's is the real agent). */}
      {view !== 'home' && (
        <div className="cx-capsulewrap">
          <div className="cx-capsule">
            <span className="cx-spark" aria-hidden>✦</span>
            <input placeholder={es ? 'Pregúntale a Staxis…' : 'Ask Staxis…'} aria-label="Ask Staxis" readOnly />
            <button type="button" className="cx-talk"><CxIcon name="mic" size={12} />{es ? 'Hablar' : 'Talk'}</button>
          </div>
        </div>
      )}

      {/* Honesty chip — this is a design preview, not the live app. */}
      <div style={{
        position: 'fixed', left: '14px', bottom: '14px', zIndex: 60,
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace', fontSize: '10px',
        letterSpacing: '.08em', textTransform: 'uppercase', color: '#8A9187',
        background: 'rgba(255,255,255,.85)', border: '1px solid rgba(31,35,28,.08)',
        borderRadius: '999px', padding: '5px 10px', backdropFilter: 'blur(8px)',
      }}>
        {es ? 'Vista de diseño · datos de muestra' : 'Design preview · sample data'}
      </div>
    </div>
  );
}

function DemoHomeBtn({ es, onHome }: { es: boolean; onHome: () => void }) {
  return (
    <div style={{ maxWidth: '880px', margin: '0 auto', padding: '22px 24px 0', width: '100%', boxSizing: 'border-box' }}>
      <button type="button" className="cx-homebtn" onClick={onHome}>
        <CxIcon name="back" size={13} />
        {es ? 'Inicio' : 'Home'}
      </button>
    </div>
  );
}

function DemoSectionPage({ es, title, isSettings, onHome }: {
  es: boolean; title: string; isSettings: boolean; onHome: () => void;
}) {
  const stats = isSettings ? [] : [
    { k: es ? 'Ocupación' : 'Occupancy', v: '87%', d: '+4 vs LW', tone: 'ok' },
    { k: 'ADR', v: '$126', d: '+$3', tone: 'ok' },
    { k: es ? 'Llegadas' : 'Arrivals', v: '23' },
  ];
  return (
    <div className="cx-page cx-swap" style={{ paddingTop: '22px' }}>
      <button type="button" className="cx-homebtn" onClick={onHome}>
        <CxIcon name="back" size={13} />
        {es ? 'Inicio' : 'Home'}
      </button>
      <div className="cx-ptitle">{title}</div>
      <div className="cx-psub">
        {es ? 'Contenido de muestra — la app real muestra las páginas del módulo aquí.' : 'Sample content — the real app shows the module pages here.'}
      </div>
      {stats.length > 0 && (
        <div className="cx-stats">
          {stats.map((s) => (
            <div key={s.k} className="cx-stat">
              <div className="cx-stat-k">{s.k}</div>
              <div className="cx-stat-row">
                <span className="cx-stat-v">{s.v}</span>
                {s.d && <span className={`cx-stat-d cx-${s.tone ?? 'ok'}`}>{s.d}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="cx-rows">
        {isSettings ? (
          SETTINGS_ROWS.map((r) => (
            <div key={r.en} className="cx-rowi">
              <div>
                <div className="cx-rowi-t">{es ? r.es : r.en}</div>
                <div className="cx-rowi-s">{es ? r.sub_es : r.sub_en}</div>
              </div>
              <span className="cx-bdg cx-mut">{es ? 'Abrir' : 'Open'}</span>
            </div>
          ))
        ) : (
          <>
            <div className="cx-rowi">
              <div>
                <div className="cx-rowi-t">{es ? 'Habitación 214 — AC no enfría' : 'Room 214 — AC not cooling'}</div>
                <div className="cx-rowi-s">{es ? 'Orden WO-142 · abierta hace 2h' : 'Work order WO-142 · opened 2h ago'}</div>
              </div>
              <span className="cx-bdg cx-bad">{es ? 'Alta' : 'High'}</span>
            </div>
            <div className="cx-rowi">
              <div>
                <div className="cx-rowi-t">{es ? '3 salidas sin asignar tras la ausencia' : '3 checkouts unassigned after callout'}</div>
                <div className="cx-rowi-s">{es ? 'Limpieza · cubrir antes de las 11:00a' : 'Housekeeping · needs cover by 11:00a'}</div>
              </div>
              <span className="cx-bdg cx-warn">{es ? 'Acción' : 'Action'}</span>
            </div>
            <div className="cx-rowi">
              <div>
                <div className="cx-rowi-t">{es ? 'Toallas de baño bajo el margen de 3 semanas' : 'Bath towels below 3-week buffer'}</div>
                <div className="cx-rowi-s">{es ? 'Inventario · pedido sugerido' : 'Inventory · reorder suggested'}</div>
              </div>
              <span className="cx-bdg cx-warn">{es ? 'Stock bajo' : 'Low stock'}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
