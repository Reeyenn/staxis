'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, updateRoom } from '@/lib/firestore';
import { useSyncContext } from '@/contexts/SyncContext';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus } from '@/types';
import { format } from 'date-fns';

function getFloor(roomNumber: string): string {
  const cleaned = roomNumber.replace(/\D/g, '');
  const num = parseInt(cleaned);
  if (isNaN(num)) return '?';
  if (num < 100) return 'G';
  return String(Math.floor(num / 100));
}

const ACTION_COLOR: Record<RoomStatus, { bg: string; border: string; color: string }> = {
  dirty:       { bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.5)',  color: '#D97706' },
  in_progress: { bg: 'rgba(34,197,94,0.15)',   border: 'rgba(34,197,94,0.5)',   color: '#16A34A' },
  clean:       { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.35)',  color: '#DC2626' },
  inspected:   { bg: 'rgba(139,92,246,0.10)',  border: 'rgba(139,92,246,0.3)',  color: '#7C3AED' },
};

export default function HousekeepingPage() {
  const { user }                               = useAuth();
  const { activePropertyId, activeProperty }   = useProperty();
  const { lang }                               = useLang();
  const { recordOfflineAction }                = useSyncContext();

  const [rooms,         setRooms]         = useState<Room[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [selectedFloor, setSelectedFloor] = useState<string>('all');

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToRooms(user.uid, activePropertyId, todayStr(), (r) => {
      setRooms(r);
      setLoading(false);
    });
    return unsub;
  }, [user, activePropertyId]);

  /* ── Derived data ── */
  const floors = [...new Set(rooms.map(r => getFloor(r.number)))].sort((a, b) => {
    if (a === 'G') return -1;
    if (b === 'G') return 1;
    return parseInt(a) - parseInt(b);
  });

  const filtered = selectedFloor === 'all'
    ? rooms
    : rooms.filter(r => getFloor(r.number) === selectedFloor);

  const sorted = [...filtered].sort((a, b) => {
    const na = parseInt(a.number.replace(/\D/g, '')) || 0;
    const nb = parseInt(b.number.replace(/\D/g, '')) || 0;
    return na - nb;
  });

  const doneCount  = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const totalCount = rooms.length;
  const pct        = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  /* ── Status info (translated) ── */
  const STATUS_INFO: Record<RoomStatus, { label: string; color: string; bgColor: string; borderColor: string }> = {
    dirty:       { label: t('dirty', lang),            color: '#EF4444', bgColor: 'rgba(239,68,68,0.08)',   borderColor: 'rgba(239,68,68,0.25)'   },
    in_progress: { label: t('cleaning', lang),         color: '#FBBF24', bgColor: 'rgba(251,191,36,0.08)',  borderColor: 'rgba(251,191,36,0.25)'  },
    clean:       { label: t('clean', lang) + ' ✓',    color: '#22C55E', bgColor: 'rgba(34,197,94,0.08)',   borderColor: 'rgba(34,197,94,0.25)'   },
    inspected:   { label: t('approved', lang),         color: '#8B5CF6', bgColor: 'rgba(139,92,246,0.08)',  borderColor: 'rgba(139,92,246,0.25)'  },
  };

  const ACTION_LABEL: Record<RoomStatus, string> = {
    dirty:       t('start', lang),
    in_progress: t('done', lang) + ' ✓',
    clean:       t('reset', lang),
    inspected:   t('locked', lang),
  };

  /* ── Status cycling ── */
  const handleToggle = async (room: Room) => {
    if (!user || !activePropertyId || room.status === 'inspected') return;
    let newStatus: RoomStatus;
    if (room.status === 'dirty')            newStatus = 'in_progress';
    else if (room.status === 'in_progress') newStatus = 'clean';
    else                                    newStatus = 'dirty'; // reset clean → dirty

    const updates: Partial<Room> = { status: newStatus };
    if (newStatus === 'in_progress') updates.startedAt  = new Date();
    if (newStatus === 'clean')       updates.completedAt = new Date();
    // With Firestore offline persistence enabled, this write is applied
    // optimistically to the local cache and queued for sync when online.
    if (!navigator.onLine) recordOfflineAction();
    await updateRoom(user.uid, activePropertyId, room.id, updates);
  };

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* ── Header ── */}
        <div className="animate-in">
          {activeProperty && (
            <p style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>
              {activeProperty.name}
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '26px', color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              {t('housekeeping', lang)}
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>
              {format(new Date(), 'EEE, MMM d')}
            </p>
          </div>
        </div>

        {/* ── Progress bar ── */}
        {totalCount > 0 && (
          <div className="animate-in stagger-1" style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('todaysProgress', lang)}</span>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#22C55E', fontFamily: 'var(--font-mono)' }}>
                {pct}% &nbsp;<span style={{ fontWeight: 500, color: 'var(--text-muted)', fontSize: '12px' }}>({doneCount}/{totalCount})</span>
              </span>
            </div>
            <div style={{ height: '10px', borderRadius: '5px', background: 'var(--border)' }}>
              <div style={{
                height: '100%', borderRadius: '5px',
                background: pct === 100 ? '#8B5CF6' : '#22C55E',
                width: `${pct}%`, transition: 'width 400ms ease',
              }} />
            </div>
            {/* Status counts */}
            <div style={{ display: 'flex', gap: '12px', marginTop: '10px', flexWrap: 'wrap' }}>
              {(['dirty', 'in_progress', 'clean', 'inspected'] as RoomStatus[]).map(s => {
                const cnt = rooms.filter(r => r.status === s).length;
                if (cnt === 0) return null;
                const info = STATUS_INFO[s];
                return (
                  <span key={s} style={{ fontSize: '11px', fontWeight: 600, color: info.color }}>
                    {cnt} {info.label}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Floor filter pills ── */}
        {floors.length > 1 && (
          <div className="animate-in stagger-1" style={{
            display: 'flex', gap: '8px', overflowX: 'auto',
            paddingBottom: '4px', flexWrap: 'nowrap',
          }}>
            {['all', ...floors].map(floor => {
              const floorRooms = floor === 'all' ? rooms : rooms.filter(r => getFloor(r.number) === floor);
              const floorDone  = floorRooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
              const isActive   = selectedFloor === floor;
              return (
                <button
                  key={floor}
                  onClick={() => setSelectedFloor(floor)}
                  style={{
                    padding: '9px 16px', borderRadius: '100px', flexShrink: 0,
                    border: `1.5px solid ${isActive ? 'var(--amber-border)' : 'var(--border)'}`,
                    background: isActive ? 'var(--amber-dim)' : 'var(--bg-card)',
                    color: isActive ? 'var(--amber)' : 'var(--text-secondary)',
                    fontWeight: isActive ? 700 : 500, fontSize: '13px',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-sans)', transition: 'all 120ms',
                  }}
                >
                  {floor === 'all' ? t('all', lang) : `${t('floor', lang)} ${floor}`}
                  {' '}
                  <span style={{ fontSize: '11px', opacity: 0.7 }}>
                    {floorDone}/{floorRooms.length}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* ── Room list ── */}
        {loading ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', textAlign: 'center', padding: '48px 0' }}>
            {t('loading', lang)}
          </p>
        ) : sorted.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '52px 20px',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
          }}>
            <p style={{ fontSize: '32px', marginBottom: '12px' }}>🛏️</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>
              {rooms.length === 0
                ? t('noRoomsTodayHkp', lang)
                : t('noRoomsFloor', lang)}
            </p>
          </div>
        ) : (
          <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {sorted.map(room => {
              const info   = STATUS_INFO[room.status];
              const action = ACTION_COLOR[room.status];
              const isDone = room.status === 'clean' || room.status === 'inspected';
              return (
                <div
                  key={room.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '14px 14px',
                    background: info.bgColor,
                    border: `1.5px solid ${info.borderColor}`,
                    borderRadius: 'var(--radius-md)',
                    opacity: room.status === 'inspected' ? 0.7 : 1,
                    transition: 'all 150ms',
                  }}
                >
                  {/* Room number chip */}
                  <div style={{
                    minWidth: '62px', height: '62px', borderRadius: '14px',
                    background: info.color + '18',
                    border: `2px solid ${info.color}40`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontWeight: 800,
                      fontSize: room.number.length > 3 ? '18px' : '22px',
                      color: info.color,
                    }}>
                      {room.number}
                    </span>
                  </div>

                  {/* Room info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: info.color, marginBottom: '3px' }}>
                      {info.label}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>
                      {room.type === 'checkout' ? t('checkout', lang) : room.type === 'stayover' ? t('stayover', lang) : t('vacant', lang)}
                      {room.assignedName ? ` · ${room.assignedName}` : ''}
                      {room.priority === 'vip' ? ' · ⭐ VIP' : ''}
                      {room.isDnd ? ` · 🚫 ${t('dnd', lang)}` : ''}
                    </div>
                    {isDone && room.completedAt && (
                      <div style={{ fontSize: '11px', color: '#22C55E', fontWeight: 600, marginTop: '2px' }}>
                        {t('done', lang)} {format(
                          typeof (room.completedAt as unknown as { toDate?: () => Date })?.toDate === 'function'
                            ? (room.completedAt as unknown as { toDate: () => Date }).toDate()
                            : new Date(room.completedAt as unknown as string | number),
                          'h:mm a'
                        )}
                      </div>
                    )}
                  </div>

                  {/* Big action button */}
                  <button
                    onClick={() => handleToggle(room)}
                    disabled={room.status === 'inspected'}
                    style={{
                      padding: '14px 18px', borderRadius: '12px', flexShrink: 0,
                      background: action.bg, border: `2px solid ${action.border}`,
                      color: action.color, fontWeight: 800, fontSize: '14px',
                      cursor: room.status === 'inspected' ? 'default' : 'pointer',
                      fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
                      transition: 'all 120ms',
                      minWidth: '80px', textAlign: 'center',
                    }}
                  >
                    {ACTION_LABEL[room.status]}
                  </button>
                </div>
              );
            })}
          </div>
        )}

      </div>
    </AppLayout>
  );
}
