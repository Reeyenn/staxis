'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToRooms, subscribeToShiftConfirmations,
  getDeepCleanConfig, getDeepCleanRecords,
  subscribeToWorkOrders,
} from '@/lib/firestore';
import { getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { todayStr } from '@/lib/utils';
import type { Room, ShiftConfirmation, ConfirmationStatus, DeepCleanConfig, DeepCleanRecord, WorkOrder } from '@/types';
import { format } from 'date-fns';
import {
  CheckCircle2, XCircle, Clock, AlertTriangle,
  Users, DollarSign, Wrench,
  Sparkles, CircleDot, DoorOpen, Zap,
  BedDouble, Ban, Percent, TrendingUp, LogIn, Hotel, CalendarCheck,
  ChevronRight,
} from 'lucide-react';

/* ── Room grid helper ── */
function RoomGrid({ rooms, overdueSet }: { rooms: Room[]; overdueSet?: Set<string> }) {
  const { lang } = useLang();
  const floors = new Map<string, Room[]>();
  [...rooms]
    .sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10))
    .forEach(room => {
      const floor = room.number.length >= 3 ? room.number[0] : '1';
      if (!floors.has(floor)) floors.set(floor, []);
      floors.get(floor)!.push(room);
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {Array.from(floors.entries()).map(([floor, floorRooms]) => (
        <div key={floor}>
          {floors.size > 1 && (
            <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '6px' }}>
              {t('floor', lang)} {floor}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {floorRooms.map(room => {
              const isClean = room.status === 'clean' || room.status === 'inspected';
              const isDirty = room.status === 'dirty';
              const isProgress = room.status === 'in_progress';
              const bg = isClean ? '#DCFCE7' : isProgress ? '#FEF9C3' : '#FEE2E2';
              const border = isClean ? '#86EFAC' : isProgress ? '#FCD34D' : '#FCA5A5';
              const color = isClean ? '#16A34A' : isProgress ? '#D97706' : '#DC2626';
              return (
                <div
                  key={room.id}
                  title={`Room ${room.number} · ${room.type ?? ''} · ${room.status}`}
                  style={{
                    width: '32px', height: '28px',
                    borderRadius: '6px',
                    background: bg,
                    border: `1.5px solid ${border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '9px', fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    color,
                    position: 'relative',
                    transition: 'transform 0.1s',
                    cursor: 'default',
                    flexShrink: 0,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {room.number}
                  {isDirty && room.type === 'checkout' && (
                    <div style={{
                      position: 'absolute', top: '2px', right: '2px',
                      width: '5px', height: '5px', borderRadius: '50%',
                      background: '#DC2626',
                      border: '1px solid white',
                    }} />
                  )}
                  {overdueSet?.has(room.number) && (
                    <div style={{
                      position: 'absolute', top: '2px', left: '2px',
                      width: '5px', height: '5px', borderRadius: '50%',
                      background: '#f59e0b',
                      border: '1px solid white',
                    }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('en-CA');
}

/* ── Status badge config ── */
const STATUS_BADGE: Record<ConfirmationStatus, { bg: string; color: string; label_en: string; label_es: string; icon: React.ReactNode }> = {
  confirmed:   { bg: 'rgba(22,163,74,0.08)',  color: 'var(--green)',     label_en: 'Confirmed',   label_es: 'Confirmado',  icon: <CheckCircle2 size={13} /> },
  pending:     { bg: 'rgba(202,138,4,0.08)',   color: 'var(--yellow)',    label_en: 'Pending',     label_es: 'Pendiente',   icon: <Clock size={13} /> },
  declined:    { bg: 'rgba(220,38,38,0.08)',   color: 'var(--red)',       label_en: 'Declined',    label_es: 'Rechazado',   icon: <XCircle size={13} /> },
  no_response: { bg: 'rgba(156,163,175,0.08)', color: 'var(--text-muted)', label_en: 'No Response', label_es: 'Sin Respuesta', icon: <AlertTriangle size={13} /> },
};

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [tomorrowConfs, setTomorrowConfs] = useState<ShiftConfirmation[]>([]);
  const [dcConfig, setDcConfig] = useState<DeepCleanConfig | null>(null);
  const [dcRecords, setDcRecords] = useState<DeepCleanRecord[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);

  const [arrivals, setArrivals] = useState(0);
  const [inHouseGuests, setInHouseGuests] = useState(0);
  const [reservationCount, setReservationCount] = useState(0);
  const [adr, setAdr] = useState(0);
  const [editingField, setEditingField] = useState<string | null>(null);

  const tomorrow = addDays(todayStr(), 1);

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToShiftConfirmations(user.uid, activePropertyId, tomorrow, setTomorrowConfs);
  }, [user, activePropertyId, tomorrow]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    Promise.all([
      getDeepCleanConfig(user.uid, activePropertyId),
      getDeepCleanRecords(user.uid, activePropertyId),
    ]).then(([config, records]) => {
      setDcConfig(config);
      setDcRecords(records);
    });
  }, [user, activePropertyId]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId]);

  const openOrders = workOrders.filter(o => o.status !== 'resolved');
  const urgentOrders = openOrders.filter(o => o.severity === 'urgent');
  const blockedRooms = openOrders.filter(o => o.blockedRoom).length;

  const clean      = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const dirty      = rooms.filter(r => r.status === 'dirty').length;
  const checkouts  = rooms.filter(r => r.type === 'checkout').length;
  const stayovers  = rooms.filter(r => r.type === 'stayover').length;
  const vacant     = rooms.filter(r => r.type === 'vacant').length;
  const total      = rooms.length;
  const pct        = total > 0 ? Math.round((clean / total) * 100) : 0;

  const totalPropertyRooms = activeProperty?.totalRooms || 74;
  const rentedRooms = checkouts + stayovers;
  const occupancyPct = totalPropertyRooms > 0 ? Math.round((rentedRooms / totalPropertyRooms) * 100) : 0;
  const revpar = totalPropertyRooms > 0 && adr > 0 ? Math.round((adr * rentedRooms) / totalPropertyRooms) : 0;

  const confirmedCount = tomorrowConfs.filter(c => c.status === 'confirmed').length;

  const overdueRooms = dcConfig && dcRecords.length > 0
    ? getOverdueRooms(dcRecords.map(r => r.roomNumber), dcRecords, dcConfig)
    : [];
  const dndFreedMins = activeProperty
    ? calcDndFreedMinutes(rooms, activeProperty)
    : 0;
  const dcSuggestion = dcConfig && overdueRooms.length > 0
    ? suggestDeepCleans(dndFreedMins, 0, dcConfig, overdueRooms.length)
    : null;

  const avgTurnover = useMemo(() => {
    const toMs = (v: unknown): number | null => {
      if (!v) return null;
      if (typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().getTime();
      const d = new Date(v as string | number | Date);
      return isNaN(d.getTime()) ? null : d.getTime();
    };
    const timed = rooms
      .filter(r => r.startedAt && r.completedAt)
      .map(r => {
        const s = toMs(r.startedAt);
        const e = toMs(r.completedAt);
        if (!s || !e) return 0;
        return (e - s) / 60000;
      })
      .filter(m => m > 0 && m < 480);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  }, [rooms]);

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  /* ── Inline editable number ── */
  const InlineEdit = ({ value, onChange, fieldKey, prefix }: {
    value: number; onChange: (v: number) => void; fieldKey: string; prefix?: string;
  }) => {
    const isEditing = editingField === fieldKey;
    if (isEditing) {
      return (
        <input
          type="number"
          autoFocus
          value={value || ''}
          onChange={e => onChange(parseInt(e.target.value) || 0)}
          onBlur={() => setEditingField(null)}
          onKeyDown={e => { if (e.key === 'Enter') setEditingField(null); }}
          style={{
            width: '64px', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px',
            border: '2px solid var(--navy)', borderRadius: '6px', padding: '2px 6px',
            background: 'var(--bg)', color: 'var(--text-primary)', outline: 'none',
          }}
        />
      );
    }
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setEditingField(fieldKey); }}
        style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', cursor: 'pointer', borderBottom: '1px dashed var(--border)' }}
      >
        {value > 0 ? `${prefix || ''}${value}` : '—'}
      </span>
    );
  };

  /* ── Labor cost calculation ── */
  const wage = activeProperty?.hourlyWage || 12;
  const hkStaff = rooms.length > 0 ? Math.ceil(rooms.length / 15) : 1;
  const hkCost = Math.round(hkStaff * wage * 8);
  const fdCost = Math.round(2 * wage * 8);
  const mtCost = Math.round(1 * wage * 8);
  const totalCost = fdCost + hkCost + mtCost;

  return (
    <AppLayout>
      <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>

        {/* ── Page header ── */}
        <div className="animate-in">
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {t('dashboard', lang)}
          </h1>
        </div>

        {/* ════════════════════════════════════════════════════════════
            HERO ROW — The 3 numbers that matter most at a glance
            ════════════════════════════════════════════════════════════ */}
        <div className="animate-in stagger-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>

          {/* Occupancy — the big one */}
          <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(27,58,92,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Percent size={15} color="var(--navy)" />
              </div>
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)' }}>{t('occupancy', lang)}</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '36px', lineHeight: 1, letterSpacing: '-0.04em', color: occupancyPct >= 80 ? '#16A34A' : occupancyPct >= 50 ? 'var(--navy)' : '#d97706' }}>
              {occupancyPct}<span style={{ fontSize: '22px', fontWeight: 600 }}>%</span>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              {rentedRooms} of {totalPropertyRooms} rooms occupied
            </p>
          </div>

          {/* Dirty Rooms — action needed */}
          <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: dirty > 0 ? 'rgba(220,38,38,0.08)' : 'rgba(22,163,74,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={15} color={dirty > 0 ? '#DC2626' : '#16A34A'} />
              </div>
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)' }}>{t('dirtyRooms', lang)}</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '36px', lineHeight: 1, letterSpacing: '-0.04em', color: dirty > 0 ? '#DC2626' : '#16A34A' }}>
              {dirty}
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              {clean} {t('clean', lang).toLowerCase()} · {inProgress} {t('progress', lang).toLowerCase()}
            </p>
          </div>

          {/* Staff Tomorrow */}
          <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(22,163,74,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Users size={15} color="#16A34A" />
              </div>
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)' }}>{t('staffTomorrow', lang)}</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '36px', lineHeight: 1, letterSpacing: '-0.04em', color: confirmedCount > 0 ? '#16A34A' : 'var(--text-muted)' }}>
              {confirmedCount}
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              {tomorrowConfs.length > 0 ? `${tomorrowConfs.length} ${t('contacted', lang)}` : lang === 'es' ? 'ninguno contactado' : 'none contacted'}
            </p>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            DEEP CLEAN ALERT — only shows when rooms are overdue
            ════════════════════════════════════════════════════════════ */}
        {overdueRooms.length > 0 && (
          <div
            className="animate-in stagger-1"
            style={{
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              borderRadius: 'var(--radius-lg)',
              background: 'linear-gradient(135deg, rgba(245,158,11,0.06) 0%, rgba(220,38,38,0.04) 100%)',
              border: '1px solid rgba(245,158,11,0.2)',
            }}
          >
            <div style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: 'rgba(245,158,11,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Zap size={16} color="#f59e0b" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '1px' }}>
                {overdueRooms.length} room{overdueRooms.length !== 1 ? 's' : ''} overdue for deep cleaning
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                {dndFreedMins > 0 ? `${dndFreedMins} min freed from DND rooms.` : ''}
                {dcSuggestion && dcSuggestion.count > 0
                  ? ` Could fit ${dcSuggestion.count} deep clean${dcSuggestion.count !== 1 ? 's' : ''}.`
                  : ''}
              </p>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            MAIN CONTENT — Room Grid + Tomorrow's Crew side by side
            ════════════════════════════════════════════════════════════ */}
        <div className="animate-in stagger-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', flex: 1, minHeight: 0 }}>

          {/* LEFT: Room status + grid */}
          <div
            className="card"
            onClick={() => { localStorage.setItem('hk-tab', 'rooms'); router.push('/housekeeping'); }}
            style={{ padding: '18px', display: 'flex', flexDirection: 'column', overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 150ms' }}
            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--navy-light)')}
            onMouseLeave={e => (e.currentTarget.style.boxShadow = '')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Sparkles size={14} color="var(--navy-light)" />
              <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                {t('roomStatus', lang)}
              </h2>
              <span style={{ marginLeft: 'auto', fontSize: '18px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: pct === 100 ? 'var(--green)' : 'var(--navy-light)' }}>
                {pct}%
              </span>
            </div>
            <div style={{ height: '5px', background: '#E5E7EB', borderRadius: '99px', overflow: 'hidden', marginBottom: '12px', flexShrink: 0 }}>
              <div style={{ height: '100%', borderRadius: '99px', transition: 'width 600ms cubic-bezier(0.4,0,0.2,1)', width: `${pct}%`, background: pct === 100 ? 'var(--green)' : 'var(--navy-light)' }} />
            </div>
            {total === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: '13px', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {t('noRoomsAssignedToday', lang)}
              </div>
            ) : (
              <>
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  <RoomGrid rooms={rooms} overdueSet={new Set(overdueRooms.map(r => r.roomNumber))} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    {[
                      { dot: '#86EFAC', bg: '#DCFCE7', label: t('clean', lang), count: clean },
                      { dot: '#FCD34D', bg: '#FEF9C3', label: t('progress', lang), count: inProgress },
                      { dot: '#FCA5A5', bg: '#FEE2E2', label: t('dirty', lang), count: dirty },
                    ].map(({ dot, bg, label, count }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{ width: '9px', height: '9px', borderRadius: '2px', background: bg, border: `1.5px solid ${dot}`, flexShrink: 0 }} />
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
                          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{count}</span> {label}
                        </span>
                      </div>
                    ))}
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, flexShrink: 0 }}>{total} {t('total', lang)}</span>
                </div>
              </>
            )}
          </div>

          {/* RIGHT: Tomorrow's crew */}
          <div
            className="card"
            onClick={() => { localStorage.setItem('hk-tab', 'schedule'); router.push('/housekeeping'); }}
            style={{ padding: '18px', display: 'flex', flexDirection: 'column', overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 150ms' }}
            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--navy-light)')}
            onMouseLeave={e => (e.currentTarget.style.boxShadow = '')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
              <Users size={14} color="var(--navy-light)" />
              <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                {t('tomorrowsCrew', lang)}
              </h2>
              {tomorrowConfs.length > 0 && (
                <span style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 600, color: 'var(--green)' }}>
                  {confirmedCount}/{tomorrowConfs.length}
                </span>
              )}
            </div>

            {tomorrowConfs.length === 0 ? (
              <div style={{
                padding: '32px 16px', textAlign: 'center', borderRadius: 'var(--radius-md)',
                background: 'rgba(0,0,0,0.02)', border: '1px dashed var(--border)', flex: 1,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              }}>
                <CircleDot size={24} color="var(--text-muted)" style={{ marginBottom: '8px' }} />
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                  {t('noConfirmationsYet', lang)}
                </p>
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {tomorrowConfs.map(conf => {
                  const badge = STATUS_BADGE[conf.status];
                  return (
                    <div key={conf.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', background: 'rgba(0,0,0,0.02)',
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                      flexShrink: 0,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          width: '30px', height: '30px', borderRadius: '50%',
                          background: 'var(--navy)', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '11px', fontWeight: 700, flexShrink: 0,
                        }}>
                          {(conf.staffName || '?')[0].toUpperCase()}
                        </div>
                        <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>
                          {conf.staffName}
                        </span>
                      </div>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '4px 10px', borderRadius: 'var(--radius-full)',
                        background: badge.bg, color: badge.color,
                        fontSize: '11px', fontWeight: 600,
                      }}>
                        {badge.icon}
                        {lang === 'es' ? badge.label_es : badge.label_en}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            DETAILS — Secondary stats in a compact, single card
            ════════════════════════════════════════════════════════════ */}
        <div className="animate-in stagger-3 card" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0', borderBottom: '1px solid var(--border)', paddingBottom: '14px', marginBottom: '14px' }}>

            {/* Guests section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {lang === 'es' ? 'Huéspedes' : 'Guests'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('arrivals', lang)}</span>
                  <InlineEdit value={arrivals} onChange={setArrivals} fieldKey="arrivals" />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('reservations', lang)}</span>
                  <InlineEdit value={reservationCount} onChange={setReservationCount} fieldKey="reservations" />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('inHouse', lang)}</span>
                  <InlineEdit value={inHouseGuests} onChange={setInHouseGuests} fieldKey="inHouse" />
                </div>
              </div>
            </div>

            {/* Revenue section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderLeft: '1px solid var(--border)', paddingLeft: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {lang === 'es' ? 'Ingresos' : 'Revenue'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('adr', lang)}</span>
                  <InlineEdit value={adr} onChange={setAdr} fieldKey="adr" prefix="$" />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('revpar', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>
                    {adr > 0 ? `$${revpar}` : '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Operations section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderLeft: '1px solid var(--border)', paddingLeft: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {lang === 'es' ? 'Operaciones' : 'Operations'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('avgTurnover', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>
                    {avgTurnover !== null ? `${avgTurnover}m` : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('openWorkOrders', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: urgentOrders.length > 0 ? '#DC2626' : 'var(--text-primary)' }}>
                    {openOrders.length}
                    {urgentOrders.length > 0 && <span style={{ fontSize: '10px', color: '#DC2626', marginLeft: '4px' }}>!</span>}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('blockedRooms', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: blockedRooms > 0 ? '#DC2626' : 'var(--text-primary)' }}>
                    {blockedRooms}
                  </span>
                </div>
              </div>
            </div>

            {/* Labor cost section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderLeft: '1px solid var(--border)', paddingLeft: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {t('estLaborCost', lang)}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('frontDeskLabor', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '13px', color: 'var(--text-secondary)' }}>${fdCost}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('housekeepingLabor', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '13px', color: 'var(--text-secondary)' }}>${hkCost}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '4px', borderTop: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('total', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>${totalCost}</span>
                </div>
              </div>
            </div>

          </div>

          {/* Available rooms footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <DoorOpen size={14} color="var(--text-muted)" />
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {t('availableRooms', lang)}
              </span>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--navy)' }}>
              {vacant} <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-muted)' }}>/ {totalPropertyRooms}</span>
            </span>
          </div>
        </div>

      </div>
    </AppLayout>
  );
}
