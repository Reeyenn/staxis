'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, subscribeToShiftConfirmations } from '@/lib/firestore';
import { todayStr } from '@/lib/utils';
import type { Room, ShiftConfirmation, ConfirmationStatus } from '@/types';
import { format } from 'date-fns';
import {
  CheckCircle2, XCircle, Clock, AlertTriangle,
  BedDouble, Users, DollarSign, Timer,
  Sparkles, CircleDot,
} from 'lucide-react';

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

  const clean      = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const dirty      = rooms.filter(r => r.status === 'dirty').length;
  const total      = rooms.length;
  const pct        = total > 0 ? Math.round((clean / total) * 100) : 0;

  const confirmedCount = tomorrowConfs.filter(c => c.status === 'confirmed').length;

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  /* ── Stat card helper ── */
  const StatCard = ({ icon, iconBg, label, value, sub }: { icon: React.ReactNode; iconBg: string; label: string; value: string | number; sub?: string }) => (
    <div className="card" style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>{label}</span>
        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </div>
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '28px', lineHeight: 1, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
          {value}
        </div>
        {sub && <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{sub}</p>}
      </div>
    </div>
  );

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* ── Page header ── */}
        <div className="animate-in">
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
            {format(new Date(), 'EEEE, MMMM d')}
          </p>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '24px', color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              {t('dashboard', lang)}
            </h1>
            {activeProperty && (
              <span style={{ color: 'var(--navy-light)', fontSize: '13px', fontWeight: 600 }}>
                {activeProperty.name}
              </span>
            )}
          </div>
        </div>

        {/* ── Summary stat cards — 2x2 grid ── */}
        <div className="animate-in stagger-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
          <StatCard
            icon={<BedDouble size={18} color="#1B3A5C" />}
            iconBg="rgba(27,58,92,0.08)"
            label={lang === 'es' ? 'Habitaciones' : 'Rooms Today'}
            value={total}
            sub={`${pct}% ${t('complete', lang).toLowerCase()}`}
          />
          <StatCard
            icon={<Users size={18} color="#16A34A" />}
            iconBg="rgba(22,163,74,0.08)"
            label={lang === 'es' ? 'Equipo Mañana' : 'Staff Tomorrow'}
            value={confirmedCount}
            sub={`${tomorrowConfs.length} ${lang === 'es' ? 'contactados' : 'contacted'}`}
          />
          <StatCard
            icon={<DollarSign size={18} color="#CA8A04" />}
            iconBg="rgba(202,138,4,0.08)"
            label={lang === 'es' ? 'Costo Estimado' : 'Est. Labor Cost'}
            value={total > 0 ? `$${Math.round(total * 3.2)}` : '—'}
            sub={lang === 'es' ? 'hoy' : 'today'}
          />
          <StatCard
            icon={<Timer size={18} color="#7C3AED" />}
            iconBg="rgba(124,58,237,0.08)"
            label={lang === 'es' ? 'Hora Estimada' : 'Est. Done By'}
            value={total > 0 ? '2 PM' : '—'}
            sub={lang === 'es' ? 'finalización' : 'completion'}
          />
        </div>

        {/* ── Room status card ── */}
        <div className="animate-in stagger-2">
          <div className="card" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Sparkles size={16} color="var(--navy-light)" />
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {lang === 'es' ? 'Estado de Habitaciones' : 'Room Status'}
              </h2>
              <span style={{ marginLeft: 'auto', fontSize: '13px', fontWeight: 600, color: 'var(--green)' }}>
                {pct}%
              </span>
            </div>

            {/* Progress bar */}
            <div style={{ height: '8px', background: '#E5E7EB', borderRadius: '4px', overflow: 'hidden', marginBottom: '16px' }}>
              <div style={{
                height: '100%', borderRadius: '4px', transition: 'width 500ms ease',
                width: `${pct}%`,
                background: pct === 100 ? 'var(--green)' : 'var(--navy-light)',
              }} />
            </div>

            {/* Status breakdown row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {[
                { label: lang === 'es' ? 'Total'      : 'Total',       count: total,      color: 'var(--text-primary)', bg: 'rgba(0,0,0,0.03)' },
                { label: t('clean', lang),                              count: clean,      color: 'var(--green)',        bg: 'rgba(22,163,74,0.06)' },
                { label: t('inProgress', lang),                         count: inProgress, color: 'var(--yellow)',       bg: 'rgba(202,138,4,0.06)' },
                { label: t('dirty', lang),                              count: dirty,      color: 'var(--red)',          bg: 'rgba(220,38,38,0.06)' },
              ].map(({ label, count, color, bg }) => (
                <div key={label} style={{ textAlign: 'center', padding: '12px 4px', borderRadius: 'var(--radius-md)', background: bg }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '24px', color, lineHeight: 1 }}>{count}</div>
                  <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Tomorrow's crew ── */}
        <div className="animate-in stagger-3">
          <div className="card" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Users size={16} color="var(--navy-light)" />
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {lang === 'es' ? 'Equipo de Mañana' : "Tomorrow's Crew"}
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
                background: 'rgba(0,0,0,0.02)', border: '1px dashed var(--border)',
              }}>
                <CircleDot size={24} color="var(--text-muted)" style={{ margin: '0 auto 8px' }} />
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {lang === 'es' ? 'No hay confirmaciones aún — ve a Housekeeping › Schedule para enviar.' : 'No confirmations yet — go to Housekeeping › Schedule to send.'}
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {tomorrowConfs.map(conf => {
                  const badge = STATUS_BADGE[conf.status];
                  return (
                    <div key={conf.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', background: 'rgba(0,0,0,0.02)',
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                    }}>
                      {/* Left: avatar + name */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          width: '32px', height: '32px', borderRadius: '50%',
                          background: 'var(--navy)', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '12px', fontWeight: 700, flexShrink: 0,
                        }}>
                          {(conf.staffName || '?')[0].toUpperCase()}
                        </div>
                        <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>
                          {conf.staffName}
                        </span>
                      </div>

                      {/* Right: status badge */}
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '4px 10px', borderRadius: 'var(--radius-full)',
                        background: badge.bg, color: badge.color,
                        fontSize: '12px', fontWeight: 600,
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

      </div>
    </AppLayout>
  );
}
