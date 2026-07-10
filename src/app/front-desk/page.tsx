'use client';


export const dynamic = 'force-dynamic';
import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, updateRoom } from '@/lib/db';
import { RushButton } from './_components/RushButton';
import { FrontDeskTabBar, type FrontDeskTabKey } from './_components/TabBar';
import { LostFoundTab } from './_components/LostFoundTab';
import { ComplaintsTab } from './_components/ComplaintsTab';
import { PackagesTab } from './_components/PackagesTab';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room } from '@/types';
import type { PropertyFeedStatus } from '@/lib/pms/feed-status';
import { FeedLearningBanner } from '@/components/FeedLearningBanner';
import { useToast, ToastHost } from '@/app/_components/ui/toast';

const FD_TAB_KEY = 'fd-tab';

/* ════════════════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════════════════ */

function getStatusColor(status: string): string {
  switch (status) {
    case 'clean':
    case 'inspected': return '#006565';
    case 'in_progress': return '#364262';
    case 'dirty': return '#ba1a1a';
    default: return '#757684';
  }
}

function getStatusBg(status: string): string {
  switch (status) {
    case 'clean':
    case 'inspected': return 'rgba(0,101,101,0.08)';
    case 'in_progress': return 'rgba(54,66,98,0.08)';
    case 'dirty': return 'rgba(186,26,26,0.06)';
    default: return '#eae8e3';
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'clean': return 'check_circle';
    case 'inspected': return 'verified';
    case 'in_progress': return 'cleaning_services';
    case 'dirty': return 'error';
    default: return 'help';
  }
}

function getStatusLabel(status: string, lang: string = 'en'): string {
  if (lang === 'es') {
    switch (status) {
      case 'dirty': return 'Sucia';
      case 'in_progress': return 'Limpiando';
      case 'clean': return 'Limpia';
      case 'inspected': return 'Inspeccionada';
      default: return status;
    }
  }
  switch (status) {
    case 'dirty': return 'Dirty';
    case 'in_progress': return 'Cleaning';
    case 'clean': return 'Clean';
    case 'inspected': return 'Inspected';
    default: return status;
  }
}

function getTypeLabel(type: string, lang: string = 'en'): string {
  if (lang === 'es') {
    switch (type) {
      case 'checkout': return 'Salida';
      case 'stayover': return 'Continuación';
      case 'vacant': return 'Vacante';
      default: return type;
    }
  }
  switch (type) {
    case 'checkout': return 'Checkout';
    case 'stayover': return 'Stayover';
    case 'vacant': return 'Vacant';
    default: return type;
  }
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'checkout': return 'logout';
    case 'stayover': return 'hotel';
    case 'vacant': return 'door_open';
    default: return 'meeting_room';
  }
}

function groupRoomsByFloor(rooms: Room[]): Record<string, Room[]> {
  const grouped: Record<string, Room[]> = {};
  rooms.forEach(room => {
    const floor = room.number.charAt(0) || '1';
    if (!grouped[floor]) grouped[floor] = [];
    grouped[floor].push(room);
  });
  return Object.fromEntries(
    Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════════════════════════ */

export default function FrontDeskPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const can = useCan();
  const router = useRouter();

  // Reactive: rolls over at Central midnight so the rooms subscription
  // matches the new day's bucket. The front desk computer typically stays
  // logged in across the night-audit shift.
  const today = useTodayStr();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [processing, setProcessing] = useState(false);
  // Shared toast primitive (F7) — 2.5s teal success pill, top-center.
  const { toasts, show: showToast } = useToast({ durationMs: 2500, max: 1 });
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [tab, setTabState] = useState<FrontDeskTabKey>('rooms');

  // Per-hotel capability gates (default: every role; an admin can switch a role
  // OFF per hotel from the Access tab). Rooms is always available.
  const canLostFound = !!user && can('use_lost_and_found');
  const canComplaints = !!user && can('use_complaints');
  const canPackages = !!user && can('use_packages');

  // Material Symbols font is loaded globally via globals.css

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore the saved tab; force back to Rooms if a non-manager somehow has
  // a management-only tab ('lost-and-found' / 'complaints') persisted. A
  // `?tab=` deep-link (e.g. from the worklist) wins over the saved choice; the
  // management gate below still forces non-managers off complaints/lost+found.
  useEffect(() => {
    const fdTabs = ['lost-and-found', 'rooms', 'complaints', 'packages'] as const;
    const urlTab = new URLSearchParams(window.location.search).get('tab') as FrontDeskTabKey | null;
    if (urlTab && (fdTabs as readonly string[]).includes(urlTab)) { setTabState(urlTab); localStorage.setItem(FD_TAB_KEY, urlTab); return; }
    const saved = localStorage.getItem(FD_TAB_KEY);
    if (saved === 'lost-and-found' || saved === 'rooms' || saved === 'complaints' || saved === 'packages') setTabState(saved);
  }, []);
  useEffect(() => {
    if (tab === 'lost-and-found' && !canLostFound) setTabState('rooms');
    else if (tab === 'complaints' && !canComplaints) setTabState('rooms');
    else if (tab === 'packages' && !canPackages) setTabState('rooms');
  }, [tab, canLostFound, canComplaints, canPackages]);

  const setTab = (t: FrontDeskTabKey) => {
    setTabState(t);
    localStorage.setItem(FD_TAB_KEY, t);
  };

  // feat/cua-partial-promotion — per-feed PMS trust, riding the rooms poll.
  const [feedStatus, setFeedStatus] = useState<PropertyFeedStatus | null>(null);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, today, (rs, fs) => {
      setRooms(rs); if (fs) setFeedStatus(fs);
    });
  }, [user, activePropertyId, today]);

  // Keep the open room sheet in sync with the live board. It used to render
  // a tap-time snapshot, so a rush set from the sheet (or a housekeeper
  // finishing the room on their phone) never updated the open sheet until
  // it was closed and reopened.
  useEffect(() => {
    setSelectedRoom(prev => {
      if (!prev) return prev;
      const fresh = rooms.find(r => r.id === prev.id);
      return fresh ?? prev;
    });
  }, [rooms]);

  // Honesty derivations — all false until feed status arrives (manual
  // hotels / older servers) so the page renders exactly as today.
  // Review pass: banners pick ONE message, but neutralization is a union —
  // 'pending' (never synced) makes default statuses fake even with no feed
  // formally learning; 'paused' is banner-only (real-but-stale data).
  const fsLive = feedStatus?.mode === 'live';
  const connPending = fsLive && feedStatus.connection === 'pending';
  const connPaused = fsLive && feedStatus.connection === 'paused';
  const roomStatusLearning = fsLive && feedStatus.feeds.roomStatus === 'learning';
  const reservationsLearning = fsLive &&
    (connPending || feedStatus.feeds.arrivals === 'learning' || feedStatus.feeds.departures === 'learning');
  // A room whose status is the catch-all default has NO real signal while
  // the room-status feed is learning or the first sync is pending.
  const isNeutralRoom = (r: Room): boolean =>
    (roomStatusLearning || connPending) && r.statusSource === 'default';

  /* ── Derived stats ── */
  const stats = useMemo(() => {
    const total = rooms.length;
    const known = rooms.filter(r => !isNeutralRoom(r));
    const unknown = total - known.length;
    const clean = known.filter(r => r.status === 'clean' || r.status === 'inspected').length;
    const dirty = known.filter(r => r.status === 'dirty').length;
    const inProgress = known.filter(r => r.status === 'in_progress').length;
    const checkouts = rooms.filter(r => r.type === 'checkout').length;
    const stayovers = rooms.filter(r => r.type === 'stayover').length;
    const dndCount = rooms.filter(r => r.isDnd).length;
    const cleanPct = known.length > 0 ? Math.round((clean / known.length) * 100) : 0;
    return { total, clean, dirty, inProgress, checkouts, stayovers, dndCount, cleanPct, unknown };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, roomStatusLearning]);

  /* ── Filtered rooms ── */
  const filteredRooms = useMemo(() => {
    if (statusFilter === 'all') return rooms;
    if (statusFilter === 'checkout' || statusFilter === 'stayover' || statusFilter === 'vacant') {
      return rooms.filter(r => r.type === statusFilter);
    }
    // Neutral (no-signal) rooms are excluded from the status counts, so
    // exclude them from status filters too — otherwise "Dirty (2)" opens a
    // grid of 80 "No data" cards (review pass, senior #4).
    // The "Clean" pill counts clean + inspected (stats.clean above), so the
    // filter must match both too — otherwise "Clean (12)" opens a grid of 8.
    if (statusFilter === 'clean') {
      return rooms.filter(r => (r.status === 'clean' || r.status === 'inspected') && !isNeutralRoom(r));
    }
    return rooms.filter(r => r.status === statusFilter && !isNeutralRoom(r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, statusFilter, roomStatusLearning, connPending]);

  const roomsByFloor = useMemo(() => groupRoomsByFloor(filteredRooms), [filteredRooms]);

  /* ── AI insight line ── */
  const aiInsight = useMemo(() => {
    if (rooms.length === 0) return lang === 'es' ? 'Cargando datos de habitaciones...' : 'Loading room data...';
    // Never declare "all clean" / "N need attention" off statuses that are
    // still being learned from the PMS — say so instead.
    if (connPending) {
      return lang === 'es'
        ? 'Conectando con tu PMS — los datos en vivo aparecerán cuando termine la primera sincronización.'
        : 'Connecting to your PMS — live data will appear once the first sync lands.';
    }
    if (roomStatusLearning) {
      return lang === 'es'
        ? 'Aún aprendiendo los estados de habitaciones de tu PMS — los conteos reflejan solo cambios hechos en la app.'
        : 'Still learning room statuses from your PMS — counts reflect in-app updates only.';
    }
    if (stats.dirty === 0 && stats.inProgress === 0) {
      return lang === 'es'
        ? `Todas las ${stats.total} habitaciones están listas. Jornada tranquila.`
        : `All ${stats.total} rooms are clean. Smooth day ahead.`;
    }
    if (stats.dirty > 5) {
      return lang === 'es'
        ? `${stats.dirty} habitaciones necesitan atención. ${stats.checkouts} salidas pendientes.`
        : `${stats.dirty} rooms need attention. ${stats.checkouts} checkouts pending.`;
    }
    return lang === 'es'
      ? `${stats.clean} listas, ${stats.dirty} pendientes, ${stats.inProgress} en proceso. ${stats.cleanPct}% completo.`
      : `${stats.clean} ready, ${stats.dirty} pending, ${stats.inProgress} in progress. ${stats.cleanPct}% complete.`;
  }, [rooms, stats, lang, roomStatusLearning, connPending]);

  /* ── Handlers ── */
  const handleEarlyCheckout = async () => {
    if (!selectedRoom || !user || !activePropertyId) return;
    setProcessing(true);
    try {
      await updateRoom(user.uid, activePropertyId, selectedRoom.id, { type: 'checkout' });
      setSelectedRoom(null);
      showToast(lang === 'es'
        ? `Habitación ${selectedRoom.number} marcada como Salida Anticipada`
        : `Room ${selectedRoom.number} marked as Early Checkout`);
    } catch (error) {
      console.error('Error marking early checkout:', error);
      showToast(lang === 'es' ? 'Error al procesar' : 'Error processing request');
    } finally { setProcessing(false); }
  };

  const handleExtension = async () => {
    if (!selectedRoom || !user || !activePropertyId) return;
    setProcessing(true);
    try {
      await updateRoom(user.uid, activePropertyId, selectedRoom.id, { type: 'stayover' });
      setSelectedRoom(null);
      showToast(lang === 'es'
        ? `Habitación ${selectedRoom.number} marcada como Extensión`
        : `Room ${selectedRoom.number} marked as Extension`);
    } catch (error) {
      console.error('Error marking extension:', error);
      showToast(lang === 'es' ? 'Error al procesar' : 'Error processing request');
    } finally { setProcessing(false); }
  };

  /* ── Loading state ── */
  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: '#fbf9f4' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: '32px', height: '32px', border: '3px solid #d5d2ca', borderTopColor: '#364262', borderRadius: '50%', margin: '0 auto 12px', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ fontSize: '14px', fontWeight: 500, color: '#757684', fontFamily: 'Inter, sans-serif' }}>
              {lang === 'es' ? 'Cargando habitaciones...' : 'Loading rooms...'}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  /* ── Filter pills data ── */
  const filters = [
    { key: 'all', label: lang === 'es' ? 'Todas' : 'All', count: rooms.length },
    { key: 'dirty', label: lang === 'es' ? 'Sucias' : 'Dirty', count: stats.dirty },
    { key: 'in_progress', label: lang === 'es' ? 'Limpiando' : 'Cleaning', count: stats.inProgress },
    { key: 'clean', label: lang === 'es' ? 'Limpias' : 'Clean', count: stats.clean },
    { key: 'checkout', label: lang === 'es' ? 'Salidas' : 'Checkouts', count: stats.checkouts },
    { key: 'stayover', label: lang === 'es' ? 'Continuaciones' : 'Stayovers', count: stats.stayovers },
  ];

  /* ════════════════════════════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════════════════════════════ */

  return (
    <AppLayout>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .fd-room-card { transition: all 0.15s; cursor: pointer; }
        .fd-room-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px -4px rgba(27,28,25,0.1); }
        .fd-room-card:active { transform: scale(0.97); }
        .fd-filter-pill { transition: all 0.15s; }
        .fd-filter-pill:hover { background: rgba(54,66,98,0.06); }
      `}</style>

      <FrontDeskTabBar tab={tab} onTab={setTab} lang={lang} showLostFound={canLostFound} showComplaints={canComplaints} showPackages={canPackages} />

      {tab === 'packages' && canPackages && activePropertyId && (
        <PackagesTab pid={activePropertyId} lang={lang} />
      )}

      {tab === 'lost-and-found' && canLostFound && activePropertyId && (
        <LostFoundTab pid={activePropertyId} lang={lang} />
      )}

      {tab === 'complaints' && canComplaints && (
        <ComplaintsTab />
      )}

      {tab === 'rooms' && (
      <div style={{ minHeight: '100dvh', background: '#fbf9f4' }}>

        {/* ── Stitch Hero Section ── */}
        <div style={{ padding: '28px 28px 0', maxWidth: '1200px', margin: '0 auto' }}>
          <div className="animate-in" style={{ marginBottom: '8px' }}>
            <h1 style={{
              fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '32px',
              letterSpacing: '-0.02em', color: '#1b1c19', margin: 0, lineHeight: 1.2,
            }}>
              {lang === 'es' ? 'Recepción' : 'Front Desk'}
            </h1>
            <p style={{
              margin: '6px 0 0', fontSize: '15px', color: '#757684',
              fontFamily: 'Inter, sans-serif', lineHeight: 1.4,
            }}>
              {activeProperty?.name ?? ''} · {new Date().toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
            </p>
          </div>

          {/* feat/cua-partial-promotion — honesty strips. One banner at a
              time: pending > paused > feed-level. */}
          {connPending && (
            <div style={{ margin: '20px 0 0' }}>
              <FeedLearningBanner
                variant="strip"
                title={lang === 'es' ? 'Conectando con tu PMS.' : 'Connecting to your PMS.'}
                text={lang === 'es'
                  ? 'Los datos en vivo aparecerán cuando termine la primera sincronización.'
                  : 'Live data will appear once the first sync lands.'}
              />
            </div>
          )}
          {!connPending && connPaused && (
            <div style={{ margin: '20px 0 0' }}>
              <FeedLearningBanner
                variant="strip"
                title={lang === 'es' ? 'Conexión con el PMS en pausa.' : 'PMS connection paused.'}
                text={lang === 'es'
                  ? 'Los datos pueden estar desactualizados hasta que se reanude.'
                  : 'Data may be out of date until it resumes.'}
              />
            </div>
          )}
          {!connPending && !connPaused && (roomStatusLearning || reservationsLearning) && (
            <div style={{ margin: '20px 0 0' }}>
              <FeedLearningBanner
                variant="strip"
                title={lang === 'es' ? 'Aún aprendiendo tu PMS.' : 'Still learning your PMS.'}
                text={[
                  roomStatusLearning
                    ? (lang === 'es'
                      ? 'Los estados de habitaciones del PMS todavía no llegan — las habitaciones “Sin datos” no tienen información todavía.'
                      : 'Room statuses from the PMS aren’t flowing yet — “No data” rooms have no information yet.')
                    : '',
                  reservationsLearning
                    ? (lang === 'es'
                      ? 'Las llegadas/salidas del PMS aún se están aprendiendo — los conteos de salidas y estancias pueden estar incompletos.'
                      : 'PMS arrivals/departures are still being learned — checkout and stayover counts may be incomplete.')
                    : '',
                ].filter(Boolean).join(' ')}
              />
            </div>
          )}

          {/* ── AI Insight Card ── */}
          <div style={{
            margin: '20px 0 24px',
            padding: '20px 24px',
            background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
            border: '1px solid #d5d2ca', borderRadius: '24px',
            display: 'flex', alignItems: 'flex-start', gap: '14px',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '24px', color: '#006565', flexShrink: 0, marginTop: '1px' }}>
              concierge
            </span>
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#006565', fontFamily: 'Inter, sans-serif', marginBottom: '4px' }}>
                {lang === 'es' ? 'Resumen de Recepción' : 'AI Concierge Insight'}
              </p>
              <p style={{ margin: 0, fontSize: '15px', color: '#1b1c19', fontFamily: 'Inter, sans-serif', lineHeight: 1.5 }}>
                {aiInsight}
              </p>
            </div>
          </div>

          {/* ── Key Stats Bar ── */}
          {/* Review pass: '—' for stats whose source feed is untrusted —
              "Ready 0%" with every room unknown, or "Checkouts 0" while the
              reservation feeds are learning, are confident wrong claims. */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
            {[
              { label: lang === 'es' ? 'Total' : 'Rooms', value: stats.total as React.ReactNode, icon: 'meeting_room', color: '#364262' },
              { label: lang === 'es' ? 'Listas' : 'Ready', value: (stats.total - stats.unknown) > 0 ? `${stats.cleanPct}%` : '—', icon: 'check_circle', color: '#006565' },
              { label: lang === 'es' ? 'Salidas' : 'Checkouts', value: reservationsLearning ? '—' : stats.checkouts, icon: 'logout', color: '#454652' },
              { label: lang === 'es' ? 'No Molestar' : 'DND', value: stats.dndCount, icon: 'do_not_disturb_on', color: stats.dndCount > 0 ? '#ba1a1a' : '#757684' },
            ].map(({ label, value, icon, color }) => (
              <div key={label} style={{
                flex: '1 1 120px', padding: '14px 18px',
                background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                border: '1px solid #d5d2ca', borderRadius: '20px',
                display: 'flex', alignItems: 'center', gap: '12px',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '22px', color }}>{icon}</span>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '20px', fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
                  <div style={{ fontSize: '11px', fontWeight: 500, color: '#757684', marginTop: '2px', fontFamily: 'Inter, sans-serif' }}>{label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* ── Filter Pills ── */}
          <div style={{
            display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px',
            marginBottom: '24px', scrollbarWidth: 'none',
          }}>
            {filters.map(f => {
              const isActive = statusFilter === f.key;
              if (f.key !== 'all' && f.count === 0) return null;
              return (
                <button
                  key={f.key}
                  className="fd-filter-pill"
                  onClick={() => setStatusFilter(f.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '8px 16px', borderRadius: '9999px', whiteSpace: 'nowrap',
                    border: isActive ? '1px solid #364262' : '1px solid #d5d2ca',
                    background: isActive ? '#364262' : 'rgba(255,255,255,0.7)',
                    backdropFilter: isActive ? 'none' : 'blur(24px)',
                    color: isActive ? '#FFFFFF' : '#454652',
                    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'Inter, sans-serif', flexShrink: 0,
                  }}
                >
                  {f.label}
                  <span style={{
                    fontSize: '11px', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                    background: isActive ? 'rgba(255,255,255,0.2)' : '#eae8e3',
                    borderRadius: '9999px', padding: '1px 8px',
                  }}>
                    {f.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Room Grid by Floor ── */}
        <div style={{ padding: '0 28px 120px', maxWidth: '1200px', margin: '0 auto' }}>
          {filteredRooms.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '64px 16px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '48px', color: '#757684', display: 'block', marginBottom: '12px' }}>
                {statusFilter === 'all' ? 'bedroom_parent' : 'filter_alt_off'}
              </span>
              <p style={{ color: '#757684', fontSize: '15px', margin: 0, fontFamily: 'Inter, sans-serif' }}>
                {statusFilter === 'all'
                  ? (lang === 'es' ? 'No hay habitaciones todavía' : 'No rooms yet')
                  : (lang === 'es' ? 'No hay habitaciones con este filtro' : 'No rooms match this filter')
                }
              </p>
            </div>
          ) : (
            Object.entries(roomsByFloor).map(([floor, floorRooms]) => (
              <div key={floor} style={{ marginBottom: '28px' }}>
                {/* Floor header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  marginBottom: '14px', padding: '0 4px',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#364262' }}>layers</span>
                  <span style={{
                    fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '15px',
                    color: '#1b1c19', letterSpacing: '-0.01em',
                  }}>
                    {t('floor', lang)} {floor}
                  </span>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: 600,
                    color: '#757684', background: '#eae8e3', borderRadius: '9999px', padding: '2px 10px',
                  }}>
                    {floorRooms.length}
                  </span>
                </div>

                {/* Room cards grid */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: '12px',
                }}>
                  {floorRooms.map(room => {
                    const neutral = isNeutralRoom(room);
                    const statusCol = neutral ? '#757684' : getStatusColor(room.status);
                    return (
                      <div
                        key={room.id}
                        className="fd-room-card"
                        onClick={() => setSelectedRoom(room)}
                        style={{
                          position: 'relative',
                          padding: '16px',
                          borderRadius: '20px',
                          background: 'rgba(255,255,255,0.8)',
                          backdropFilter: 'blur(24px)',
                          border: '1px solid #d5d2ca',
                          display: 'flex', flexDirection: 'column', alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        {/* DND badge */}
                        {room.isDnd && (
                          <div style={{
                            position: 'absolute', top: '8px', right: '8px',
                          }}>
                            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#ba1a1a' }}>
                              do_not_disturb_on
                            </span>
                          </div>
                        )}

                        {/* Priority badge */}
                        {room.priority === 'vip' && (
                          <div style={{
                            position: 'absolute', top: '8px', left: '8px',
                          }}>
                            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#006565' }}>
                              star
                            </span>
                          </div>
                        )}
                        {room.priority === 'early' && (
                          <div style={{
                            position: 'absolute', top: '8px', left: '8px',
                          }}>
                            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#364262' }}>
                              schedule
                            </span>
                          </div>
                        )}

                        {/* Room number */}
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '28px', fontWeight: 800, letterSpacing: '-0.02em',
                          color: '#1b1c19', lineHeight: 1,
                        }}>
                          {room.number}
                        </div>

                        {/* Status pill — neutral gray "No data" while the
                            room-status feed is still being learned */}
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '4px',
                          padding: '4px 10px', borderRadius: '9999px',
                          background: neutral ? 'rgba(117,118,132,0.10)' : getStatusBg(room.status),
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '13px', color: statusCol }}>
                            {neutral ? 'hourglass_empty' : getStatusIcon(room.status)}
                          </span>
                          <span style={{
                            fontSize: '11px', fontWeight: 600, color: statusCol,
                            fontFamily: 'Inter, sans-serif', textTransform: 'uppercase',
                            letterSpacing: '0.03em',
                          }}>
                            {neutral ? (lang === 'es' ? 'Sin datos' : 'No data') : getStatusLabel(room.status, lang)}
                          </span>
                        </div>

                        {/* Type label */}
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '4px',
                          fontSize: '11px', color: '#757684', fontFamily: 'Inter, sans-serif',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>
                            {getTypeIcon(room.type)}
                          </span>
                          {getTypeLabel(room.type, lang)}
                        </div>

                        {/* Assigned */}
                        {room.assignedName && (
                          <div style={{
                            fontSize: '11px', color: '#454652', fontFamily: 'Inter, sans-serif',
                            fontWeight: 500, maxWidth: '100%', overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {room.assignedName}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Stitch Toast ── */}
        <ToastHost
          toasts={toasts}
          position="top"
          offset="24px"
          zIndex={1100}
          toastStyle={{
            padding: '14px 24px', borderRadius: '9999px',
            background: '#006565', color: '#FFFFFF',
            fontWeight: 600, fontSize: '14px', fontFamily: 'Inter, sans-serif',
            boxShadow: '0 12px 32px rgba(0,101,101,0.25)',
            animation: 'fadeIn 0.2s ease-out',
            alignItems: 'center', gap: '8px',
          }}
          renderIcon={() => (
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
          )}
        />

        {/* ── Stitch Room Detail Modal ── */}
        {selectedRoom && (
          <>
            {/* Backdrop */}
            <div
              onClick={() => setSelectedRoom(null)}
              style={{
                position: 'fixed', inset: 0, zIndex: 1000,
                background: 'rgba(27,28,25,0.4)', backdropFilter: 'blur(8px)',
                animation: 'fadeIn 0.2s ease-out',
              }}
            />

            {/* Bottom sheet */}
            <div style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1001,
              background: '#fbf9f4', borderRadius: '32px 32px 0 0',
              padding: '16px 24px 28px', maxHeight: '75vh', overflowY: 'auto',
              boxShadow: '0 -16px 48px rgba(0,0,0,0.12)',
              animation: 'slideUp 0.3s ease-out',
            }}>
              {/* Drag handle */}
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                <div style={{ width: '40px', height: '4px', borderRadius: '9999px', background: '#d5d2ca' }} />
              </div>

              {/* Room header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
                <div style={{
                  width: '56px', height: '56px', borderRadius: '16px',
                  background: getStatusBg(selectedRoom.status),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '22px', fontWeight: 800, color: getStatusColor(selectedRoom.status),
                  }}>
                    {selectedRoom.number}
                  </span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: '20px',
                      color: '#1b1c19',
                    }}>
                      {lang === 'es' ? 'Habitación' : 'Room'} {selectedRoom.number}
                    </span>
                    {selectedRoom.isDnd && (
                      <span style={{
                        fontSize: '11px', fontWeight: 600, color: '#ba1a1a',
                        background: 'rgba(186,26,26,0.08)', borderRadius: '9999px',
                        padding: '3px 10px', fontFamily: 'Inter, sans-serif',
                      }}>
                        DND
                      </span>
                    )}
                    {selectedRoom.priority === 'vip' && (
                      <span style={{
                        fontSize: '11px', fontWeight: 600, color: '#006565',
                        background: 'rgba(0,101,101,0.08)', borderRadius: '9999px',
                        padding: '3px 10px', fontFamily: 'Inter, sans-serif',
                      }}>
                        VIP
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                    <span style={{
                      display: 'flex', alignItems: 'center', gap: '4px',
                      fontSize: '13px', fontWeight: 600, color: getStatusColor(selectedRoom.status),
                      fontFamily: 'Inter, sans-serif',
                    }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                        {getStatusIcon(selectedRoom.status)}
                      </span>
                      {getStatusLabel(selectedRoom.status, lang)}
                    </span>
                    <span style={{ color: '#d5d2ca' }}>·</span>
                    <span style={{
                      display: 'flex', alignItems: 'center', gap: '4px',
                      fontSize: '13px', color: '#757684', fontFamily: 'Inter, sans-serif',
                    }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                        {getTypeIcon(selectedRoom.type)}
                      </span>
                      {getTypeLabel(selectedRoom.type, lang)}
                    </span>
                  </div>
                </div>
                <button onClick={() => setSelectedRoom(null)} style={{
                  background: '#eae8e3', border: 'none', borderRadius: '50%',
                  width: '36px', height: '36px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#454652' }}>close</span>
                </button>
              </div>

              {/* Info cards */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
                {selectedRoom.assignedName && (
                  <div style={{
                    flex: '1 1 140px', padding: '14px 16px',
                    background: '#eae8e3', borderRadius: '16px',
                  }}>
                    <p style={{ margin: 0, fontSize: '11px', fontWeight: 600, color: '#757684', fontFamily: 'Inter, sans-serif', marginBottom: '4px' }}>
                      {lang === 'es' ? 'Asignada a' : 'Assigned to'}
                    </p>
                    <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                      {selectedRoom.assignedName}
                    </p>
                  </div>
                )}
                {selectedRoom.issueNote && (
                  <div style={{
                    flex: '1 1 200px', padding: '14px 16px',
                    background: 'rgba(186,26,26,0.06)', borderRadius: '16px',
                    border: '1px solid rgba(186,26,26,0.15)',
                  }}>
                    <p style={{ margin: 0, fontSize: '11px', fontWeight: 600, color: '#ba1a1a', fontFamily: 'Inter, sans-serif', marginBottom: '4px' }}>
                      {lang === 'es' ? 'Problema Reportado' : 'Reported Issue'}
                    </p>
                    <p style={{ margin: 0, fontSize: '14px', color: '#1b1c19', fontFamily: 'Inter, sans-serif' }}>
                      {selectedRoom.issueNote}
                    </p>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '12px' }}>
                {selectedRoom.type === 'stayover' && (
                  <button
                    onClick={handleEarlyCheckout}
                    disabled={processing}
                    style={{
                      flex: 1, padding: '16px',
                      background: processing ? 'rgba(54,66,98,0.4)' : '#364262',
                      color: '#FFFFFF', border: 'none', borderRadius: '9999px',
                      fontWeight: 600, fontSize: '15px', cursor: processing ? 'not-allowed' : 'pointer',
                      fontFamily: 'Inter, sans-serif',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>logout</span>
                    {processing
                      ? (lang === 'es' ? 'Procesando...' : 'Processing...')
                      : (lang === 'es' ? 'Salida Anticipada' : 'Early Checkout')
                    }
                  </button>
                )}

                {selectedRoom.type === 'checkout' && (
                  <button
                    onClick={handleExtension}
                    disabled={processing}
                    style={{
                      flex: 1, padding: '16px',
                      background: processing ? 'rgba(0,101,101,0.4)' : '#006565',
                      color: '#FFFFFF', border: 'none', borderRadius: '9999px',
                      fontWeight: 600, fontSize: '15px', cursor: processing ? 'not-allowed' : 'pointer',
                      fontFamily: 'Inter, sans-serif',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>hotel</span>
                    {processing
                      ? (lang === 'es' ? 'Procesando...' : 'Processing...')
                      : (lang === 'es' ? 'Marcar Extensión' : 'Mark Extension')
                    }
                  </button>
                )}

                <RushButton
                  roomNumber={selectedRoom.number}
                  isAlreadyRush={!!selectedRoom.isRush}
                  onChange={({ cleared }) => {
                    // Reflect the confirmed set/clear immediately — the label
                    // flips to "Clear rush" without waiting for the next poll.
                    setSelectedRoom(prev => (prev ? { ...prev, isRush: !cleared } : prev));
                  }}
                />

                <button
                  onClick={() => setSelectedRoom(null)}
                  style={{
                    padding: '16px 24px',
                    background: 'transparent', border: '1px solid #d5d2ca',
                    color: '#454652', borderRadius: '9999px',
                    fontWeight: 600, fontSize: '15px', cursor: 'pointer',
                    fontFamily: 'Inter, sans-serif',
                  }}
                >
                  {lang === 'es' ? 'Cerrar' : 'Close'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}
    </AppLayout>
  );
}
