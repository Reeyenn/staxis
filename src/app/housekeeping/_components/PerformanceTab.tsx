// Split from the housekeeping/page.tsx monolith on 2026-04-27.
// Shared helpers / constants / components are imported from ./_shared.
// Only this tab's section logic lives here.

'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
import { useSyncContext } from '@/contexts/SyncContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  subscribeToRooms, subscribeToAllRooms, updateRoom, addRoom,
  addStaffMember, updateStaffMember, deleteStaffMember,
  getRoomsForDate, getPublicAreas, setPublicArea, deletePublicArea,
  updateProperty,
  getDeepCleanConfig, setDeepCleanConfig, getDeepCleanRecords,
  markRoomDeepCleaned, assignRoomDeepClean, completeRoomDeepClean,
  subscribeToPlanSnapshot,
  subscribeToShiftConfirmations,
  subscribeToScheduleAssignments,
  saveScheduleAssignments,
  subscribeToDashboardNumbers,
  getDashboardForDate,
  subscribeToWorkOrders,
} from '@/lib/db';
import type { PlanSnapshot, ScheduleAssignments, CsvRoomSnapshot, DashboardNumbers } from '@/lib/db';
import { dashboardFreshness, DASHBOARD_STALE_MINUTES } from '@/lib/db';
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms, getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { getDefaultPublicAreas } from '@/lib/defaults';
import type { PublicArea } from '@/types';
import { todayStr, errToString } from '@/lib/utils';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus, RoomType, RoomPriority, StaffMember, DeepCleanRecord, DeepCleanConfig, ShiftConfirmation, ConfirmationStatus, WorkOrder } from '@/types';
import { format, subDays } from 'date-fns';
import {
  Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CheckCircle2, Clock,
  AlertTriangle, Users, Send, Zap, BedDouble, Plus, Pencil, Trash2, Star, Check,
  Trophy, TrendingUp, TrendingDown, Minus, Upload, Settings,
  Search, XCircle, Home, ArrowRightLeft, Sparkles, Ban, RefreshCw,
  Link2, Copy,
} from 'lucide-react';

import {
  TABS,
  schedTodayStr, addDays, defaultShiftDate, formatPulledAt, formatDisplayDate,
  isEligible, PRIORITY_ORDER, snapshotToShiftRooms, autoSelectEligible,
  STAFF_COLORS,
  toDate, fmtMins, HKInitials, buildLive, buildHistory,
  PaceBadge, RankBadge, StatPill,
  EMPTY_FORM, staffInitials,
  getFloor, ROOM_ACTION_COLOR,
  paFloorLabel, freqLabel, FrequencySlider, AREA_NAME_ES, areaDisplayName,
  PublicAreasModal, PA_FLOOR_VALUES, SLIDER_MAX,
} from './_shared';
import type { TabKey, HKLive, HKHistory, StaffFormData } from './_shared';


// ══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE SECTION
// ══════════════════════════════════════════════════════════════════════════════

type ViewMode = 'live' | '7d' | '14d' | '30d' | '3mo' | '1yr' | 'all';

const VIEW_DAYS: Record<ViewMode, number> = { live: 0, '7d': 7, '14d': 14, '30d': 30, '3mo': 90, '1yr': 365, all: 730 };


function PerformanceTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const { lang } = useLang();
  const today = useTodayStr();

  const [view, setView] = useState<ViewMode>('live');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [historyRooms, setHistoryRooms] = useState<Room[][]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const soMins = activeProperty?.stayoverMinutes ?? 20;

  useEffect(() => {
    if (!user || !activePropertyId) return;
    // `today` is reactive — at midnight Central it flips and we re-subscribe
    // to the new day's bucket. Without this, leaving the page open overnight
    // silently keeps reading yesterday's rooms.
    return subscribeToRooms(user.uid, activePropertyId, today, setRooms);
  }, [user, activePropertyId, today]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadHistory = useCallback(async (days: number) => {
    if (!user || !activePropertyId) return;
    setHistoryLoading(true);
    try {
      const dates = Array.from({ length: days }, (_, i) => format(subDays(new Date(), i + 1), 'yyyy-MM-dd'));
      const results = await Promise.all(dates.map(d => getRoomsForDate(user.uid, activePropertyId, d)));
      setHistoryRooms(results);
    } catch (err) {
      console.error('Error loading performance history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [user, activePropertyId]);

  useEffect(() => {
    const days = VIEW_DAYS[view];
    if (days > 0) loadHistory(days);
  }, [view, loadHistory]);

  const livePerfs    = buildLive(rooms, coMins, soMins, nowMs);
  const historyPerfs = buildHistory(historyRooms);

  const todayDone = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const todayTurnaround = (() => {
    const timed = rooms.filter(r => r.startedAt && r.completedAt).map(r => {
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (!s || !e) return null;
      return (e.getTime() - s.getTime()) / 60_000;
    }).filter((m): m is number => m !== null && m > 0);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  })();

  const scheduledToday  = staff.filter(s => s.scheduledToday);
  const unassignedToday = scheduledToday.filter(s => !livePerfs.find(p => p.staffId === s.id));
  const viewDays        = VIEW_DAYS[view] || 14;
  const topHistoryPerf  = historyPerfs[0];

  // ── Computed metrics for sidebar ──
  const coTimedRooms = rooms.filter(r => r.type === 'checkout' && r.startedAt && r.completedAt).map(r => {
    const s = toDate(r.startedAt); const e = toDate(r.completedAt);
    if (!s || !e) return null;
    return (e.getTime() - s.getTime()) / 60_000;
  }).filter((m): m is number => m !== null && m > 0);
  const soTimedRooms = rooms.filter(r => r.type === 'stayover' && r.startedAt && r.completedAt).map(r => {
    const s = toDate(r.startedAt); const e = toDate(r.completedAt);
    if (!s || !e) return null;
    return (e.getTime() - s.getTime()) / 60_000;
  }).filter((m): m is number => m !== null && m > 0);
  const avgCoMins = coTimedRooms.length > 0 ? Math.round(coTimedRooms.reduce((a, b) => a + b, 0) / coTimedRooms.length) : null;
  const avgSoMins = soTimedRooms.length > 0 ? Math.round(soTimedRooms.reduce((a, b) => a + b, 0) / soTimedRooms.length) : null;
  const coVar = avgCoMins !== null ? avgCoMins - coMins : null;
  const soVar = avgSoMins !== null ? avgSoMins - soMins : null;
  const coFmtMin = avgCoMins !== null ? `${Math.floor(avgCoMins)}:${String(Math.round(avgCoMins % 1 * 60)).padStart(2, '0')}` : '--:--';
  const soFmtMin = avgSoMins !== null ? `${Math.floor(avgSoMins)}:${String(Math.round(avgSoMins % 1 * 60)).padStart(2, '0')}` : '--:--';

  // ── Leaderboard data (merged from livePerfs + LeaderboardCard logic) ──
  const leaderboardData = (() => {
    if (view === 'live') {
      const map = new Map<string, { name: string; cleaned: number; totalMinutes: number; inspected: number }>();
      rooms.filter(r => r.assignedTo && (r.status === 'clean' || r.status === 'inspected' || r.status === 'in_progress'))
        .forEach(room => {
          const entry = map.get(room.assignedTo!) ?? { name: room.assignedName ?? 'Unknown', cleaned: 0, totalMinutes: 0, inspected: 0 };
          if (room.status === 'clean' || room.status === 'inspected') {
            entry.cleaned++;
            const s = toDate(room.startedAt); const e = toDate(room.completedAt);
            if (s && e) { const mins = (e.getTime() - s.getTime()) / 60000; if (mins > 0 && mins < 480) entry.totalMinutes += mins; }
          }
          if (room.status === 'inspected') entry.inspected++;
          map.set(room.assignedTo!, entry);
        });
      const maxCleaned = Math.max(...Array.from(map.values()).map(s => s.cleaned), 1);
      return Array.from(map.values())
        .map(s => ({ ...s, avgMinutes: s.cleaned > 0 ? Math.round(s.totalMinutes / s.cleaned) : 0, efficiency: s.cleaned > 0 ? Math.round((s.inspected / s.cleaned) * 100) : 0, score: s.cleaned > 0 ? Math.round((s.cleaned / maxCleaned) * 10 * 10) / 10 : 0 }))
        .sort((a, b) => b.cleaned - a.cleaned);
    } else {
      const maxDone = Math.max(...historyPerfs.map(p => p.totalDone), 1);
      return historyPerfs.map(p => ({ name: p.name, cleaned: p.totalDone, totalMinutes: 0, inspected: 0, avgMinutes: p.avgCleanMins ?? 0, efficiency: 0, score: Math.round((p.totalDone / maxDone) * 10 * 10) / 10 }));
    }
  })();

  // AI insight text
  const aiInsightText = (() => {
    if (leaderboardData.length === 0) return lang === 'es' ? 'No hay suficientes datos para generar información.' : 'Not enough data to generate insights yet.';
    const top = leaderboardData[0];
    const totalCleaned = leaderboardData.reduce((s, p) => s + p.cleaned, 0);
    const avgEff = leaderboardData.length > 0 ? Math.round(leaderboardData.reduce((s, p) => s + (p.efficiency || 0), 0) / leaderboardData.length) : 0;
    if (todayTurnaround !== null && todayTurnaround < coMins) {
      return lang === 'es'
        ? `El tiempo promedio de limpieza es ${todayTurnaround}m — ${coMins - todayTurnaround}m por debajo del objetivo. ${top.name} lidera con ${top.cleaned} habitaciones.`
        : `Average clean time is ${todayTurnaround}m — ${coMins - todayTurnaround}m below target. ${top.name} leads with ${top.cleaned} rooms.`;
    }
    return lang === 'es'
      ? `${totalCleaned} habitaciones completadas este período. ${top.name} lidera el equipo con ${top.cleaned} habitaciones y un promedio de ${top.avgMinutes}m por habitación.`
      : `${totalCleaned} rooms completed this period. ${top.name} leads the team with ${top.cleaned} rooms and an average of ${top.avgMinutes}m per room.`;
  })();

  return (
    <div style={{ padding: '24px', maxWidth: '1600px', margin: '0 auto', minHeight: 'calc(100dvh - 120px)' }}>

      {/* ── Header + Time-range Filter ── */}
      <header style={{ marginBottom: '40px', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(24px, 3vw, 36px)', fontWeight: 600, letterSpacing: '-0.02em', color: '#1b1c19', marginBottom: '6px' }}>
            {lang === 'es' ? 'Rendimiento del Equipo' : 'Housekeeping Performance'}
          </h1>
          <p style={{ color: '#454652', fontSize: '16px' }}>
            {lang === 'es' ? 'Eficiencia operacional y clasificaciones del equipo' : 'Operational efficiency and team leaderboards'}
          </p>
        </div>
        <div style={{ background: '#f5f3ee', padding: '6px', borderRadius: '16px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          {([
            { key: 'live' as ViewMode, label: lang === 'es' ? 'En Vivo' : 'Live' },
            { key: '7d'  as ViewMode, label: lang === 'es' ? '7 Días' : '7 Days' },
            { key: '30d' as ViewMode, label: lang === 'es' ? '30 Días' : '30 Days' },
            { key: '3mo' as ViewMode, label: lang === 'es' ? '6 Meses' : '6 Months' },
            { key: '1yr' as ViewMode, label: lang === 'es' ? '1 Año' : '1 Year' },
          ]).map(({ key, label }) => (
            <button key={key} onClick={() => setView(key)} style={{
              padding: '10px 20px', borderRadius: '12px', fontSize: '14px', fontWeight: 500,
              transition: 'all 200ms', cursor: 'pointer', border: 'none',
              background: view === key ? '#ffffff' : 'transparent',
              color: view === key ? '#1b1c19' : '#454652',
              boxShadow: view === key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}>
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Main Grid: Leaderboard (70%) + Sidebar (30%) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '32px' }}>
        <div className="perf-grid" style={{ display: 'grid', gap: '32px', alignItems: 'start' }}>
          <style>{`.perf-grid { grid-template-columns: 1fr; } @media (min-width: 768px) { .perf-grid { grid-template-columns: 7fr 3fr; } }`}</style>

          {/* ── LEFT: Team Leaderboard ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ background: '#ffffff', padding: '32px', borderRadius: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
                <h2 style={{ fontSize: '22px', fontWeight: 600, color: '#1b1c19' }}>
                  {lang === 'es' ? 'Clasificación del Equipo' : 'Team Leaderboard'}
                </h2>
                <button style={{ color: '#364262', fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {lang === 'es' ? 'Exportar Reporte' : 'Export Report'} <span style={{ fontSize: '16px' }}>↓</span>
                </button>
              </div>

              {/* Loading state */}
              {view !== 'live' && historyLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                  <div className="spinner" style={{ width: '30px', height: '30px' }} />
                </div>
              )}

              {/* Empty state */}
              {leaderboardData.length === 0 && !(view !== 'live' && historyLoading) && (
                <div style={{ textAlign: 'center', padding: '52px 20px' }}>
                  <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={28} color="#757684" />
                  </div>
                  <p style={{ color: '#454652', fontSize: '15px', fontWeight: 500 }}>{t('noActivityToday', lang)}</p>
                  {view !== 'live' && (
                    <p style={{ color: '#757684', fontSize: '13px', marginTop: '6px' }}>
                      {lang === 'es' ? `Los datos aparecerán aquí después de que el equipo complete habitaciones en los últimos ${viewDays} días.` : `Data will appear here after the team completes rooms over the past ${viewDays} days.`}
                    </p>
                  )}
                </div>
              )}

              {/* Leaderboard table */}
              {leaderboardData.length > 0 && (
                <div>
                  {/* Header row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 100px 100px 80px', padding: '0 20px 12px', borderBottom: 'none' }}>
                    {[
                      lang === 'es' ? 'Rango' : 'Rank',
                      lang === 'es' ? 'Especialista' : 'Specialist',
                      lang === 'es' ? 'Hab.' : 'Rooms',
                      lang === 'es' ? 'Eficiencia' : 'Efficiency',
                      lang === 'es' ? 'Puntos' : 'Score',
                    ].map(h => (
                      <div key={h} style={{ fontSize: '12px', fontWeight: 500, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: h === (lang === 'es' ? 'Rango' : 'Rank') || h === (lang === 'es' ? 'Especialista' : 'Specialist') ? 'left' : 'right' }}>
                        {h}
                      </div>
                    ))}
                  </div>

                  {/* Rows */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                    {leaderboardData.map((s, i) => {
                      const initials = s.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                      const effPct = s.avgMinutes > 0 && s.avgMinutes <= coMins ? Math.round((1 - (s.avgMinutes - soMins) / (coMins - soMins + 1)) * 100) : s.cleaned > 0 ? Math.round(Math.min(100, (1 - Math.max(0, s.avgMinutes - coMins) / coMins) * 100)) : 0;
                      const effDisplay = s.cleaned > 0 ? `${Math.min(99, Math.max(50, effPct))}%` : '-';
                      return (
                        <div key={s.name} style={{
                          display: 'grid', gridTemplateColumns: '60px 1fr 100px 100px 80px', alignItems: 'center',
                          padding: '16px 20px', background: 'rgba(245,243,238,0.4)', borderRadius: '16px',
                          transition: 'background 200ms',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ee'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245,243,238,0.4)'; }}
                        >
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', color: '#454652' }}>
                            {String(i + 1).padStart(2, '0')}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <div style={{
                              width: '44px', height: '44px', borderRadius: '50%', background: '#eae8e3',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontWeight: 700, fontSize: '14px', color: '#364262', flexShrink: 0,
                              border: '2px solid #ffffff',
                            }}>
                              {initials}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: '15px', color: '#1b1c19' }}>{s.name}</div>
                              <div style={{ fontSize: '13px', color: '#454652' }}>
                                {s.avgMinutes > 0 ? `${s.avgMinutes}m avg` : (lang === 'es' ? 'Especialista' : 'Specialist')}
                              </div>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '16px', color: '#1b1c19' }}>
                            {s.cleaned}
                          </div>
                          <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '16px', color: '#006565' }}>
                            {effDisplay}
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{
                              background: '#364262', color: '#ffffff', padding: '4px 12px', borderRadius: '9999px',
                              fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', letterSpacing: '-0.02em',
                            }}>
                              {s.score.toFixed(1)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ── AI Operational Insight ── */}
            <div style={{ background: '#ffffff', padding: '28px', borderRadius: '24px', position: 'relative', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              {/* Shimmer border effect */}
              <div style={{ position: 'absolute', inset: '-1px', padding: '1px', borderRadius: '24px', background: 'linear-gradient(135deg, rgba(78,90,122,0.2), rgba(0,101,101,0.2))', mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude', pointerEvents: 'none' }} />
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                <div style={{ width: '44px', height: '44px', borderRadius: '14px', background: 'rgba(0,101,101,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Zap size={20} style={{ color: '#006565' }} fill="#006565" />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 600, color: '#006565', textTransform: 'uppercase', letterSpacing: '0.15em', fontSize: '11px' }}>
                      {lang === 'es' ? 'Información Operacional IA' : 'AI Operational Insight'}
                    </span>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#006565', animation: 'pulse 2s ease-in-out infinite' }} />
                  </div>
                  <p style={{ fontSize: '16px', color: '#1b1c19', lineHeight: 1.6 }}>{aiInsightText}</p>
                </div>
              </div>
              <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
            </div>
          </div>

          {/* ── RIGHT: Cleaning Efficiency Sidebar ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ background: '#f0eee9', padding: '28px', borderRadius: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '28px', display: 'flex', alignItems: 'center', gap: '8px', color: '#1b1c19' }}>
                <Clock size={18} style={{ color: '#364262' }} />
                {lang === 'es' ? 'Eficiencia de Limpieza' : 'Cleaning Efficiency'}
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                {/* Checkout Rooms */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '10px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#454652' }}>
                      {lang === 'es' ? 'Habitaciones Checkout' : 'Checkout Rooms'}
                    </span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '28px', fontWeight: 500, color: '#1b1c19' }}>{coFmtMin}</span>
                      <span style={{ display: 'block', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#454652' }}>avg minutes</span>
                    </div>
                  </div>
                  <div style={{ height: '10px', width: '100%', background: '#eae8e3', borderRadius: '9999px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#364262', borderRadius: '9999px', transition: 'width 400ms', width: avgCoMins !== null ? `${Math.min(100, (avgCoMins / (coMins * 1.5)) * 100)}%` : '0%' }} />
                  </div>
                  <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: '#454652' }}>
                    <span>{lang === 'es' ? 'Objetivo' : 'Target'} {coMins}:00</span>
                    <span style={{ color: coVar !== null && coVar > 0 ? '#ba1a1a' : '#006565', fontWeight: 700 }}>
                      {coVar !== null ? `${coVar > 0 ? '+' : ''}${coVar}:00 VAR` : '-'}
                    </span>
                  </div>
                </div>

                {/* Stayover Rooms */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '10px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#454652' }}>
                      {lang === 'es' ? 'Habitaciones Stayover' : 'Stayover Rooms'}
                    </span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '28px', fontWeight: 500, color: '#1b1c19' }}>{soFmtMin}</span>
                      <span style={{ display: 'block', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#454652' }}>avg minutes</span>
                    </div>
                  </div>
                  <div style={{ height: '10px', width: '100%', background: '#eae8e3', borderRadius: '9999px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#006565', borderRadius: '9999px', transition: 'width 400ms', width: avgSoMins !== null ? `${Math.min(100, (avgSoMins / (soMins * 1.5)) * 100)}%` : '0%' }} />
                  </div>
                  <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: '#454652' }}>
                    <span>{lang === 'es' ? 'Objetivo' : 'Target'} {soMins}:00</span>
                    <span style={{ color: soVar !== null && soVar > 0 ? '#ba1a1a' : '#006565', fontWeight: 700 }}>
                      {soVar !== null ? `${soVar > 0 ? '+' : ''}${soVar}:00 VAR` : '-'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Performance Shift */}
              <div style={{ marginTop: '36px', padding: '20px', background: '#ffffff', borderRadius: '16px', border: '1px solid rgba(197,197,212,0.1)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <Trophy size={16} style={{ color: '#506071' }} />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>
                    {lang === 'es' ? 'Cambio de Rendimiento' : 'Performance Shift'}
                  </span>
                </div>
                <p style={{ fontSize: '14px', color: '#454652', lineHeight: 1.6 }}>
                  {todayTurnaround !== null ? (
                    lang === 'es'
                      ? <>Tiempo promedio de respuesta del equipo: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#364262', fontWeight: 700 }}>{todayTurnaround}m</span> por habitación hoy.</>
                      : <>Team average response time: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#364262', fontWeight: 700 }}>{todayTurnaround}m</span> per room today.</>
                  ) : (
                    lang === 'es' ? 'Los datos de rendimiento aparecerán cuando se completen habitaciones.' : 'Performance data will appear as rooms are completed.'
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LeaderboardCard({ rooms, lang }: { rooms: Room[]; lang: 'en' | 'es' }) {
  const { activeProperty } = useProperty();
  const checkoutMins = activeProperty?.checkoutMinutes || 30;

  const staffStats = useMemo(() => {
    const map = new Map<string, { name: string; cleaned: number; totalMinutes: number; inspected: number }>();
    rooms
      .filter(r => r.assignedTo && (r.status === 'clean' || r.status === 'inspected' || r.status === 'in_progress'))
      .forEach(room => {
        const entry = map.get(room.assignedTo!) ?? { name: room.assignedName ?? 'Unknown', cleaned: 0, totalMinutes: 0, inspected: 0 };
        if (room.status === 'clean' || room.status === 'inspected') {
          entry.cleaned++;
          const s = toDate(room.startedAt);
          const e = toDate(room.completedAt);
          if (s && e) {
            const mins = (e.getTime() - s.getTime()) / 60000;
            if (mins > 0 && mins < 480) entry.totalMinutes += mins;
          }
        }
        if (room.status === 'inspected') entry.inspected++;
        map.set(room.assignedTo!, entry);
      });
    return Array.from(map.values())
      .map(s => ({ ...s, avgMinutes: s.cleaned > 0 ? Math.round(s.totalMinutes / s.cleaned) : 0 }))
      .sort((a, b) => b.cleaned - a.cleaned);
  }, [rooms]);

  if (staffStats.length === 0) {
    return (
      <div className="card animate-in stagger-3" style={{ padding: '20px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 500 }}>
          {t('noRoomsCompleted', lang)}
        </p>
      </div>
    );
  }

  const getAvgColor = (avg: number) => {
    if (avg <= checkoutMins) return 'var(--green)';
    if (avg <= checkoutMins * 1.5) return 'var(--amber)';
    return 'var(--red)';
  };

  return (
    <div className="card animate-in stagger-3" style={{ padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
        <Trophy size={16} color="var(--amber)" />
        <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
          {t('leaderboard', lang)}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {staffStats.map((s, i) => (
          <div key={s.name} style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 12px', background: i === 0 ? 'rgba(251,191,36,0.06)' : 'rgba(0,0,0,0.02)',
            borderRadius: 'var(--radius-md)', border: i === 0 ? '1px solid rgba(251,191,36,0.2)' : '1px solid var(--border)',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '13px',
              color: i === 0 ? 'var(--amber)' : 'var(--text-muted)', width: '24px', textAlign: 'center', flexShrink: 0,
            }}>
              {i === 0 ? '🏆' : `#${i + 1}`}
            </span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.name}
            </span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
              {s.cleaned} {t('roomsCleaned', lang)}
            </span>
            {s.avgMinutes > 0 && (
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700,
                color: getAvgColor(s.avgMinutes), flexShrink: 0,
              }}>
                {s.avgMinutes}m {t('avgTime', lang)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT SECTION
// ══════════════════════════════════════════════════════════════════════════════

export { PerformanceTab };
