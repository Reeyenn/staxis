'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { subscribeToRooms } from '@/lib/firestore';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus, RoomType } from '@/types';
import { format } from 'date-fns';
import { BedDouble, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import Link from 'next/link';

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_STYLES: Record<RoomStatus, { bg: string; border: string; color: string; glow: string }> = {
  dirty:       { bg: 'rgba(239,68,68,0.13)',   border: 'rgba(239,68,68,0.35)',   color: '#EF4444', glow: 'rgba(239,68,68,0.08)'  },
  in_progress: { bg: 'rgba(251,191,36,0.13)',  border: 'rgba(251,191,36,0.35)',  color: '#FBBF24', glow: 'rgba(251,191,36,0.08)' },
  clean:       { bg: 'rgba(34,197,94,0.13)',   border: 'rgba(34,197,94,0.35)',   color: '#22C55E', glow: 'rgba(34,197,94,0.08)'  },
  inspected:   { bg: 'rgba(139,92,246,0.13)',  border: 'rgba(139,92,246,0.35)',  color: '#8B5CF6', glow: 'rgba(139,92,246,0.08)' },
};

// ── Type badge config ──────────────────────────────────────────────────────────
const TYPE_BADGE: Record<RoomType, { label: string; color: string; bg: string }> = {
  checkout: { label: 'CO', color: '#38BDF8', bg: 'rgba(56,189,248,0.12)' },
  stayover: { label: 'SO', color: '#94A3B8', bg: 'rgba(148,163,184,0.10)' },
  vacant:   { label: 'VAC', color: '#475569', bg: 'rgba(71,85,105,0.10)' },
};

// ── Floor extraction ──────────────────────────────────────────────────────────
function getFloor(roomNumber: string): string {
  const cleaned = roomNumber.replace(/\D/g, '');
  const num = parseInt(cleaned);
  if (isNaN(num)) return '?';
  if (num < 100) return 'G';
  return String(Math.floor(num / 100));
}

function sortFloors(floors: string[]): string[] {
  return floors.sort((a, b) => {
    if (a === 'G') return -1;
    if (b === 'G') return 1;
    return parseInt(a) - parseInt(b);
  });
}

// ── Live clock ────────────────────────────────────────────────────────────────
function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{format(now, 'h:mm:ss a')}</span>;
}

// ── Time-ago ──────────────────────────────────────────────────────────────────
function timeAgo(date: Date | null): string {
  if (!date) return '';
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1m ago';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ── Room tile ─────────────────────────────────────────────────────────────────
function RoomTile({ room, lang }: { room: Room; lang: 'en' | 'es' }) {
  const s = STATUS_STYLES[room.status];
  const tb = TYPE_BADGE[room.type];
  const isInProgress = room.status === 'in_progress';

  return (
    <div style={{
      background: s.bg,
      border: `1.5px solid ${room.isDnd ? 'rgba(249,115,22,0.45)' : s.border}`,
      borderRadius: 12,
      padding: '12px 10px 10px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      position: 'relative',
      minHeight: 110,
      justifyContent: 'center',
      boxShadow: `0 0 0 1px ${s.glow}`,
      transition: 'border-color 400ms',
    }}>

      {/* DND badge */}
      {room.isDnd && (
        <div style={{
          position: 'absolute', top: 5, right: 5,
          fontSize: 7, fontWeight: 800, letterSpacing: '0.04em',
          color: '#F97316', background: 'rgba(249,115,22,0.15)',
          border: '1px solid rgba(249,115,22,0.35)',
          borderRadius: 3, padding: '2px 4px',
        }}>
          {t('dnd', lang)}
        </div>
      )}

      {/* VIP star */}
      {room.priority === 'vip' && (
        <div style={{
          position: 'absolute', top: 5, left: 5,
          fontSize: 10, color: '#F59E0B',
        }}>⭐</div>
      )}

      {/* Room number */}
      <div style={{
        fontSize: 28,
        fontWeight: 900,
        color: s.color,
        fontFamily: 'var(--font-mono)',
        lineHeight: 1,
        letterSpacing: '-0.02em',
      }}>
        {room.number}
      </div>

      {/* Status label */}
      <div style={{
        fontSize: 8,
        fontWeight: 800,
        letterSpacing: '0.12em',
        color: s.color,
        textTransform: 'uppercase',
        opacity: 0.9,
      }}>
        {room.status === 'dirty' ? t('dirty', lang)
          : room.status === 'in_progress' ? t('cleaning', lang)
          : room.status === 'clean' ? t('clean', lang)
          : t('inspected', lang)}
      </div>

      {/* Type badge */}
      <div style={{
        padding: '2px 7px',
        borderRadius: 4,
        background: tb.bg,
        fontSize: 9,
        fontWeight: 700,
        color: tb.color,
        letterSpacing: '0.06em',
      }}>
        {room.type === 'checkout' ? t('co', lang)
          : room.type === 'stayover' ? t('so', lang)
          : t('vac', lang)}
      </div>

      {/* Housekeeper name */}
      {room.assignedName && (
        <div style={{
          fontSize: 9,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textAlign: 'center',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          paddingTop: 2,
        }}>
          {room.assignedName}
        </div>
      )}

      {/* In-progress timer */}
      {isInProgress && room.startedAt && (
        <div style={{ fontSize: 9, color: '#FBBF24', fontFamily: 'var(--font-mono)', opacity: 0.8 }}>
          {timeAgo(room.startedAt instanceof Date
            ? room.startedAt
            : (room.startedAt as unknown as { toDate(): Date }).toDate())}
        </div>
      )}
    </div>
  );
}

// ── Floor section ─────────────────────────────────────────────────────────────
function FloorSection({
  floor,
  rooms,
  lang,
}: {
  floor: string;
  rooms: Room[];
  lang: 'en' | 'es';
}) {
  const done  = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const total = rooms.length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const dirty = rooms.filter(r => r.status === 'dirty').length;
  const inProg = rooms.filter(r => r.status === 'in_progress').length;

  const sorted = [...rooms].sort((a, b) => {
    const na = parseInt(a.number.replace(/\D/g, '')) || 0;
    const nb = parseInt(b.number.replace(/\D/g, '')) || 0;
    return na - nb;
  });

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Floor header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 10,
        paddingBottom: 8,
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontWeight: 800,
          fontSize: 12,
          color: 'var(--amber)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          minWidth: 72,
        }}>
          {floor === 'G' ? (lang === 'es' ? 'Planta B' : 'Ground') : `${t('floor', lang)} ${floor}`}
        </div>
        {/* Mini stats */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10 }}>
          {dirty > 0 && (
            <span style={{ color: '#EF4444', fontWeight: 700 }}>{dirty} {t('dirty', lang).toLowerCase()}</span>
          )}
          {inProg > 0 && (
            <span style={{ color: '#FBBF24', fontWeight: 700 }}>{inProg} {t('cleaning', lang).toLowerCase()}</span>
          )}
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{done}/{total}</span>
        </div>
        {/* Mini progress bar */}
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border)', marginLeft: 4 }}>
          <div style={{
            height: '100%',
            borderRadius: 2,
            background: pct === 100 ? '#8B5CF6' : '#22C55E',
            width: `${pct}%`,
            transition: 'width 600ms ease',
          }} />
        </div>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          fontWeight: 700,
          color: pct === 100 ? '#8B5CF6' : 'var(--text-secondary)',
          minWidth: 34,
          textAlign: 'right',
        }}>
          {pct}%
        </span>
      </div>

      {/* Room tiles grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
        gap: 8,
      }}>
        {sorted.map(room => (
          <RoomTile key={room.id} room={room} lang={lang} />
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function WarRoomPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [rooms, setRooms]               = useState<Room[]>([]);
  const [selectedFloor, setSelectedFloor] = useState<string>('all');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Firestore subscription
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Derived data
  const allFloors = sortFloors([...new Set(rooms.map(r => getFloor(r.number)))]);

  const visibleRooms = selectedFloor === 'all'
    ? rooms
    : rooms.filter(r => getFloor(r.number) === selectedFloor);

  const visibleFloors = selectedFloor === 'all'
    ? allFloors
    : allFloors.filter(f => f === selectedFloor);

  const roomsByFloor: Record<string, Room[]> = {};
  for (const floor of visibleFloors) {
    roomsByFloor[floor] = visibleRooms.filter(r => getFloor(r.number) === floor);
  }

  // Overall stats
  const total      = rooms.length;
  const dirty      = rooms.filter(r => r.status === 'dirty').length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const clean      = rooms.filter(r => r.status === 'clean').length;
  const inspected  = rooms.filter(r => r.status === 'inspected').length;
  const done       = clean + inspected;
  const pct        = total > 0 ? Math.round((done / total) * 100) : 0;

  // PMS last sync
  const lastSync = activeProperty?.lastSyncedAt
    ? (activeProperty.lastSyncedAt instanceof Date
        ? activeProperty.lastSyncedAt
        : (activeProperty.lastSyncedAt as unknown as { toDate(): Date }).toDate())
    : null;

  if (authLoading || propLoading) {
    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-sans)',
      }}>
        {t('loading', lang)}
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh',
      maxHeight: '100dvh',
      background: 'var(--bg)',
      fontFamily: 'var(--font-sans)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
        background: 'rgba(10,10,10,0.95)',
        backdropFilter: 'blur(16px)',
      }}>

        {/* Branding */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            background: 'var(--amber-dim)', border: '1px solid var(--amber-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <BedDouble size={15} color="var(--amber)" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
              {activeProperty?.name ?? 'HotelOps AI'}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>
              {t('warRoom', lang)}
            </div>
          </div>
        </div>

        {/* Status pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', flex: 1, justifyContent: 'center' }}>
          {([
            { key: 'dirty',      count: dirty,      color: '#EF4444', dim: 'rgba(239,68,68,0.10)'   },
            { key: 'inProgress', count: inProgress, color: '#FBBF24', dim: 'rgba(251,191,36,0.10)'  },
            { key: 'clean',      count: clean,      color: '#22C55E', dim: 'rgba(34,197,94,0.10)'   },
            { key: 'inspected',  count: inspected,  color: '#8B5CF6', dim: 'rgba(139,92,246,0.10)'  },
          ] as const).map(({ key, count, color, dim }) => (
            <div key={key} style={{
              padding: '5px 10px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6,
              background: count > 0 ? dim : 'var(--bg-card)',
              border: `1px solid ${count > 0 ? color + '44' : 'var(--border)'}`,
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: count > 0 ? color : 'var(--text-muted)', flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.08em' }}>
                {key === 'inProgress' ? t('cleaning', lang).toUpperCase() : t(key as 'dirty' | 'clean' | 'inspected', lang).toUpperCase()}
              </span>
              <span style={{ fontSize: 16, fontWeight: 800, color: count > 0 ? color : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {count}
              </span>
            </div>
          ))}
        </div>

        {/* Right: completion + sync + clock + controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>

          {/* Completion */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '4px 12px', borderRadius: 8,
            background: pct === 100 ? 'rgba(34,197,94,0.10)' : 'var(--bg-card)',
            border: `1px solid ${pct === 100 ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
          }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: pct === 100 ? '#22C55E' : 'var(--amber)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
              {pct}%
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
              {done}/{total} {t('done', lang).toUpperCase()}
            </span>
          </div>

          {/* PMS sync */}
          {activeProperty?.pmsConnected && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 6,
              background: lastSync ? 'rgba(34,197,94,0.07)' : 'var(--bg-card)',
              border: `1px solid ${lastSync ? 'rgba(34,197,94,0.2)' : 'var(--border)'}`,
            }}>
              <RefreshCw size={10} color={lastSync ? '#22C55E' : 'var(--text-muted)'} />
              <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>
                <div style={{ fontWeight: 700, color: lastSync ? '#22C55E' : 'var(--text-muted)', letterSpacing: '0.06em' }}>
                  {t('pmsSync', lang)}
                </div>
                <div>{lastSync ? timeAgo(lastSync) : t('neverSynced', lang)}</div>
              </div>
            </div>
          )}

          {/* Clock */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              <LiveClock />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
              {format(new Date(), 'EEE, MMM d')}
            </div>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', gap: 5 }}>
            <button
              onClick={toggleFullscreen}
              style={{
                width: 30, height: 30, borderRadius: 6,
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: 'var(--text-muted)',
              }}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <Link href="/dashboard" style={{
              width: 30, height: 30, borderRadius: 6,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              textDecoration: 'none', color: 'var(--text-muted)', fontSize: 14,
            }}>
              ←
            </Link>
          </div>
        </div>
      </div>

      {/* ── Floor filter pills ────────────────────────────────────────────── */}
      {allFloors.length > 1 && (
        <div style={{
          display: 'flex',
          gap: 6,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          overflowX: 'auto',
          background: 'rgba(10,10,10,0.7)',
        }}>
          {(['all', ...allFloors] as string[]).map(floor => {
            const floorRooms  = floor === 'all' ? rooms : rooms.filter(r => getFloor(r.number) === floor);
            const floorDone   = floorRooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
            const floorDirty  = floorRooms.filter(r => r.status === 'dirty').length;
            const isActive    = selectedFloor === floor;
            return (
              <button
                key={floor}
                onClick={() => setSelectedFloor(floor)}
                style={{
                  padding: '7px 14px', borderRadius: '100px', flexShrink: 0,
                  border: `1.5px solid ${isActive ? 'var(--amber-border)' : 'var(--border)'}`,
                  background: isActive ? 'var(--amber-dim)' : 'var(--bg-card)',
                  color: isActive ? 'var(--amber)' : 'var(--text-secondary)',
                  fontWeight: isActive ? 700 : 500, fontSize: 12,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-sans)', transition: 'all 120ms',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {floor === 'all'
                  ? t('all', lang)
                  : floor === 'G'
                    ? (lang === 'es' ? 'Planta B' : 'Ground')
                    : `${t('floor', lang)} ${floor}`}
                {floorDirty > 0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 800, color: '#EF4444',
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)',
                    borderRadius: 3, padding: '1px 5px',
                  }}>
                    {floorDirty}
                  </span>
                )}
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
                  {floorDone}/{floorRooms.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        {rooms.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', minHeight: '50vh',
            color: 'var(--text-muted)', textAlign: 'center', gap: 12,
          }}>
            <BedDouble size={40} color="var(--text-muted)" />
            <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('noRoomsWarRoom', lang)}
            </p>
            <Link href="/rooms" style={{
              fontSize: 13, color: 'var(--amber)', fontWeight: 600, textDecoration: 'none',
              padding: '8px 16px', borderRadius: 8,
              background: 'var(--amber-dim)', border: '1px solid var(--amber-border)',
            }}>
              {lang === 'es' ? 'Ir a Habitaciones' : 'Go to Rooms'}
            </Link>
          </div>
        ) : (
          visibleFloors.map(floor => (
            <FloorSection
              key={floor}
              floor={floor}
              rooms={roomsByFloor[floor] ?? []}
              lang={lang}
            />
          ))
        )}
      </div>

      {/* ── Bottom progress bar ───────────────────────────────────────────── */}
      {total > 0 && (
        <div style={{ height: 4, background: 'var(--border)', flexShrink: 0 }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: pct === 100 ? '#8B5CF6' : 'var(--amber)',
            transition: 'width 0.8s ease',
            borderRadius: '0 2px 2px 0',
          }} />
        </div>
      )}
    </div>
  );
}
