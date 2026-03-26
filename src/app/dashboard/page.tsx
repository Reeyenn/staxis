'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, getDailyLog, getRecentDailyLogs } from '@/lib/firestore';
import { formatCurrency, todayStr } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { Room, DailyLog } from '@/types';
import { format } from 'date-fns';
import {
  BedDouble, Clock, DollarSign, TrendingUp, Sun, ChevronRight, ArrowRight,
  Bell, Users, Package, BookOpen, Monitor, AlertTriangle, CheckCircle, Zap,
  Sparkles, LayoutGrid, Trophy,
} from 'lucide-react';
import Link from 'next/link';

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();
  const { lang } = useLang();

  const [rooms,      setRooms]      = useState<Room[]>([]);
  const [todayLog,   setTodayLog]   = useState<DailyLog | null>(null);
  const [recentLogs, setRecentLogs] = useState<DailyLog[]>([]);

  // AI staffing — scheduled staff input
  const [scheduledStaff,       setScheduledStaff]       = useState<number | null>(null);
  const [editingScheduled,     setEditingScheduled]     = useState(false);
  const [editingScheduledVal,  setEditingScheduledVal]  = useState(0);

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
    (async () => {
      const [log, recent] = await Promise.all([
        getDailyLog(user.uid, activePropertyId, todayStr()),
        getRecentDailyLogs(user.uid, activePropertyId, 30),
      ]);
      setTodayLog(log);
      setRecentLogs(recent);
    })();
  }, [user, activePropertyId]);

  // Seed scheduled staff from todayLog.actualStaff on first load
  useEffect(() => {
    if (todayLog?.actualStaff && todayLog.actualStaff > 0 && scheduledStaff === null) {
      setScheduledStaff(todayLog.actualStaff);
    }
  }, [todayLog, scheduledStaff]);

  // ── Room stats ──────────────────────────────────────────────────────────────
  const clean      = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const dirty      = rooms.filter(r => r.status === 'dirty').length;
  const total      = rooms.length;
  const progress   = total > 0 ? Math.round((clean / total) * 100) : 0;

  // ── Historical savings ──────────────────────────────────────────────────────
  const weekLogs   = recentLogs.slice(0, 7);
  const weekSaved  = weekLogs.reduce((s, l) => s + (l.laborSaved ?? 0), 0);
  const monthLogs  = recentLogs.slice(0, 30);
  const monthSaved = monthLogs.reduce((s, l) => s + (l.laborSaved ?? 0), 0);

  const chartData  = [...recentLogs].reverse().slice(-14).map(l => ({
    date:  format(new Date(l.date), 'M/d'),
    saved: Math.round(l.laborSaved ?? 0),
  }));

  const weekCost   = weekLogs.reduce((s, l) => s + (l.laborCost ?? 0), 0);
  const weekBudget = activeProperty?.weeklyBudget ?? 0;
  const budgetPct  = weekBudget > 0 ? Math.min((weekCost / weekBudget) * 100, 100) : 0;

  // ── AI Staffing calculation ─────────────────────────────────────────────────
  const checkoutCount  = rooms.filter(r => r.type === 'checkout').length;
  const stayoverCount  = rooms.filter(r => r.type === 'stayover').length;
  const hasRoomData    = checkoutCount + stayoverCount > 0;

  const shiftMins  = activeProperty?.shiftMinutes  ?? 480;
  const wageRate   = activeProperty?.hourlyWage    ?? 15;
  const coMins     = activeProperty?.checkoutMinutes  ?? 30;
  const soMins     = activeProperty?.stayoverMinutes  ?? 20;

  // Total work minutes — prefer todayLog (includes laundry + public areas)
  const totalWorkMins: number | null =
    todayLog?.totalMinutes != null
      ? todayLog.totalMinutes
      : hasRoomData
        ? checkoutCount * coMins + stayoverCount * soMins
        : null;

  // Recommended staff count
  const aiRecommended: number | null =
    todayLog?.recommendedStaff != null
      ? todayLog.recommendedStaff
      : totalWorkMins != null
        ? Math.max(1, Math.ceil(totalWorkMins / shiftMins))
        : null;

  // Delta: positive = overstaffed, negative = understaffed
  const staffDelta: number | null =
    scheduledStaff != null && aiRecommended != null && scheduledStaff > 0
      ? scheduledStaff - aiRecommended
      : null;

  const dollarDelta =
    staffDelta != null ? Math.abs(staffDelta) * wageRate * (shiftMins / 60) : 0;

  const isOverstaffed  = staffDelta != null && staffDelta > 0;
  const isUnderstaffed = staffDelta != null && staffDelta < 0;
  const isPerfect      = staffDelta === 0;

  // Cost if using the recommended count (full shift)
  const recommendedLaborCost =
    aiRecommended != null ? aiRecommended * wageRate * (shiftMins / 60) : null;

  // Room breakdown labels
  const coLabel  = todayLog ? todayLog.checkouts  : checkoutCount;
  const soLabel  = todayLog ? todayLog.stayovers  : stayoverCount;

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  // Border color for the AI card
  const aiBorderColor = isOverstaffed ? 'var(--red)' : isUnderstaffed ? 'var(--yellow)' : isPerfect ? 'var(--green)' : 'var(--amber-border)';

  return (
    <AppLayout>
      <div style={{ padding: '16px 16px 0', display: 'flex', flexDirection: 'column', gap: '2px' }}>

        {/* ── Page header ── */}
        <div className="animate-in" style={{ padding: '8px 0 16px' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>
            {format(new Date(), 'EEEE, MMMM d')}
          </p>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '26px', color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              {t('dashboard', lang)}
            </h1>
            {activeProperty && (
              <span style={{ color: 'var(--amber)', fontSize: '12px', fontWeight: 500 }}>
                {activeProperty.name}
              </span>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════════ */}
        {/* ── AI STAFFING RECOMMENDATION  (core value prop) ── */}
        {/* ══════════════════════════════════════════════════════════════════════ */}
        <div className="animate-in stagger-1" style={{ marginBottom: '8px' }}>
          <div style={{
            background: 'var(--bg-card)',
            border: `2px solid ${aiBorderColor}`,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}>

            {/* Card label row */}
            <div style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'rgba(212,144,64,0.06)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sparkles size={13} color="var(--amber)" />
                <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--amber)' }}>
                  {t('aiStaffingRec', lang)}
                </span>
              </div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500 }}>
                {format(new Date(), 'MMM d')}
              </span>
            </div>

            {/* ── Status banner (only when scheduled entered) ── */}
            {staffDelta !== null && (
              <div style={{
                padding: '13px 14px',
                background: isOverstaffed ? 'rgba(239,68,68,0.1)' : isUnderstaffed ? 'rgba(234,179,8,0.1)' : 'rgba(34,197,94,0.1)',
                borderBottom: '1px solid var(--border)',
              }}>
                {isOverstaffed && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '3px' }}>
                      <AlertTriangle size={17} color="var(--red)" />
                      <span style={{ fontWeight: 700, fontSize: '17px', color: 'var(--red)', lineHeight: 1.2 }}>
                        {t('overstaffedBy', lang)} {staffDelta} {lang === 'es' ? (staffDelta === 1 ? 'persona' : 'personas') : (staffDelta === 1 ? 'person' : 'people')} {lang === 'es' ? 'hoy' : 'today'}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', paddingLeft: '24px' }}>
                      <strong style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{formatCurrency(dollarDelta)}</strong> {t('avoidableLaborCost', lang)}
                    </p>
                  </>
                )}
                {isUnderstaffed && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '3px' }}>
                      <Zap size={17} color="var(--yellow)" />
                      <span style={{ fontWeight: 700, fontSize: '17px', color: 'var(--yellow)', lineHeight: 1.2 }}>
                        {t('understaffedBy', lang)} {Math.abs(staffDelta!)} {lang === 'es' ? (Math.abs(staffDelta!) === 1 ? 'persona' : 'personas') : (Math.abs(staffDelta!) === 1 ? 'person' : 'people')}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', paddingLeft: '24px' }}>
                      {t('roomsMayNotFinish', lang)}
                    </p>
                  </>
                )}
                {isPerfect && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '3px' }}>
                      <CheckCircle size={17} color="var(--green)" />
                      <span style={{ fontWeight: 700, fontSize: '17px', color: 'var(--green)', lineHeight: 1.2 }}>
                        {t('staffedPerfect', lang)}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', paddingLeft: '24px' }}>
                      {t('scheduledMatchesRec', lang)}
                    </p>
                  </>
                )}
              </div>
            )}

            {/* ── Recommended vs Scheduled comparison ── */}
            <div style={{
              padding: '18px 14px',
              display: 'grid',
              gridTemplateColumns: '1fr 28px 1fr',
              gap: '8px',
              alignItems: 'center',
            }}>

              {/* Recommended */}
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  {t('recommended', lang)}
                </p>
                <div style={{
                  fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '56px', lineHeight: 1,
                  letterSpacing: '-0.04em',
                  color: aiRecommended != null ? 'var(--amber)' : 'var(--text-muted)',
                }}>
                  {aiRecommended ?? '—'}
                </div>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '5px' }}>{t('housekeepers', lang).toLowerCase()}</p>
              </div>

              {/* VS divider */}
              <div style={{ textAlign: 'center', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                vs
              </div>

              {/* Scheduled — tap to edit */}
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  {t('scheduled', lang)}
                </p>

                {editingScheduled ? (
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={editingScheduledVal}
                    onChange={e => setEditingScheduledVal(Math.max(0, parseInt(e.target.value) || 0))}
                    onBlur={() => {
                      if (editingScheduledVal > 0) setScheduledStaff(editingScheduledVal);
                      setEditingScheduled(false);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        if (editingScheduledVal > 0) setScheduledStaff(editingScheduledVal);
                        setEditingScheduled(false);
                      }
                      if (e.key === 'Escape') setEditingScheduled(false);
                    }}
                    autoFocus
                    style={{
                      fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '56px', lineHeight: 1,
                      letterSpacing: '-0.04em',
                      color: 'var(--text-primary)',
                      background: 'transparent', border: 'none',
                      borderBottom: '2px solid var(--amber)',
                      width: '80px', textAlign: 'center', outline: 'none',
                    }}
                  />
                ) : (
                  <button
                    onClick={() => { setEditingScheduledVal(scheduledStaff ?? 0); setEditingScheduled(true); }}
                    style={{
                      fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '56px', lineHeight: 1,
                      letterSpacing: '-0.04em',
                      color: scheduledStaff != null
                        ? (isOverstaffed ? 'var(--red)' : isUnderstaffed ? 'var(--yellow)' : 'var(--green)')
                        : 'var(--text-muted)',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      display: 'block', width: '100%',
                    }}
                  >
                    {scheduledStaff ?? '—'}
                  </button>
                )}

                <button
                  onClick={() => { setEditingScheduledVal(scheduledStaff ?? 0); setEditingScheduled(true); }}
                  style={{
                    fontSize: '11px', color: 'var(--amber)', marginTop: '5px',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  {scheduledStaff ? t('tapToEdit', lang) : t('tapToEnter', lang)}
                </button>
              </div>
            </div>

            {/* ── Detail stats row ── */}
            {aiRecommended !== null && (
              <div style={{
                padding: '12px 14px',
                borderTop: '1px solid var(--border)',
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px',
              }}>
                {[
                  {
                    icon: BedDouble,
                    label: t('rooms', lang),
                    value: (coLabel + soLabel) > 0
                      ? `${coLabel}co + ${soLabel}so`
                      : `${aiRecommended} staff`,
                  },
                  {
                    icon: Clock,
                    label: t('totalWork', lang),
                    value: totalWorkMins ? `${(totalWorkMins / 60).toFixed(1)}h` : '—',
                  },
                  {
                    icon: DollarSign,
                    label: t('laborCost', lang),
                    value: recommendedLaborCost != null ? formatCurrency(recommendedLaborCost) : '—',
                  },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <Icon size={13} color="var(--text-muted)" />
                    <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Finish time (from todayLog) */}
            {todayLog?.completionTime && (
              <div style={{
                padding: '9px 14px',
                borderTop: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: '7px',
                background: 'rgba(212,144,64,0.04)',
              }}>
                <Clock size={13} color="var(--amber)" />
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {t('estimatedFinishLabel', lang)}: <strong style={{ color: 'var(--text-primary)' }}>{todayLog.completionTime}</strong>
                </span>
              </div>
            )}

            {/* ── Cumulative savings footer ── */}
            {monthSaved > 0 && (
              <div style={{
                padding: '10px 14px',
                borderTop: '1px solid var(--border)',
                background: 'rgba(34,197,94,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <TrendingUp size={13} color="var(--green)" />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('savedPast30', lang)}</span>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700, color: 'var(--green)' }}>
                  {formatCurrency(monthSaved)}
                </span>
              </div>
            )}

            {/* ── No data state ── */}
            {aiRecommended === null && (
              <div style={{ padding: '20px 14px', textAlign: 'center' }}>
                <Sun size={24} color="var(--amber)" style={{ marginBottom: '10px' }} />
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px', lineHeight: 1.6 }}>
                  {lang === 'es'
                    ? <>Agrega habitaciones de hoy o completa la configuración matutina<br />para ver tu recomendación de personal IA</>
                    : <>Add today&apos;s rooms or complete morning setup<br />to see your AI staffing recommendation</>}
                </p>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                  <Link href="/rooms" style={{ textDecoration: 'none' }}>
                    <span style={{
                      display: 'inline-block', padding: '8px 16px',
                      background: 'rgba(212,144,64,0.12)', border: '1px solid var(--amber-border)',
                      color: 'var(--amber)', borderRadius: 'var(--radius-md)',
                      fontSize: '12px', fontWeight: 600,
                    }}>
                      {t('addRooms', lang)}
                    </span>
                  </Link>
                  <Link href="/morning-setup" style={{ textDecoration: 'none' }}>
                    <span style={{
                      display: 'inline-block', padding: '8px 16px',
                      background: 'var(--amber)', color: '#0A0A0A',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '12px', fontWeight: 600,
                    }}>
                      {t('morningSetup', lang)} →
                    </span>
                  </Link>
                </div>
              </div>
            )}

            {/* Morning setup nudge when we have rooms but no todayLog */}
            {aiRecommended !== null && !todayLog && (
              <Link href="/morning-setup" style={{ textDecoration: 'none', display: 'block' }}>
                <div style={{
                  padding: '9px 14px',
                  borderTop: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: '7px',
                  cursor: 'pointer',
                }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', flex: 1 }}>
                    {t('runMorningSetup', lang)}
                  </span>
                  <ArrowRight size={13} color="var(--amber)" />
                </div>
              </Link>
            )}
          </div>
        </div>

        {/* ── Room stats row ── */}
        <div className="animate-in stagger-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '8px' }}>
          {[
            { label: t('clean', lang),      count: clean,      dotClass: 'dot-green',  color: 'var(--green)'  },
            { label: t('inProgress', lang), count: inProgress, dotClass: 'dot-yellow', color: 'var(--yellow)' },
            { label: t('dirty', lang),      count: dirty,      dotClass: 'dot-red',    color: 'var(--red)'    },
          ].map(({ label, count, dotClass, color }) => (
            <div key={label} className="card" style={{ padding: '14px 12px', textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', marginBottom: '6px' }}>
                <span className={`dot ${dotClass}`} />
                <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  {label}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '32px', color, lineHeight: 1, letterSpacing: '-0.03em' }}>
                {count}
              </div>
            </div>
          ))}
        </div>

        {/* ── Progress bar (only when rooms exist) ── */}
        {total > 0 && (
          <div className="card-flat animate-in stagger-1" style={{ padding: '12px 14px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{clean} {t('roomsCompleteOf', lang)} {total} {t('roomsCompleteLabel', lang)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: progress === 100 ? 'var(--green)' : 'var(--amber)' }}>
                {progress}%
              </span>
            </div>
            <div className="progress-track progress-track-lg">
              <div className="progress-fill" style={{ width: `${progress}%`, background: progress === 100 ? 'var(--green)' : 'var(--amber)' }} />
            </div>
          </div>
        )}

        {/* ── Savings row ── */}
        <div className="animate-in stagger-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          {[
            { label: t('thisWeek', lang),  value: formatCurrency(weekSaved)  },
            { label: t('thisMonth', lang), value: formatCurrency(monthSaved) },
          ].map(({ label, value }) => (
            <div key={label} className="card">
              <p className="stat-label" style={{ marginBottom: '6px' }}>{label}</p>
              <div className="stat-number" style={{ fontSize: '28px', color: 'var(--green)' }}>{value}</div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{t('laborSavedSuffix', lang)}</p>
            </div>
          ))}
        </div>

        {/* ── Weekly budget ── */}
        {weekBudget > 0 && (
          <div className="card animate-in stagger-3" style={{ marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>{t('weeklyBudgetLabel', lang)}</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 600,
                color: budgetPct > 90 ? 'var(--red)' : budgetPct > 75 ? 'var(--yellow)' : 'var(--green)',
              }}>
                {formatCurrency(weekCost)} / {formatCurrency(weekBudget)}
              </span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{
                width: `${budgetPct}%`,
                background: budgetPct > 90 ? 'var(--red)' : budgetPct > 75 ? 'var(--yellow)' : 'var(--green)',
              }} />
            </div>
          </div>
        )}

        {/* ── Chart ── */}
        {chartData.length > 2 && (
          <div className="card animate-in stagger-3" style={{ marginBottom: '8px' }}>
            <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '12px' }}>
              {t('dailySavingsChart', lang)} {chartData.length} {t('daysLabel', lang)}
            </p>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={chartData}>
                <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  formatter={(v: number) => [formatCurrency(v), 'Saved']}
                />
                <Line type="monotone" dataKey="saved" stroke="var(--green)" strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: 'var(--green)', stroke: 'var(--bg)', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Room queue link ── */}
        <Link href="/rooms" style={{ textDecoration: 'none', display: 'block', marginBottom: '8px' }} className="animate-in stagger-4">
          <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <BedDouble size={16} color="var(--text-muted)" />
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 500, fontSize: '14px', color: 'var(--text-primary)' }}>{t('roomPriorityQueue', lang)}</p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '1px' }}>{dirty + inProgress} {t('roomsRemainingLabel', lang)}</p>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" />
          </div>
        </Link>

        {/* ── Quick access grid ── */}
        <div className="animate-in stagger-4" style={{ marginBottom: '16px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {t('operations', lang)}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
            {[
              { href: '/requests',     icon: Bell,        label: t('guestRequests', lang),    sub: t('guestRequestsSub', lang)   },
              { href: '/staff',        icon: Users,       label: t('staffRosterLabel', lang),  sub: t('staffRosterSub', lang)     },
              { href: '/inventory',    icon: Package,     label: t('inventoryLabel', lang),    sub: t('inventorySub', lang)       },
              { href: '/logbook',      icon: BookOpen,    label: t('shiftLogbookLabel', lang), sub: t('shiftLogbookSub', lang)    },
              { href: '/ops-wall',     icon: Monitor,     label: t('opsWallLabel', lang),      sub: t('opsWallSub', lang)         },
              { href: '/war-room',     icon: LayoutGrid,  label: t('warRoom', lang),           sub: t('warRoomSub', lang)         },
              { href: '/performance',  icon: Trophy,      label: t('teamPerformance', lang),   sub: t('performanceSub', lang)     },
            ].map(({ href, icon: Icon, label, sub }) => (
              <Link key={href} href={href} style={{ textDecoration: 'none' }}>
                <div className="card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '9px',
                    background: 'rgba(212,144,64,0.1)', border: '1px solid var(--amber-border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon size={15} color="var(--amber)" />
                  </div>
                  <div>
                    <p style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', marginBottom: '2px' }}>{label}</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{sub}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

      </div>
    </AppLayout>
  );
}
