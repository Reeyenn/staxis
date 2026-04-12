'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToRooms,
  getDeepCleanConfig, getDeepCleanRecords,
  subscribeToWorkOrders,
  subscribeToHandoffLogs,
} from '@/lib/firestore';
import { getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { todayStr } from '@/lib/utils';
import type { Room, DeepCleanConfig, DeepCleanRecord, WorkOrder, HandoffEntry } from '@/types';
import {
  Clock,
  DollarSign, Wrench,
  Zap, User,
} from 'lucide-react';

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, staff, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [dcConfig, setDcConfig] = useState<DeepCleanConfig | null>(null);
  const [dcRecords, setDcRecords] = useState<DeepCleanRecord[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffEntry[]>([]);

  const [arrivals, setArrivals] = useState(0);
  const [inHouseGuests, setInHouseGuests] = useState(0);
  const [reservationCount, setReservationCount] = useState(0);
  const [adr, setAdr] = useState(0);
  const [editingField, setEditingField] = useState<string | null>(null);


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

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToHandoffLogs(user.uid, activePropertyId, setHandoffs);
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

  const totalPropertyRooms = activeProperty?.totalRooms || 0;
  const rentedRooms = checkouts + stayovers;
  const occupancyPct = totalPropertyRooms > 0 ? Math.round((rentedRooms / totalPropertyRooms) * 100) : 0;
  const revpar = totalPropertyRooms > 0 && adr > 0 ? Math.round((adr * rentedRooms) / totalPropertyRooms) : 0;


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

  /* ── Housekeeper activity: who's cleaning what right now ── */
  const hkActivity = useMemo(() => {
    const assigned = new Map<string, { name: string; active: Room | null; done: number; total: number }>();
    rooms.forEach(r => {
      if (!r.assignedTo) return;
      if (!assigned.has(r.assignedTo)) {
        const s = staff.find(s => s.id === r.assignedTo);
        assigned.set(r.assignedTo, { name: s?.name || r.assignedName || r.assignedTo, active: null, done: 0, total: 0 });
      }
      const entry = assigned.get(r.assignedTo)!;
      entry.total++;
      if (r.status === 'clean' || r.status === 'inspected') entry.done++;
      if (r.status === 'in_progress') entry.active = r;
    });
    return [...assigned.values()].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [rooms, staff]);

  /* ── Morning briefing data ── */
  const recentHandoffs = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return handoffs
      .filter(h => {
        if (!h.createdAt) return false;
        const d = h.createdAt instanceof Date ? h.createdAt : (h.createdAt as any).toDate?.() || new Date(h.createdAt as any);
        return d >= cutoff;
      })
      .sort((a, b) => {
        const da = a.createdAt instanceof Date ? a.createdAt : (a.createdAt as any).toDate?.() || new Date(a.createdAt as any);
        const db = b.createdAt instanceof Date ? b.createdAt : (b.createdAt as any).toDate?.() || new Date(b.createdAt as any);
        return db.getTime() - da.getTime();
      });
  }, [handoffs]);

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px', background: 'var(--bg)' }}>
        <div className="animate-spin" style={{ width: '32px', height: '32px', border: '4px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%' }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {lang === 'es' ? 'Cargando panel...' : 'Loading dashboard...'}
        </p>
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
      <div className="dash-page-content" style={{ padding: '14px 16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {/* ── Page header ── */}
        <div className="animate-in">
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '17px', color: 'var(--text-primary)', letterSpacing: '-0.01em', lineHeight: 1 }}>
            {t('dashboard', lang)}
          </h1>
        </div>

        {/* ════════════════════════════════════════════════════════════
            DEEP CLEAN ALERT — only shows when rooms are overdue
            ════════════════════════════════════════════════════════════ */}
        {overdueRooms.length > 0 && (
          <div
            className="animate-in stagger-1"
            style={{
              padding: '8px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              borderRadius: 'var(--radius-md)',
              background: 'linear-gradient(135deg, rgba(245,158,11,0.06) 0%, rgba(220,38,38,0.04) 100%)',
              border: '1px solid rgba(245,158,11,0.2)',
            }}
          >
            <Zap size={14} color="var(--amber)" style={{ flexShrink: 0 }} />
            <p style={{ fontSize: '12px', color: 'var(--text-primary)', margin: 0, flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>
                {lang === 'es'
                  ? `${overdueRooms.length} atrasada${overdueRooms.length !== 1 ? 's' : ''}`
                  : `${overdueRooms.length} overdue`}
              </span>
              {dcSuggestion && dcSuggestion.count > 0 && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {lang === 'es' ? ` · caben ${dcSuggestion.count} hoy` : ` · fit ${dcSuggestion.count} today`}
                </span>
              )}
              {dndFreedMins > 0 && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {lang === 'es' ? ` · ${dndFreedMins}m DND` : ` · ${dndFreedMins}m DND`}
                </span>
              )}
            </p>
          </div>
        )}


        {/* ════════════════════════════════════════════════════════════
            DETAILS — Secondary stats in a compact, single card
            ════════════════════════════════════════════════════════════ */}
        <div className="animate-in stagger-3 card" style={{ padding: '12px 14px' }}>
          <div className="dash-details-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0', borderBottom: '1px solid var(--border)', paddingBottom: '10px', marginBottom: '10px' }}>

            {/* Today section — the 3 KPIs that matter most */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {lang === 'es' ? 'Hoy' : 'Today'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('occupancy', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: occupancyPct >= 80 ? 'var(--green)' : occupancyPct >= 50 ? 'var(--navy)' : 'var(--amber)' }}>
                    {occupancyPct}%
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('dirtyRooms', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: dirty > 0 ? 'var(--red)' : 'var(--green)' }}>
                    {dirty}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '16px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('estLaborCost', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--navy)' }}>
                    ${totalCost}
                  </span>
                </div>
              </div>
            </div>

            {/* Guests section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderLeft: '1px solid var(--border)', paddingLeft: '16px' }}>
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
              </div>
            </div>

            {/* Rooms section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderLeft: '1px solid var(--border)', paddingLeft: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {lang === 'es' ? 'Habitaciones' : 'Rooms'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('availableRooms', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--navy)' }}>{vacant}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('blockedRooms', lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: blockedRooms > 0 ? 'var(--red)' : 'var(--text-primary)' }}>{blockedRooms}</span>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            CREW TRACKER — Who's cleaning what right now
            ════════════════════════════════════════════════════════════ */}
        {hkActivity.length > 0 && (
          <div className="animate-in stagger-5 card" style={{ padding: '16px 18px' }}>
            <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '0 0 10px' }}>
              {lang === 'es' ? 'Equipo Ahora' : 'Crew Right Now'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              {hkActivity.map((hk, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 0',
                    borderBottom: i < hkActivity.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  {/* Status dot */}
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                    background: hk.active ? 'var(--amber)' : hk.done === hk.total ? 'var(--green)' : 'var(--text-muted)',
                    boxShadow: hk.active ? '0 0 0 3px rgba(245,158,11,0.2)' : 'none',
                  }} />
                  {/* Name */}
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {hk.name.split(' ')[0]}
                  </span>
                  {/* What they're doing */}
                  <span style={{ fontSize: '12px', color: hk.active ? 'var(--amber)' : 'var(--text-muted)', fontWeight: hk.active ? 600 : 400, flexShrink: 0 }}>
                    {hk.active
                      ? `${lang === 'es' ? 'Rm' : 'Rm'} ${hk.active.number}`
                      : hk.done === hk.total
                        ? (lang === 'es' ? 'Terminó' : 'Done')
                        : (lang === 'es' ? 'Libre' : 'Idle')
                    }
                  </span>
                  {/* Progress */}
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-muted)', flexShrink: 0 }}>
                    {hk.done}/{hk.total}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            MORNING BRIEFING — Overnight notes + pending maintenance
            ════════════════════════════════════════════════════════════ */}
        {(recentHandoffs.length > 0 || urgentOrders.length > 0 || openOrders.length > 0) && (
          <div className="animate-in stagger-6 card" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <p style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: 0 }}>
                {lang === 'es' ? 'Resumen de Hoy' : "Today's Briefing"}
              </p>
              {rooms.length > 0 && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{checkouts}</strong> {lang === 'es' ? 'sal' : 'out'} · <strong style={{ color: 'var(--text-primary)' }}>{stayovers}</strong> {lang === 'es' ? 'ocup' : 'stay'}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {recentHandoffs.slice(0, 2).map(h => (
                <div key={h.id} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '12px', lineHeight: 1.4 }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', flexShrink: 0, minWidth: '44px' }}>
                    {h.shiftType}
                  </span>
                  <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.notes.length > 80 ? h.notes.slice(0, 80) + '…' : h.notes}
                  </span>
                </div>
              ))}

              {openOrders.slice(0, 4).map(o => (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                  <div style={{
                    width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                    background: o.severity === 'urgent' ? 'var(--red)' : o.severity === 'medium' ? 'var(--amber)' : 'var(--text-muted)',
                  }} />
                  <span style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', minWidth: '44px' }}>Rm {o.roomNumber}</span>
                  <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.description.length > 60 ? o.description.slice(0, 60) + '…' : o.description}
                  </span>
                  {o.severity === 'urgent' && (
                    <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--red)', flexShrink: 0 }}>!</span>
                  )}
                </div>
              ))}
              {openOrders.length > 4 && (
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  +{openOrders.length - 4} {lang === 'es' ? 'más' : 'more'}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Quick action buttons — Front Desk + ROI */}
        <div style={{ display: 'flex', gap: '8px', margin: '0 16px 16px' }}>
          <button onClick={() => router.push('/front-desk')} className="active:scale-98" style={{
            flex: 1, padding: '8px 12px', borderRadius: '10px',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
            display: 'flex', alignItems: 'center', gap: '6px',
            transition: 'all 0.15s',
          }}>
            <span style={{ fontSize: '13px' }}>🖥</span>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', flex: 1, textAlign: 'left' }}>
              {lang === 'es' ? 'Recepción' : 'Front Desk'}
            </span>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>›</span>
          </button>
          <button onClick={() => router.push('/roi')} className="active:scale-98" style={{
            flex: 1, padding: '8px 12px', borderRadius: '10px',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
            display: 'flex', alignItems: 'center', gap: '6px',
            transition: 'all 0.15s',
          }}>
            <DollarSign size={13} color="var(--green)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', flex: 1, textAlign: 'left' }}>
              {lang === 'es' ? 'Ver ROI' : 'View ROI'}
            </span>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>›</span>
          </button>
        </div>

      </div>
    </AppLayout>
  );
}
