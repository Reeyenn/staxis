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
  Clock, Users,
  DollarSign, Wrench, TrendingUp,
  Zap, Sparkles, ChevronRight,
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

  // All React hooks MUST be declared before any conditional returns


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

  /* ── Briefing items: combine handoffs + work orders into a timeline ── */
  const briefingItems = useMemo(() => {
    const items: { id: string; time: Date; dotClass: string; text: string }[] = [];

    recentHandoffs.slice(0, 3).forEach(h => {
      const d = h.createdAt instanceof Date ? h.createdAt : (h.createdAt as any).toDate?.() || new Date(h.createdAt as any);
      items.push({
        id: `h-${h.id}`,
        time: d,
        dotClass: 'concierge-dot-teal',
        text: `${h.shiftType}: ${h.notes}`,
      });
    });

    openOrders.slice(0, 4).forEach(o => {
      const d = o.createdAt instanceof Date ? o.createdAt : (o.createdAt as any)?.toDate?.() || new Date();
      items.push({
        id: `wo-${o.id}`,
        time: d,
        dotClass: o.severity === 'urgent' ? 'concierge-dot-red' : o.severity === 'medium' ? 'concierge-dot-amber' : 'concierge-dot-muted',
        text: `Rm ${o.roomNumber}: ${o.description}`,
      });
    });

    return items.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 6);
  }, [recentHandoffs, openOrders]);

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

  const formatTime = (d: Date) => {
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${m} ${ampm}`;
  };

  return (
    <AppLayout>
      <div style={{ padding: '20px', background: 'var(--bg)', minHeight: '100vh' }}>

        {/* ════════════════════════════════════════════════════════════
            DEEP CLEAN ALERT — only shows when rooms are overdue
            ════════════════════════════════════════════════════════════ */}
        {overdueRooms.length > 0 && (
          <div
            className="animate-in stagger-1"
            style={{
              marginBottom: '16px',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              borderRadius: 'var(--radius-lg)',
              background: 'linear-gradient(135deg, rgba(245,158,11,0.06) 0%, rgba(186,26,26,0.04) 100%)',
              border: '1px solid rgba(245,158,11,0.2)',
            }}
          >
            <Zap size={16} color="var(--amber)" style={{ flexShrink: 0 }} />
            <p style={{ fontSize: '13px', color: 'var(--text-primary)', margin: 0, flex: 1, minWidth: 0 }}>
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
            GLASS HERO HUB — KPI Dashboard
            Occupancy | Dirty Rooms | Est. Labor Cost + Action Buttons
            ════════════════════════════════════════════════════════════ */}
        <div className="glass-hero animate-in stagger-2" style={{ marginBottom: '24px', padding: '28px 32px' }}>
          <div className="glass-hero-bg" />
          <div style={{
            position: 'relative', zIndex: 2,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '32px', flexWrap: 'wrap',
          }}>

            {/* KPI Cluster — left side */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '40px', flexWrap: 'wrap' }}>
              {/* Occupancy */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', margin: 0 }}>
                  {t('occupancy', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span className="data-mono" style={{ fontSize: '42px', color: occupancyPct >= 80 ? '#006565' : occupancyPct >= 50 ? '#364262' : 'var(--amber)', lineHeight: 1 }}>
                    {occupancyPct}%
                  </span>
                  {occupancyPct >= 80 && <TrendingUp size={18} color="#006565" strokeWidth={2} />}
                </div>
              </div>

              {/* Dirty Rooms */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', margin: 0 }}>
                  {t('dirtyRooms', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span className="data-mono" style={{ fontSize: '42px', color: dirty > 0 ? 'var(--red)' : 'var(--green)', lineHeight: 1 }}>
                    {dirty}
                  </span>
                  {dirty > 0 && <Wrench size={18} color="var(--red)" strokeWidth={2} />}
                </div>
              </div>

              {/* Est. Labor Cost */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', margin: 0 }}>
                  {t('estLaborCost', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span className="data-mono" style={{ fontSize: '42px', color: '#364262', lineHeight: 1 }}>
                    ${totalCost}
                  </span>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 500 }}>/shift</span>
                </div>
              </div>
            </div>

            {/* Action Buttons — right side */}
            <div style={{ display: 'flex', gap: '12px', flexShrink: 0 }}>
              <button
                onClick={() => router.push('/front-desk')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '14px 28px', borderRadius: 'var(--radius-lg)',
                  background: '#364262', color: '#FFFFFF',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600,
                  boxShadow: '0 4px 14px rgba(54,66,98,0.3)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Clock size={16} />
                {lang === 'es' ? 'Recepción' : 'Front Desk Command'}
              </button>
              <button
                onClick={() => router.push('/roi')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '14px 28px', borderRadius: 'var(--radius-lg)',
                  background: '#006565', color: '#FFFFFF',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600,
                  boxShadow: '0 4px 14px rgba(0,101,101,0.3)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Sparkles size={16} />
                {lang === 'es' ? 'Analítica ROI' : 'ROI Analytics'}
              </button>
            </div>

          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            BENTO GRID — 12-column layout
            Left (8 cols): 2x2 cards + full-width crew tracker
            Right (4 cols): Morning Concierge Briefing
            ════════════════════════════════════════════════════════════ */}
        <div className="bento-grid animate-in stagger-3">

          {/* LEFT SECTION — 8 columns */}
          <div className="bento-left">
            {/* 2x2 Card Grid */}
            <div className="bento-2x2" style={{ marginBottom: '16px' }}>

              {/* GUESTS CARD */}
              <div className="bento-card animate-in stagger-3">
                <div className="bento-card-title">
                  <Users size={24} color="var(--primary)" />
                  <span>{lang === 'es' ? 'Huéspedes' : 'Guests'}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                    {/* Arrivals */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center' }}>
                      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>
                        {lang === 'es' ? 'Llegadas' : 'Arrivals'}
                      </p>
                      <InlineEdit
                        value={arrivals}
                        onChange={setArrivals}
                        fieldKey="arrivals"
                      />
                    </div>
                    {/* Reservations */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center' }}>
                      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>
                        {lang === 'es' ? 'Reservas' : 'Reservations'}
                      </p>
                      <InlineEdit
                        value={reservationCount}
                        onChange={setReservationCount}
                        fieldKey="reservations"
                      />
                    </div>
                    {/* In-House */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center' }}>
                      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>
                        {lang === 'es' ? 'En Casa' : 'In-House'}
                      </p>
                      <InlineEdit
                        value={inHouseGuests}
                        onChange={setInHouseGuests}
                        fieldKey="in-house"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* REVENUE CARD */}
              <div className="bento-card animate-in stagger-4">
                <div className="bento-card-title">
                  <DollarSign size={24} color="var(--primary)" />
                  <span>{lang === 'es' ? 'Ingresos' : 'Revenue'}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {/* ADR */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                      ADR
                    </p>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ color: '#004b4b' }}>
                        $
                      </span>
                      <InlineEdit
                        value={adr}
                        onChange={setAdr}
                        fieldKey="adr"
                      />
                    </div>
                  </div>
                  {/* RevPAR */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                      RevPAR
                    </p>
                    <p className="data-mono" style={{ fontSize: '20px', color: '#004b4b', margin: 0 }}>
                      ${revpar}
                    </p>
                  </div>
                </div>
              </div>

              {/* OPERATIONS CARD */}
              <div className="bento-card animate-in stagger-5">
                <div className="bento-card-title">
                  <Wrench size={24} color="var(--primary)" />
                  <span>{lang === 'es' ? 'Operaciones' : 'Operations'}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                      {lang === 'es' ? 'Tiempo Promedio' : 'Avg Turnover Time'}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <p className="data-mono" style={{ fontSize: '28px', color: 'var(--primary)', margin: 0 }}>
                        {avgTurnover || '—'}
                        {avgTurnover && <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>m</span>}
                      </p>
                      {avgTurnover && (
                        <div style={{
                          display: 'inline-flex', alignItems: 'center',
                          gap: '4px', padding: '6px 10px', borderRadius: 'var(--radius-full)',
                          background: 'var(--green-dim)', color: 'var(--green)',
                          fontSize: '11px', fontWeight: 600
                        }}>
                          ↓ 5%
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* ROOMS CARD */}
              <div className="bento-card animate-in stagger-6">
                <div className="bento-card-title">
                  <TrendingUp size={24} color="var(--primary)" />
                  <span>{lang === 'es' ? 'Habitaciones' : 'Rooms'}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '16px', alignItems: 'center' }}>
                  {/* Available */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                      {lang === 'es' ? 'Disponibles' : 'Available'}
                    </p>
                    <p className="data-mono" style={{ fontSize: '24px', color: 'var(--green)', margin: 0 }}>
                      {clean}
                    </p>
                  </div>
                  {/* Divider */}
                  <div style={{ width: '1px', height: '50px', background: 'var(--border)' }} />
                  {/* Blocked */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
                    <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                      {lang === 'es' ? 'Bloqueadas' : 'Blocked'}
                    </p>
                    <p className="data-mono" style={{ fontSize: '24px', color: blockedRooms > 0 ? 'var(--red)' : 'var(--text-muted)', margin: 0 }}>
                      {blockedRooms}
                    </p>
                  </div>
                </div>
              </div>

            </div>

            {/* CREW TRACKER — Full Width */}
            {hkActivity.length > 0 ? (
              <div className="bento-card animate-in stagger-7">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
                  <Users size={20} color="var(--primary)" />
                  <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>
                    {lang === 'es' ? 'Equipo Ahora' : 'Crew Right Now'}
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                  {hkActivity.map((hk, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '12px 0',
                        borderBottom: i < hkActivity.length - 1 ? '1px solid var(--border)' : 'none',
                      }}
                    >
                      <div style={{
                        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                        background: hk.active ? 'var(--amber)' : hk.done === hk.total ? 'var(--green)' : 'var(--text-muted)',
                        boxShadow: hk.active ? '0 0 0 3px rgba(202,138,4,0.2)' : 'none',
                      }} />
                      <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>
                        {hk.name.split(' ')[0]}
                      </span>
                      <span style={{ fontSize: '13px', color: hk.active ? 'var(--amber)' : 'var(--text-muted)', fontWeight: hk.active ? 600 : 400, flexShrink: 0 }}>
                        {hk.active
                          ? `${lang === 'es' ? 'Rm ' : 'Rm '}${hk.active.number}`
                          : hk.done === hk.total
                            ? (lang === 'es' ? 'Terminó' : 'Done')
                            : (lang === 'es' ? 'Libre' : 'Idle')
                        }
                      </span>
                      <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {hk.done}/{hk.total}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bento-card animate-in stagger-7" style={{ textAlign: 'center', padding: '48px 32px' }}>
                <Users size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px', opacity: 0.5 }} />
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', margin: 0 }}>
                  {lang === 'es' ? 'Sin actividad de personal en este momento' : 'No staffing activity at this moment'}
                </p>
              </div>
            )}

          </div>

          {/* RIGHT SECTION — 4 columns */}
          <div className="bento-right">
            {/* MORNING CONCIERGE BRIEFING */}
            {(recentHandoffs.length > 0 || openOrders.length > 0) ? (
              <div className="concierge-card animate-in stagger-8" style={{ padding: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}>
                  <Sparkles size={20} color="#006565" fill="#006565" />
                  <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                    {lang === 'es' ? 'Briefing Concierge' : 'Morning Concierge'}
                  </h3>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {briefingItems.map(item => (
                    <div key={item.id} style={{ display: 'flex', gap: '12px' }}>
                      <div className={`concierge-dot ${item.dotClass}`} />
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <p style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                          {formatTime(item.time)}
                        </p>
                        <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)', margin: 0, lineHeight: 1.4 }}>
                          {item.text.length > 100 ? item.text.slice(0, 100) + '…' : item.text}
                        </p>
                      </div>
                    </div>
                  ))}

                  {briefingItems.length === 0 && (
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0, textAlign: 'center', padding: '24px 0' }}>
                      {lang === 'es' ? 'Sin novedades' : 'No updates'}
                    </p>
                  )}
                </div>

                {(recentHandoffs.length + openOrders.length) > 6 && (
                  <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                    <button style={{
                      width: '100%', padding: '10px',
                      borderRadius: 'var(--radius-md)', border: 'none',
                      background: 'var(--bg-subtle)', color: 'var(--text-secondary)',
                      fontSize: '12px', fontWeight: 600,
                      cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      transition: 'all 0.15s ease',
                    }}>
                      {lang === 'es' ? 'Ver todo' : 'View All'}
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="bento-card animate-in stagger-8" style={{ padding: '48px 32px', textAlign: 'center' }}>
                <Sparkles size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px', opacity: 0.5 }} />
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', margin: 0 }}>
                  {lang === 'es' ? 'Sin actualizaciones hoy' : 'No updates today'}
                </p>
              </div>
            )}
          </div>

        </div>

      </div>
    </AppLayout>
  );
}
