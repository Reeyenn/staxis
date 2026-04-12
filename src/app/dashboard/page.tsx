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
  Zap, User, TrendingUp, Sparkles,
  ChevronRight,
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
      <div className="dash-page-content" style={{ padding: '14px 16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

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
            GLASS HERO KPI BAR — Stitch-inspired
            Occupancy | Dirty Rooms | Est. Labor Cost + action buttons
            ════════════════════════════════════════════════════════════ */}
        <div className="glass-hero animate-in stagger-2" style={{ padding: '20px' }}>
          <div className="glass-hero-bg" />
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* KPI row */}
            <div className="dash-hero-grid" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', gap: '32px', flexWrap: 'wrap' }}>
              {/* Occupancy */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#454652', margin: 0 }}>
                  {t('occupancy', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span className="data-mono" style={{ fontSize: '36px', color: occupancyPct >= 80 ? '#006565' : occupancyPct >= 50 ? '#364262' : 'var(--amber)', lineHeight: 1 }}>
                    {occupancyPct}%
                  </span>
                  {occupancyPct >= 80 && <TrendingUp size={18} color="#006565" />}
                </div>
              </div>

              {/* Dirty Rooms */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#454652', margin: 0 }}>
                  {t('dirtyRooms', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span className="data-mono" style={{ fontSize: '36px', color: dirty > 0 ? 'var(--red)' : 'var(--green)', lineHeight: 1 }}>
                    {dirty}
                  </span>
                  {dirty > 0 && (
                    <Wrench size={16} color="var(--red)" style={{ opacity: 0.7 }} />
                  )}
                </div>
              </div>

              {/* Est. Labor Cost */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#454652', margin: 0 }}>
                  {t('estLaborCost', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span className="data-mono" style={{ fontSize: '36px', color: '#364262', lineHeight: 1 }}>
                    ${totalCost}
                  </span>
                  <span style={{ fontSize: '13px', color: '#454652' }}>/shift</span>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={() => router.push('/front-desk')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '12px 20px', borderRadius: '10px',
                  background: '#364262', color: '#FFFFFF',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600,
                  boxShadow: '0 2px 8px rgba(54,66,98,0.25)',
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
                  padding: '12px 20px', borderRadius: '10px',
                  background: '#006565', color: '#FFFFFF',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600,
                  boxShadow: '0 2px 8px rgba(0,101,101,0.25)',
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
            CREW TRACKER — Who's cleaning what right now
            ════════════════════════════════════════════════════════════ */}
        {hkActivity.length > 0 && (
          <div className="animate-in stagger-4 card" style={{ padding: '16px 18px' }}>
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
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                    background: hk.active ? 'var(--amber)' : hk.done === hk.total ? 'var(--green)' : 'var(--text-muted)',
                    boxShadow: hk.active ? '0 0 0 3px rgba(245,158,11,0.2)' : 'none',
                  }} />
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {hk.name.split(' ')[0]}
                  </span>
                  <span style={{ fontSize: '12px', color: hk.active ? 'var(--amber)' : 'var(--text-muted)', fontWeight: hk.active ? 600 : 400, flexShrink: 0 }}>
                    {hk.active
                      ? `Rm ${hk.active.number}`
                      : hk.done === hk.total
                        ? (lang === 'es' ? 'Terminó' : 'Done')
                        : (lang === 'es' ? 'Libre' : 'Idle')
                    }
                  </span>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-muted)', flexShrink: 0 }}>
                    {hk.done}/{hk.total}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}


        {/* ════════════════════════════════════════════════════════════
            MORNING CONCIERGE BRIEFING — Stitch-inspired timeline feed
            Handoff notes + work orders displayed as a smart AI timeline
            ════════════════════════════════════════════════════════════ */}
        {(recentHandoffs.length > 0 || openOrders.length > 0) && (
          <div className="concierge-card animate-in stagger-5" style={{ padding: '18px 16px' }}>
            {/* Header with AI sparkle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Sparkles size={18} color="#006565" fill="#006565" />
              <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>
                {lang === 'es' ? 'Briefing Concierge' : 'Morning Concierge Briefing'}
              </h3>
            </div>

            {/* Timeline items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {briefingItems.map(item => (
                <div key={item.id} style={{ display: 'flex', gap: '12px' }}>
                  <div className={`concierge-dot ${item.dotClass}`} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <p style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--text-muted)', margin: 0 }}>
                      {formatTime(item.time)}
                    </p>
                    <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)', margin: 0, lineHeight: 1.5 }}>
                      {item.text.length > 120 ? item.text.slice(0, 120) + '…' : item.text}
                    </p>
                  </div>
                </div>
              ))}

              {briefingItems.length === 0 && (
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
                  {lang === 'es' ? 'Sin novedades aún.' : 'No updates yet today.'}
                </p>
              )}
            </div>

            {/* Expand button */}
            {(recentHandoffs.length + openOrders.length) > 6 && (
              <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid rgba(78, 90, 122, 0.08)' }}>
                <button style={{
                  width: '100%', padding: '10px',
                  borderRadius: '8px', border: 'none',
                  background: 'rgba(0,0,0,0.03)', color: 'var(--text-secondary)',
                  fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}>
                  {lang === 'es' ? 'Ver todo' : 'Expand Full Feed'}
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </AppLayout>
  );
}
