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
  Users, DollarSign,
  Sparkles, CircleDot, DoorOpen,
} from 'lucide-react';

/* ── Room grid helper ── */
function RoomGrid({ rooms }: { rooms: Room[] }) {
  // Group by floor (first digit of room number, e.g. "101" → floor 1)
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
              Floor {floor}
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
                  {/* Red dot for checkout rooms that are dirty */}
                  {isDirty && room.type === 'checkout' && (
                    <div style={{
                      position: 'absolute', top: '2px', right: '2px',
                      width: '5px', height: '5px', borderRadius: '50%',
                      background: '#DC2626',
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
  const checkouts  = rooms.filter(r => r.type === 'checkout').length;
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
    <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
      <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', marginBottom: '2px' }}>{label}</p>
        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '22px', lineHeight: 1, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
          {value}
        </div>
        {sub && <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</p>}
      </div>
    </div>
  );

  return (
    <AppLayout>
      <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}>

        {/* ── Page header ── */}
        <div className="animate-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
              {t('dashboard', lang)}
            </h1>
          </div>
        </div>

        {/* ── Stat cards - full-width row ── */}
        <div className="animate-in stagger-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          <StatCard
            icon={<Users size={16} color="#16A34A" />}
            iconBg="rgba(22,163,74,0.08)"
            label={lang === 'es' ? 'Equipo Mañana' : 'Staff Tomorrow'}
            value={confirmedCount}
            sub={`${tomorrowConfs.length} ${lang === 'es' ? 'contactados' : 'contacted'}`}
          />
          <StatCard
            icon={<DollarSign size={16} color="#CA8A04" />}
            iconBg="rgba(202,138,4,0.08)"
            label={lang === 'es' ? 'Costo Estimado' : 'Est. Labor Cost'}
            value={total > 0 ? `$${Math.round(total * 3.2)}` : '-'}
            sub={lang === 'es' ? 'hoy' : 'today'}
          />
          <StatCard
            icon={<AlertTriangle size={16} color="#DC2626" />}
            iconBg="rgba(220,38,38,0.08)"
            label={lang === 'es' ? 'Sucias' : 'Dirty Rooms'}
            value={dirty}
            sub={lang === 'es' ? 'pendientes' : 'need cleaning'}
          />
          <StatCard
            icon={<DoorOpen size={16} color="var(--navy)" />}
            iconBg="rgba(27,58,92,0.08)"
            label={lang === 'es' ? 'Salidas Hoy' : 'Checkouts Today'}
            value={checkouts}
            sub={lang === 'es' ? 'habitaciones' : 'rooms'}
          />
        </div>

        {/* ── Main content - two columns side by side ── */}
        <div className="animate-in stagger-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', flex: 1, minHeight: 0 }}>

          {/* LEFT: Room status + grid */}
          <div className="card" onClick={() => { localStorage.setItem('hk-tab', 'rooms'); router.push('/housekeeping'); }} style={{ padding: '18px', display: 'flex', flexDirection: 'column', overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 150ms', }} onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--navy-light)')} onMouseLeave={e => (e.currentTarget.style.boxShadow = '')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Sparkles size={14} color="var(--navy-light)" />
              <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {lang === 'es' ? 'Estado de Habitaciones' : 'Room Status'}
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
                {lang === 'es' ? 'No hay habitaciones asignadas hoy.' : 'No rooms assigned today.'}
              </div>
            ) : (
              <>
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  <RoomGrid rooms={rooms} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    {[
                      { dot: '#86EFAC', bg: '#DCFCE7', label: lang === 'es' ? 'Limpia' : 'Clean', count: clean },
                      { dot: '#FCD34D', bg: '#FEF9C3', label: lang === 'es' ? 'Progreso' : 'Progress', count: inProgress },
                      { dot: '#FCA5A5', bg: '#FEE2E2', label: lang === 'es' ? 'Sucia' : 'Dirty', count: dirty },
                    ].map(({ dot, bg, label, count }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{ width: '9px', height: '9px', borderRadius: '2px', background: bg, border: `1.5px solid ${dot}`, flexShrink: 0 }} />
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
                          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{count}</span> {label}
                        </span>
                      </div>
                    ))}
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, flexShrink: 0 }}>{total} total</span>
                </div>
              </>
            )}
          </div>

          {/* RIGHT: Tomorrow's crew */}
          <div className="card" onClick={() => { localStorage.setItem('hk-tab', 'schedule'); router.push('/housekeeping'); }} style={{ padding: '18px', display: 'flex', flexDirection: 'column', overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 150ms' }} onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--navy-light)')} onMouseLeave={e => (e.currentTarget.style.boxShadow = '')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
              <Users size={14} color="var(--navy-light)" />
              <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
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
                  {lang === 'es' ? 'No hay confirmaciones aún - ve a Housekeeping › Schedule para enviar.' : 'No confirmations yet - go to Housekeeping › Schedule to send.'}
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

        </div>{/* end two-column grid */}

      </div>
    </AppLayout>
  );
}
