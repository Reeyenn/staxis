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

  // Hero banner images — randomly picked on each page load
  const HERO_IMAGES = [
    'https://images.unsplash.com/photo-1677129667171-92abd8740fa3?w=1200&q=80&auto=format&fit=crop',
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBZbI6Q__TgrGV68CwAljtCXlm-IIQqMH3Xp-2bJ6iCAK7czY26jVHPqSvr1eW6Jr9UzXxPWcHxnZY-vhxpsuzsHWrTmc959Y8259FEe1eFselJfyEo8TSuB3A5ousMXyxqU07-hrv_pwBIgA8BPUv8oz2UdjcLL_sZNHiuPA7ImV_kiS6oL0xM1Jdkrs6Nsv7LTW-MVg0PWv1jzCrTFmWDskwTsIebZXs0pedyHW35oLHSX4pjQ_Y8CA130SYTXxEN-ZUlVQTT94A',
    'https://images.unsplash.com/photo-1767395523614-53f52709c37a?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1763560705345-5aed55f99c8f?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1759038086917-7dc476207c0f?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1758193783649-13371d7fb8dd?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1758194190679-198a77cba84f?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1702814160779-4a88cfb330c7?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1696766984569-a33d52748dba?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1768346564825-6f90c0b89e2e?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1771918522305-9d78f9cf9751?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1774192621035-20d11389f781?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1759177715489-74112089de1a?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1723974915612-c9b6f524f28c?w=1200&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1758194090785-8e09b7288199?w=1200&q=80&auto=format&fit=crop',
  ];
  // Persist across tab navigation — only changes on full page refresh (F5)
  const heroImage = useMemo(() => {
    if (typeof window === 'undefined') return HERO_IMAGES[0];
    const stored = sessionStorage.getItem('staxis-hero-img');
    if (stored && HERO_IMAGES.includes(stored)) return stored;
    const picked = HERO_IMAGES[Math.floor(Math.random() * HERO_IMAGES.length)];
    sessionStorage.setItem('staxis-hero-img', picked);
    return picked;
  }, []);

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
      <div style={{ padding: '40px 32px', background: '#fbf9f4', minHeight: '100vh' }}>

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
            GOOD MORNING HERO BANNER
            ════════════════════════════════════════════════════════════ */}
        <div className="animate-in stagger-1" style={{
          position: 'relative', height: '280px', borderRadius: '16px',
          overflow: 'hidden', marginBottom: '32px',
        }}>
          {/* Background image */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroImage}
              alt=""
              aria-hidden="true"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {/* Gradient overlay */}
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(to right, rgba(54,66,98,0.80) 0%, transparent 100%)',
            }} />
          </div>
          {/* Text content */}
          <div style={{
            position: 'relative', zIndex: 10, height: '100%',
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
            padding: '48px',
          }}>
            {/* Left side: greeting */}
            <div style={{ maxWidth: '640px' }}>
              {/* AI Insight Ready badge */}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '4px 12px', borderRadius: '9999px',
                background: '#006565', color: '#FFFFFF',
                fontSize: '12px', fontWeight: 700, marginBottom: '16px',
                letterSpacing: '0.02em',
              }}>
                <Sparkles size={14} />
                AI INSIGHT READY
              </span>
              <h1 style={{
                fontSize: '48px', fontWeight: 700, color: '#FFFFFF',
                letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '8px',
              }}>
                {(() => {
                  const hour = new Date().getHours();
                  const greeting = hour < 12
                    ? (lang === 'es' ? 'Buenos días' : 'Good morning')
                    : hour < 18
                      ? (lang === 'es' ? 'Buenas tardes' : 'Good afternoon')
                      : (lang === 'es' ? 'Buenas noches' : 'Good evening');
                  const firstName = user?.displayName?.split(' ')[0] || '';
                  return `${greeting}${firstName ? `, ${firstName}` : ''}.`;
                })()}
              </h1>
              <p style={{
                fontSize: '20px', fontWeight: 300, color: '#c5d1f8',
                opacity: 0.9, margin: 0,
              }}>
                {activeProperty?.name || 'Your property'} {lang === 'es' ? 'está al' : 'is at'} {occupancyPct}% {lang === 'es' ? 'de ocupación hoy.' : 'occupancy today.'} {occupancyPct >= 80
                  ? (lang === 'es' ? 'Operaciones optimizadas.' : 'Operations are optimized.')
                  : (lang === 'es' ? 'Listo para el día.' : 'Ready for the day.')}
              </p>
            </div>
            {/* Right side: date display */}
            <div style={{ textAlign: 'right', flexShrink: 0, paddingLeft: '32px' }}>
              {(() => {
                const now = new Date();
                const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                return (
                  <>
                    <p style={{
                      fontSize: '14px', fontWeight: 600, textTransform: 'uppercase' as const,
                      letterSpacing: '0.15em', color: 'rgba(255,255,255,0.6)',
                      margin: '0 0 4px',
                    }}>{days[now.getDay()]}</p>
                    <p className="data-mono" style={{
                      fontSize: '42px', fontWeight: 500, color: '#FFFFFF',
                      lineHeight: 1, margin: '0 0 2px',
                      textShadow: '0 2px 20px rgba(0,0,0,0.3)',
                    }}>{now.getDate()}</p>
                    <p style={{
                      fontSize: '15px', fontWeight: 500, color: 'rgba(255,255,255,0.7)',
                      letterSpacing: '0.06em', margin: 0,
                    }}>{months[now.getMonth()]} {now.getFullYear()}</p>
                  </>
                );
              })()}
            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            GLASS HERO HUB — KPI Dashboard
            Occupancy | Dirty Rooms | Est. Labor Cost + Action Buttons
            ════════════════════════════════════════════════════════════ */}
        <section className="glass-hero animate-in stagger-2" style={{ marginBottom: '32px' }}>
          <div className="glass-hero-bg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuAUkJ87OGqb9QZ3nLbfCbHYuNgoCRsfcrSTqcfy8LlaEm8_94XXXZc5LvqA_5T36RJJykyAlxUHbasVhW-V52jbgsdVMHhedC17vZk_Y5-TCMq6NWzbrN60mUF_bgeUYq_2wEOltK3e5GIuN5krTVz7lju3NN9ru-gTTwjtEG0ZIRdl1dGDL4FP5KjnJsNm2lw4HNq9nO7C0xSjh0WnhsNEQ0c9rQP5-Bg5ycpesyUdhDiSQPxFLzP6L1vDs-8LjUHCbvH0R4UFxyU"
              alt=""
              aria-hidden="true"
            />
          </div>
          <div style={{
            position: 'relative', zIndex: 10,
            display: 'flex', flexDirection: 'row', justifyContent: 'space-between',
            alignItems: 'center', gap: '32px', flexWrap: 'wrap',
            padding: '40px',
          }}>

            {/* KPI Cluster — left side */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '48px', flex: 1 }}>
              {/* Occupancy */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#454652', margin: 0 }}>
                  {t('occupancy', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                  <span className="data-mono" style={{ fontSize: '48px', fontWeight: 600, color: '#006565', lineHeight: 1 }}>
                    {occupancyPct}%
                  </span>
                  {occupancyPct >= 80 && <TrendingUp size={20} color="#006565" strokeWidth={2} />}
                </div>
              </div>

              {/* Dirty Rooms */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#454652', margin: 0 }}>
                  {t('dirtyRooms', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                  <span className="data-mono" style={{ fontSize: '48px', fontWeight: 600, color: 'var(--red)', lineHeight: 1 }}>
                    {dirty}
                  </span>
                  {dirty > 0 && <Wrench size={20} color="var(--red)" strokeWidth={2} />}
                </div>
              </div>

              {/* Est. Labor Cost */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#454652', margin: 0 }}>
                  {t('estLaborCost', lang)}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                  <span className="data-mono" style={{ fontSize: '48px', fontWeight: 600, color: '#364262', lineHeight: 1 }}>
                    ${totalCost}
                  </span>
                  <span style={{ fontSize: '14px', color: '#454652' }}>/shift</span>
                </div>
              </div>
            </div>

            {/* Action Buttons — right side */}
            <div style={{ display: 'flex', flexDirection: 'row', gap: '16px' }}>
              <button
                onClick={() => router.push('/front-desk')}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  padding: '16px 32px', borderRadius: '8px',
                  background: '#364262', color: '#FFFFFF',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '15px', fontWeight: 500,
                  boxShadow: '0 4px 14px rgba(54,66,98,0.25)',
                  transition: 'all 0.2s ease',
                }}
              >
                <Clock size={18} />
                {lang === 'es' ? 'Recepción' : 'Front Desk Command'}
              </button>
              <button
                onClick={() => router.push('/roi')}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  padding: '16px 32px', borderRadius: '8px',
                  background: '#006565', color: '#82e2e1',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '15px', fontWeight: 500,
                  boxShadow: '0 4px 14px rgba(0,101,101,0.25)',
                  transition: 'all 0.2s ease',
                }}
              >
                <Sparkles size={18} />
                {lang === 'es' ? 'Analítica ROI' : 'ROI Analytics'}
              </button>
            </div>

          </div>
        </section>

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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '20px', fontWeight: 600, color: '#364262', margin: 0 }}>{lang === 'es' ? 'Huéspedes' : 'Guests'}</h3>
                  <Users size={24} color="#454652" style={{ opacity: 0.5 }} />
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '20px', fontWeight: 600, color: '#364262', margin: 0 }}>{lang === 'es' ? 'Ingresos' : 'Revenue'}</h3>
                  <DollarSign size={24} color="#454652" style={{ opacity: 0.5 }} />
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '20px', fontWeight: 600, color: '#364262', margin: 0 }}>{lang === 'es' ? 'Operaciones' : 'Operations'}</h3>
                  <Wrench size={24} color="#454652" style={{ opacity: 0.5 }} />
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                  <h3 style={{ fontSize: '20px', fontWeight: 600, color: '#364262', margin: 0 }}>{lang === 'es' ? 'Habitaciones' : 'Rooms'}</h3>
                  <TrendingUp size={24} color="#454652" style={{ opacity: 0.5 }} />
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


          </div>

          {/* RIGHT SECTION — 4 columns */}
          <div className="bento-right">
            {/* MORNING CONCIERGE BRIEFING */}
            {(recentHandoffs.length > 0 || openOrders.length > 0) ? (
              <div className="concierge-card animate-in stagger-8" style={{ padding: '32px', minHeight: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
                  <Sparkles size={20} color="#004b4b" fill="#004b4b" />
                  <h3 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.01em' }}>
                    {lang === 'es' ? 'Briefing Concierge Matutino' : 'Morning Concierge Briefing'}
                  </h3>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                  {briefingItems.map(item => (
                    <div key={item.id} style={{ display: 'flex', gap: '16px' }}>
                      <div style={{
                        width: '6px', height: '6px', borderRadius: '50%', marginTop: '8px', flexShrink: 0,
                        background: item.dotClass === 'concierge-dot-red' ? 'var(--red)' : item.dotClass === 'concierge-dot-amber' ? 'var(--amber)' : '#004b4b',
                        boxShadow: item.dotClass === 'concierge-dot-red'
                          ? '0 0 0 4px rgba(186,26,26,0.1)'
                          : item.dotClass === 'concierge-dot-teal'
                            ? '0 0 0 4px rgba(0,75,75,0.1)'
                            : 'none',
                      }} />
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <p className="data-mono" style={{ fontSize: '12px', fontWeight: 500, color: '#454652', margin: 0 }}>
                          {formatTime(item.time)}
                        </p>
                        <p style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>
                          {item.text.length > 140 ? item.text.slice(0, 140) + '…' : item.text}
                        </p>
                      </div>
                    </div>
                  ))}

                  {briefingItems.length === 0 && (
                    <p style={{ fontSize: '14px', color: 'var(--text-muted)', margin: 0, textAlign: 'center', padding: '24px 0' }}>
                      {lang === 'es' ? 'Sin novedades' : 'No updates'}
                    </p>
                  )}
                </div>

                {(recentHandoffs.length + openOrders.length) > 6 && (
                  <div style={{ marginTop: '48px', paddingTop: '32px', borderTop: '1px solid rgba(197,197,212,0.1)' }}>
                    <button style={{
                      width: '100%', padding: '16px',
                      borderRadius: '8px', border: 'none',
                      background: '#e4e2dd', color: '#1b1c19',
                      fontSize: '14px', fontWeight: 500,
                      cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                      transition: 'all 0.15s ease',
                    }}>
                      {lang === 'es' ? 'Expandir Feed Completo' : 'Expand Full Feed'}
                      <ChevronRight size={14} style={{ transform: 'rotate(90deg)' }} />
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
