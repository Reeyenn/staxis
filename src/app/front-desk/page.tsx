'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, updateRoom } from '@/lib/firestore';
import { todayStr } from '@/lib/utils';
import type { Room } from '@/types';

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
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Material Symbols font is loaded globally via globals.css

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  /* ── Derived stats ── */
  const stats = useMemo(() => {
    const total = rooms.length;
    const clean = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
    const dirty = rooms.filter(r => r.status === 'dirty').length;
    const inProgress = rooms.filter(r => r.status === 'in_progress').length;
    const checkouts = rooms.filter(r => r.type === 'checkout').length;
    const stayovers = rooms.filter(r => r.type === 'stayover').length;
    const dndCount = rooms.filter(r => r.isDnd).length;
    const cleanPct = total > 0 ? Math.round((clean / total) * 100) : 0;
    return { total, clean, dirty, inProgress, checkouts, stayovers, dndCount, cleanPct };
  }, [rooms]);

  /* ── Filtered rooms ── */
  const filteredRooms = useMemo(() => {
    if (statusFilter === 'all') return rooms;
    if (statusFilter === 'checkout' || statusFilter === 'stayover' || statusFilter === 'vacant') {
      return rooms.filter(r => r.type === statusFilter);
    }
    return rooms.filter(r => r.status === statusFilter);
  }, [rooms, statusFilter]);

  const roomsByFloor = useMemo(() => groupRoomsByFloor(filteredRooms), [filteredRooms]);

  /* ── AI insight line ── */
  const aiInsight = useMemo(() => {
    if (rooms.length === 0) return lang === 'es' ? 'Cargando datos de habitaciones...' : 'Loading room data...';
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
  }, [rooms, stats, lang]);

  /* ── Handlers ── */
  const handleEarlyCheckout = async () => {
    if (!selectedRoom || !user || !activePropertyId) return;
    setProcessing(true);
    try {
      await updateRoom(user.uid, activePropertyId, selectedRoom.id, { type: 'checkout' });
      setSelectedRoom(null);
      setToast(lang === 'es'
        ? `Habitación ${selectedRoom.number} marcada como Salida Anticipada`
        : `Room ${selectedRoom.number} marked as Early Checkout`);
      setTimeout(() => setToast(null), 2500);
    } catch (error) {
      console.error('Error marking early checkout:', error);
      setToast(lang === 'es' ? 'Error al procesar' : 'Error processing request');
      setTimeout(() => setToast(null), 2500);
    } finally { setProcessing(false); }
  };

  const handleExtension = async () => {
    if (!selectedRoom || !user || !activePropertyId) return;
    setProcessing(true);
    try {
      await updateRoom(user.uid, activePropertyId, selectedRoom.id, { type: 'stayover' });
      setSelectedRoom(null);
      setToast(lang === 'es'
        ? `Habitación ${selectedRoom.number} marcada como Extensión`
        : `Room ${selectedRoom.number} marked as Extension`);
      setTimeout(() => setToast(null), 2500);
    } catch (error) {
      console.error('Error marking extension:', error);
      setToast(lang === 'es' ? 'Error al procesar' : 'Error processing request');
      setTimeout(() => setToast(null), 2500);
    } finally { setProcessing(false); }
  };

  /* ── Loading state ── */
  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fbf9f4' }}>
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

      <div style={{ minHeight: '100vh', background: '#fbf9f4' }}>

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
          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
            {[
              { label: lang === 'es' ? 'Total' : 'Rooms', value: stats.total, icon: 'meeting_room', color: '#364262' },
              { label: lang === 'es' ? 'Listas' : 'Ready', value: `${stats.cleanPct}%`, icon: 'check_circle', color: '#006565' },
              { label: lang === 'es' ? 'Salidas' : 'Checkouts', value: stats.checkouts, icon: 'logout', color: '#454652' },
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
                    const statusCol = getStatusColor(room.status);
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

                        {/* Status pill */}
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '4px',
                          padding: '4px 10px', borderRadius: '9999px',
                          background: getStatusBg(room.status),
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '13px', color: statusCol }}>
                            {getStatusIcon(room.status)}
                          </span>
                          <span style={{
                            fontSize: '11px', fontWeight: 600, color: statusCol,
                            fontFamily: 'Inter, sans-serif', textTransform: 'uppercase',
                            letterSpacing: '0.03em',
                          }}>
                            {getStatusLabel(room.status, lang)}
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
        {toast && (
          <div style={{
            position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 1100, padding: '14px 24px', borderRadius: '9999px',
            background: '#006565', color: '#FFFFFF',
            fontWeight: 600, fontSize: '14px', fontFamily: 'Inter, sans-serif',
            boxShadow: '0 12px 32px rgba(0,101,101,0.25)',
            animation: 'fadeIn 0.2s ease-out',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
            {toast}
          </div>
        )}

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
                {selectedRoom.helpRequested && (
                  <div style={{
                    flex: '1 1 140px', padding: '14px 16px',
                    background: 'rgba(186,26,26,0.06)', borderRadius: '16px',
                    border: '1px solid rgba(186,26,26,0.15)',
                    display: 'flex', alignItems: 'center', gap: '10px',
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#ba1a1a' }}>sos</span>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#ba1a1a', fontFamily: 'Inter, sans-serif' }}>
                      {lang === 'es' ? 'Ayuda Solicitada' : 'Help Requested'}
                    </span>
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
    </AppLayout>
  );
}
