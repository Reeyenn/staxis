'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { InspectionsView } from '@/components/InspectionsView';
import { timeAgo } from '@/lib/utils';
import {
  subscribeToWorkOrders, addWorkOrder, updateWorkOrder,
  subscribeToLandscapingTasks, addLandscapingTask, updateLandscapingTask, deleteLandscapingTask,
} from '@/lib/firestore';
import type { WorkOrder, WorkOrderSeverity, WorkOrderStatus, StaffMember, LandscapingTask, LandscapingSeason } from '@/types';
import {
  Plus, X, Trash2, Wrench, CheckCircle2, Check, Clock, ChevronDown, ChevronUp,
  TreePine, Leaf, Sun, Snowflake, Flower2,
} from 'lucide-react';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'workOrders' | 'preventive' | 'landscaping';

// ─── Filter config ───────────────────────────────────────────────────────────

type FilterKey = 'all' | 'open' | 'urgent' | 'resolved';

// ─── Severity / status styles ────────────────────────────────────────────────

const SEVERITY_STYLE: Record<WorkOrderSeverity, { bg: string; color: string }> = {
  urgent: { bg: 'var(--red-dim, rgba(220,38,38,0.08))', color: 'var(--red)' },
  medium: { bg: 'var(--amber-dim, rgba(245,158,11,0.08))', color: 'var(--amber)' },
  low:    { bg: 'rgba(156,163,175,0.08)', color: 'var(--text-muted)' },
};

const STATUS_STYLE: Record<WorkOrderStatus, { bg: string; color: string }> = {
  submitted:   { bg: 'var(--red-dim, rgba(220,38,38,0.08))', color: 'var(--red)' },
  assigned:    { bg: 'rgba(59,130,246,0.08)', color: 'var(--navy)' },
  in_progress: { bg: 'var(--amber-dim, rgba(245,158,11,0.08))', color: 'var(--amber)' },
  resolved:    { bg: 'var(--green-dim, rgba(34,197,94,0.08))', color: 'var(--green)' },
};

// ─── Landscaping defaults ────────────────────────────────────────────────────

const LANDSCAPING_DEFAULTS: Omit<LandscapingTask, 'id' | 'createdAt'>[] = [
  { name: 'Grass Mowing', propertyId: '', season: 'year-round', frequencyDays: 7, lastCompletedAt: null },
  { name: 'Shrub Trimming', propertyId: '', season: 'year-round', frequencyDays: 90, lastCompletedAt: null },
  { name: 'Palm Tree Maintenance', propertyId: '', season: 'year-round', frequencyDays: 180, lastCompletedAt: null },
  { name: 'Flower Bed — Summer Planting', propertyId: '', season: 'spring', frequencyDays: 365, lastCompletedAt: null },
  { name: 'Flower Bed — Winterizing', propertyId: '', season: 'fall', frequencyDays: 365, lastCompletedAt: null },
  { name: 'Mulch / Ground Cover Refresh', propertyId: '', season: 'spring', frequencyDays: 180, lastCompletedAt: null },
  { name: 'Weed Control', propertyId: '', season: 'year-round', frequencyDays: 14, lastCompletedAt: null },
  { name: 'Leaf Cleanup', propertyId: '', season: 'fall', frequencyDays: 7, lastCompletedAt: null },
];

const SEASON_CONFIG: Record<LandscapingSeason, { label: string; labelEs: string; color: string; bg: string; icon: typeof Leaf }> = {
  'year-round': { label: 'Year-Round', labelEs: 'Todo el año', color: 'var(--green)', bg: 'var(--green-dim)', icon: TreePine },
  spring:       { label: 'Spring', labelEs: 'Primavera', color: 'var(--purple, #a855f7)', bg: 'rgba(168,85,247,0.08)', icon: Flower2 },
  summer:       { label: 'Summer', labelEs: 'Verano', color: 'var(--amber)', bg: 'var(--amber-dim)', icon: Sun },
  fall:         { label: 'Fall', labelEs: 'Otoño', color: 'var(--orange, #ea580c)', bg: 'rgba(234,88,12,0.08)', icon: Leaf },
  winter:       { label: 'Winter', labelEs: 'Invierno', color: 'var(--navy)', bg: 'rgba(59,130,246,0.08)', icon: Snowflake },
};

type SeasonFilterKey = 'all' | LandscapingSeason;

function getCurrentSeason(): LandscapingSeason {
  const month = new Date().getMonth(); // 0-11
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
}

function isTaskInSeason(task: LandscapingTask): boolean {
  if (task.season === 'year-round') return true;
  return task.season === getCurrentSeason();
}

// ─── Firestore date helper ───────────────────────────────────────────────────

function toJsDate(d: unknown): Date | null {
  if (!d) return null;
  if (d instanceof Date) return d;
  if (typeof (d as { toDate?: () => Date }).toDate === 'function') return (d as { toDate: () => Date }).toDate();
  return new Date(d as string);
}

function formatShortDate(d: Date | null): string {
  if (!d) return '';
  const date = toJsDate(d);
  if (!date) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function MaintenancePage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, staff, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [activeTab, setActiveTabState] = useState<TabKey>(() => {
    // Initial read from URL (?tab=preventive) so refresh keeps the tab.
    if (typeof window === 'undefined') return 'workOrders';
    const p = new URLSearchParams(window.location.search).get('tab');
    if (p === 'preventive' || p === 'landscaping' || p === 'workOrders') return p;
    return 'workOrders';
  });
  const setActiveTab = useCallback((tab: TabKey) => {
    setActiveTabState(tab);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState({}, '', url.toString());
  }, []);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Create work order form
  const [newRoom, setNewRoom] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newSeverity, setNewSeverity] = useState<WorkOrderSeverity>('medium');
  const [newBlockRoom, setNewBlockRoom] = useState(false);

  // Landscaping state
  const [lsTasks, setLsTasks] = useState<LandscapingTask[]>([]);
  const [lsSeasonFilter, setLsSeasonFilter] = useState<SeasonFilterKey>('all');
  const [showLsModal, setShowLsModal] = useState(false);
  const [editLsTask, setEditLsTask] = useState<LandscapingTask | null>(null);
  const [newLsName, setNewLsName] = useState('');
  const [newLsSeason, setNewLsSeason] = useState<LandscapingSeason>('year-round');
  const [newLsFreq, setNewLsFreq] = useState('7');

  const lsSeededRef = useRef(false);

  // ─── Auth guard ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // ─── Subscriptions ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setOrders);
  }, [user, activePropertyId]);

  // Landscaping subscription
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToLandscapingTasks(user.uid, activePropertyId, (incoming) => {
      setLsTasks(incoming);
      if (incoming.length === 0 && !lsSeededRef.current) {
        lsSeededRef.current = true;
        LANDSCAPING_DEFAULTS.forEach(d => {
          addLandscapingTask(user.uid, activePropertyId, { ...d, propertyId: activePropertyId });
        });
      }
    });
  }, [user, activePropertyId]);

  // Material Symbols font is loaded globally via globals.css

  // ─── Toast auto-dismiss ──────────────────────────────────────────────────

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  // ─── Filtered & sorted orders ────────────────────────────────────────────

  const filteredOrders = useMemo(() => {
    let list = orders;
    if (filter === 'open') list = list.filter(o => o.status !== 'resolved');
    else if (filter === 'urgent') list = list.filter(o => o.severity === 'urgent' && o.status !== 'resolved');
    else if (filter === 'resolved') list = list.filter(o => o.status === 'resolved');

    return [...list].sort((a, b) => {
      const sevOrder: Record<WorkOrderSeverity, number> = { urgent: 0, medium: 1, low: 2 };
      if (a.status !== 'resolved' && b.status !== 'resolved') {
        if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
      }
      const aTime = toJsDate(a.createdAt)?.getTime() ?? 0;
      const bTime = toJsDate(b.createdAt)?.getTime() ?? 0;
      return bTime - aTime;
    });
  }, [orders, filter]);

  const filterCounts = useMemo(() => ({
    all: orders.length,
    open: orders.filter(o => o.status !== 'resolved').length,
    urgent: orders.filter(o => o.severity === 'urgent' && o.status !== 'resolved').length,
    resolved: orders.filter(o => o.status === 'resolved').length,
  }), [orders]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleCreateOrder = useCallback(async () => {
    if (!user || !activePropertyId || !newDesc.trim() || submitting) return;
    setSubmitting(true);
    try {
      await addWorkOrder(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        roomNumber: newRoom.trim(),
        description: newDesc.trim(),
        severity: newSeverity,
        status: 'submitted',
        submittedBy: user.uid,
        submittedByName: user.displayName ?? undefined,
        blockedRoom: newBlockRoom || undefined,
      });
      setShowCreateModal(false);
      setNewRoom('');
      setNewDesc('');
      setNewSeverity('medium');
      setNewBlockRoom(false);
      setToast(t('workOrderSubmitted', lang) + ' \u2713');
    } finally {
      setSubmitting(false);
    }
  }, [user, activePropertyId, newRoom, newDesc, newSeverity, submitting, lang]);

  const handleAssign = useCallback(async (order: WorkOrder, member: StaffMember) => {
    if (!user || !activePropertyId) return;
    await updateWorkOrder(user.uid, activePropertyId, order.id, {
      status: 'assigned',
      assignedTo: member.id,
      assignedName: member.name,
    });
    setAssigningId(null);
  }, [user, activePropertyId]);

  const handleStartWork = useCallback(async (order: WorkOrder) => {
    if (!user || !activePropertyId) return;
    await updateWorkOrder(user.uid, activePropertyId, order.id, { status: 'in_progress' });
  }, [user, activePropertyId]);

  const handleResolve = useCallback(async (order: WorkOrder) => {
    if (!user || !activePropertyId) return;
    await updateWorkOrder(user.uid, activePropertyId, order.id, {
      status: 'resolved',
      resolvedAt: new Date(),
    });
  }, [user, activePropertyId]);

  // ─── Landscaping handlers ───────────────────────────────────────────────

  const handleMarkLsDone = useCallback(async (task: LandscapingTask) => {
    if (!user || !activePropertyId) return;
    await updateLandscapingTask(user.uid, activePropertyId, task.id, {
      lastCompletedAt: new Date(),
      lastCompletedBy: user.displayName ?? undefined,
    });
    setToast(`${task.name} marked done ✓`);
  }, [user, activePropertyId]);

  const handleDeleteLs = useCallback(async (task: LandscapingTask) => {
    if (!user || !activePropertyId) return;
    if (!window.confirm(`Delete "${task.name}"?`)) return;
    await deleteLandscapingTask(user.uid, activePropertyId, task.id);
  }, [user, activePropertyId]);

  const handleCreateLs = useCallback(async () => {
    if (!user || !activePropertyId || !newLsName.trim() || submitting) return;
    setSubmitting(true);
    try {
      await addLandscapingTask(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        name: newLsName.trim(),
        season: newLsSeason,
        frequencyDays: Math.max(1, parseInt(newLsFreq, 10) || 7),
        lastCompletedAt: null,
      });
      setShowLsModal(false);
      setNewLsName('');
      setNewLsSeason('year-round');
      setNewLsFreq('7');
      setToast(t('addLandscapingTask', lang) + ' ✓');
    } finally {
      setSubmitting(false);
    }
  }, [user, activePropertyId, newLsName, newLsSeason, newLsFreq, submitting, lang]);

  // ─── Sorted / filtered landscaping tasks ────────────────────────────────

  const filteredLsTasks = useMemo(() => {
    let list = lsTasks;
    if (lsSeasonFilter !== 'all') {
      list = list.filter(t => t.season === lsSeasonFilter);
    }
    const now = Date.now();
    return [...list].sort((a, b) => {
      // In-season first, then out-of-season
      const aInSeason = isTaskInSeason(a) ? 0 : 1;
      const bInSeason = isTaskInSeason(b) ? 0 : 1;
      if (aInSeason !== bInSeason) return aInSeason - bInSeason;
      // Then by due urgency
      return getLsDaysUntilDue(a, now) - getLsDaysUntilDue(b, now);
    });
  }, [lsTasks, lsSeasonFilter]);

  // ─── Loading / auth guard render ─────────────────────────────────────────

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px', background: 'var(--bg)' }}>
        <div className="animate-spin" style={{ width: '32px', height: '32px', border: '4px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%' }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {lang === 'es' ? 'Cargando mantenimiento...' : 'Loading maintenance...'}
        </p>
      </div>
    );
  }

  const statusLabel = (s: WorkOrderStatus) => {
    const map: Record<WorkOrderStatus, string> = {
      submitted: t('statusSubmitted', lang),
      assigned: t('statusAssigned', lang),
      in_progress: t('statusInProgress', lang),
      resolved: t('statusResolved', lang),
    };
    return map[s];
  };

  const sevLabel = (s: WorkOrderSeverity) => {
    const map: Record<WorkOrderSeverity, string> = {
      low: t('severityLow', lang),
      medium: t('severityMedium', lang),
      urgent: t('severityUrgent', lang),
    };
    return map[s];
  };

  const maintenanceStaff = staff.filter(s => s.department === 'maintenance' && s.isActive !== false);
  const assignableStaff = maintenanceStaff.length > 0 ? maintenanceStaff : staff.filter(s => s.isActive !== false);

  // ─── AI Insight computation ─────────────────────────────────────────────
  const aiInsightText = (() => {
    const openCount = orders.filter(o => o.status !== 'resolved').length;
    const urgentCount = orders.filter(o => o.severity === 'urgent' && o.status !== 'resolved').length;
    const resolvedCount = orders.filter(o => o.status === 'resolved').length;
    const blockedCount = orders.filter(o => o.blockedRoom && o.status !== 'resolved').length;

    if (urgentCount >= 2) {
      return `${urgentCount} urgent work orders require immediate attention. ${blockedCount > 0 ? `${blockedCount} room${blockedCount > 1 ? 's' : ''} blocked from rental until resolved.` : 'Recommend prioritizing dispatch for these units.'}`;
    }
    if (openCount > 5) {
      return `Work order volume is higher than typical. ${openCount} open orders across the property. ${urgentCount > 0 ? `${urgentCount} marked urgent.` : 'No urgent items currently.'} Consider scheduling additional maintenance staff.`;
    }
    if (resolvedCount > 0 && openCount <= 3) {
      return `Operations running smoothly — ${resolvedCount} order${resolvedCount > 1 ? 's' : ''} resolved with only ${openCount} remaining open. Team efficiency is strong.`;
    }
    if (openCount === 0) {
      return 'All work orders resolved. No outstanding maintenance issues. Property is in excellent operational condition.';
    }
    return `${openCount} open work order${openCount !== 1 ? 's' : ''} currently tracked. ${urgentCount > 0 ? `${urgentCount} urgent.` : 'No urgent items.'} Maintenance pipeline is manageable.`;
  })();

  // Occupancy / dirty rooms from property context (fallback to order-derived)
  const dirtyRoomCount = orders.filter(o => o.blockedRoom && o.status !== 'resolved').length;

  return (
    <AppLayout>
      <style>{`
        .wo-glass-card {
          background: rgba(255,255,255,0.6);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .wo-glass-card:hover {
          background: rgba(255,255,255,0.8);
          transform: scale(1.005);
        }
        .wo-urgent-glow {
          box-shadow: 0 0 20px -5px rgba(186,26,26,0.15);
        }
        @media (min-width: 640px) {
          .ls-ai-card { display: block !important; }
        }
        .ls-task-card:hover {
          background: #f5f3ee !important;
          transform: scale(1.003);
        }
      `}</style>

      <div style={{ maxWidth: '768px', margin: '0 auto', padding: '16px 24px 160px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* ── Tabs ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px', marginBottom: '4px' }}>
          {([
            { key: 'workOrders' as TabKey, label: t('workOrders', lang) },
            { key: 'preventive' as TabKey, label: t('preventive', lang) },
            { key: 'landscaping' as TabKey, label: t('landscaping', lang) },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-label={tab.label}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
                fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: activeTab === tab.key ? 600 : 400,
                color: activeTab === tab.key ? '#1b1c19' : '#757684',
                borderBottom: activeTab === tab.key ? '2px solid #1b1c19' : '2px solid transparent',
                paddingBottom: '6px', letterSpacing: '-0.01em',
                transition: 'all 150ms',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab content ── */}
        {activeTab === 'workOrders' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Filter pills */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
              {([
                { key: 'all' as FilterKey, label: t('allFilter', lang) },
                { key: 'open' as FilterKey, label: t('openFilter', lang) },
                { key: 'urgent' as FilterKey, label: t('urgentFilter', lang) },
                { key: 'resolved' as FilterKey, label: t('resolvedFilter', lang) },
              ]).map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  style={{
                    padding: '8px 20px', border: 'none', cursor: 'pointer',
                    borderRadius: '9999px',
                    fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 500,
                    background: filter === f.key ? 'rgba(255,255,255,0.6)' : 'transparent',
                    backdropFilter: filter === f.key ? 'blur(12px)' : 'none',
                    boxShadow: filter === f.key ? 'inset 0 0 0 1px #364262' : 'inset 0 0 0 1px rgba(197,197,212,0.2)',
                    color: filter === f.key ? '#364262' : '#454652',
                    transition: 'all 200ms', flexShrink: 0,
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Work order cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {filteredOrders.length === 0 ? (
                <div className="wo-glass-card" style={{
                  padding: '48px 24px', textAlign: 'center', borderRadius: '16px',
                  boxShadow: 'inset 0 0 0 1px rgba(197,197,212,0.1)',
                }}>
                  <Wrench size={28} color="#757684" style={{ margin: '0 auto 10px' }} />
                  <p style={{ fontSize: '14px', color: '#757684', lineHeight: 1.5 }}>
                    {t('noWorkOrders', lang)}
                  </p>
                </div>
              ) : (
                filteredOrders.map(order => {
                  const isExpanded = expandedId === order.id;
                  const isUrgent = order.severity === 'urgent';

                  const sevPillStyle: Record<WorkOrderSeverity, { bg: string; color: string }> = {
                    urgent: { bg: '#ffdad6', color: '#93000a' },
                    medium: { bg: '#d3e4f8', color: '#506071' },
                    low: { bg: '#eae8e3', color: '#454652' },
                  };
                  const statusColorMap: Record<WorkOrderStatus, string> = {
                    submitted: '#ba1a1a',
                    assigned: '#364262',
                    in_progress: '#006565',
                    resolved: '#22c55e',
                  };

                  return (
                    <div
                      key={order.id}
                      className={`wo-glass-card${isUrgent && order.status !== 'resolved' ? ' wo-urgent-glow' : ''}`}
                      style={{
                        borderRadius: '14px', padding: '18px 22px',
                        boxShadow: isUrgent && order.status !== 'resolved'
                          ? 'inset 0 0 0 1px rgba(186,26,26,0.1), 0 0 20px -5px rgba(186,26,26,0.15)'
                          : 'inset 0 0 0 1px rgba(197,197,212,0.1)',
                        cursor: 'pointer',
                        transition: 'all 200ms cubic-bezier(0.2,0,0,1)',
                      }}
                      onClick={() => setExpandedId(isExpanded ? null : order.id)}
                    >
                      {/* Top row: room number + title + severity pill */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
                          {order.roomNumber && (
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', fontWeight: 500, letterSpacing: '-0.04em', color: '#364262' }}>
                              {order.roomNumber}
                            </span>
                          )}
                          <div>
                            <h3 style={{ fontFamily: "'Inter', sans-serif", fontSize: '16px', fontWeight: 600, color: '#1b1c19', lineHeight: 1.3, margin: 0 }}>
                              {order.description.length > 40 && !isExpanded ? order.description.slice(0, 40) + '…' : order.description}
                            </h3>
                            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#454652', margin: '2px 0 0' }}>
                              {lang === 'es' ? 'Reportado' : 'Reported'} {timeAgo(toJsDate(order.createdAt))} {order.submittedByName ? `${lang === 'es' ? 'por' : 'by'} ${order.submittedByName}` : ''}
                            </p>
                          </div>
                        </div>
                        <span style={{
                          padding: '3px 9px', borderRadius: '9999px',
                          fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                          background: sevPillStyle[order.severity].bg,
                          color: sevPillStyle[order.severity].color,
                          flexShrink: 0,
                        }}>
                          {sevLabel(order.severity)}
                        </span>
                      </div>

                      {/* Status + assignment row */}
                      {(order.assignedName || order.blockedRoom || order.status !== 'submitted') && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '16px' }}>
                          {order.assignedName && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#dae2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: '#364262' }}>
                                {order.assignedName.charAt(0).toUpperCase()}
                              </div>
                              <span style={{ fontSize: '13px', color: '#454652', fontWeight: 500 }}>{order.assignedName}</span>
                            </div>
                          )}
                          {order.blockedRoom && (
                            <>
                              <div style={{ width: '1px', height: '16px', background: 'rgba(197,197,212,0.3)' }} />
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#ba1a1a', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                {lang === 'es' ? 'Bloqueada' : 'Blocked'}
                              </span>
                            </>
                          )}
                          {order.status !== 'submitted' && (
                            <>
                              <div style={{ width: '1px', height: '16px', background: 'rgba(197,197,212,0.3)' }} />
                              <span style={{ fontSize: '12px', fontWeight: 600, color: statusColorMap[order.status] }}>
                                {statusLabel(order.status)}
                              </span>
                            </>
                          )}
                        </div>
                      )}

                      {/* Notes quote block */}
                      {order.notes && !isExpanded && (
                        <div style={{
                          background: 'rgba(245,243,238,0.4)', borderRadius: '12px',
                          padding: '12px 16px', marginTop: '16px',
                        }}>
                          <p style={{ fontSize: '14px', color: '#1b1c19', lineHeight: 1.6, fontStyle: 'italic', margin: 0 }}>
                            &ldquo;{order.notes}&rdquo;
                          </p>
                        </div>
                      )}

                      {/* Expanded details */}
                      {isExpanded && (
                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(197,197,212,0.2)', display: 'flex', flexDirection: 'column', gap: '12px' }}
                          onClick={e => e.stopPropagation()}
                        >
                          {order.notes && (
                            <div style={{
                              background: 'rgba(245,243,238,0.4)', borderRadius: '12px',
                              padding: '12px 16px',
                            }}>
                              <p style={{ fontSize: '14px', color: '#1b1c19', lineHeight: 1.6, fontStyle: 'italic', margin: 0 }}>
                                &ldquo;{order.notes}&rdquo;
                              </p>
                            </div>
                          )}
                          <div style={{ fontSize: '12px', color: '#757684', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            {order.createdAt && <span>{lang === 'es' ? 'Creado' : 'Created'}: {formatShortDate(toJsDate(order.createdAt))}</span>}
                            {order.updatedAt && <span>{lang === 'es' ? 'Actualizado' : 'Updated'}: {formatShortDate(toJsDate(order.updatedAt))}</span>}
                            {order.resolvedAt && <span>{lang === 'es' ? 'Resuelto' : 'Resolved'}: {formatShortDate(toJsDate(order.resolvedAt))}</span>}
                          </div>

                          {/* Action buttons */}
                          {order.status === 'submitted' && (
                            <div style={{ position: 'relative' }}>
                              <button
                                onClick={() => setAssigningId(assigningId === order.id ? null : order.id)}
                                style={{
                                  width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600,
                                  background: '#364262', color: '#fff', border: 'none',
                                  borderRadius: '12px', cursor: 'pointer', minHeight: '44px',
                                  fontFamily: "'Inter', sans-serif",
                                  transition: 'background 150ms',
                                }}
                              >
                                {t('assign', lang)}
                              </button>
                              {assigningId === order.id && (
                                <div style={{
                                  marginTop: '8px', borderRadius: '12px',
                                  border: '1px solid rgba(197,197,212,0.2)', background: '#fff',
                                  maxHeight: '180px', overflowY: 'auto',
                                  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                                }}>
                                  {assignableStaff.length === 0 ? (
                                    <p style={{ padding: '16px', fontSize: '13px', color: '#757684', textAlign: 'center' }}>
                                      {t('noStaff', lang)}
                                    </p>
                                  ) : (
                                    assignableStaff.map(member => (
                                      <button
                                        key={member.id}
                                        onClick={() => handleAssign(order, member)}
                                        style={{
                                          width: '100%', padding: '12px 16px', border: 'none',
                                          background: 'transparent', cursor: 'pointer',
                                          textAlign: 'left', fontSize: '14px', color: '#1b1c19',
                                          borderBottom: '1px solid rgba(197,197,212,0.15)',
                                          minHeight: '44px', fontFamily: "'Inter', sans-serif",
                                          transition: 'background 100ms',
                                        }}
                                        onMouseEnter={e => { (e.target as HTMLElement).style.background = 'rgba(218,226,255,0.3)'; }}
                                        onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
                                      >
                                        {member.name}
                                        {member.department && (
                                          <span style={{ fontSize: '12px', color: '#757684', marginLeft: '8px' }}>
                                            {member.department}
                                          </span>
                                        )}
                                      </button>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {order.status === 'assigned' && (
                            <button
                              onClick={() => handleStartWork(order)}
                              style={{
                                width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600,
                                background: 'rgba(0,101,101,0.08)', color: '#006565', border: 'none',
                                borderRadius: '12px', cursor: 'pointer', minHeight: '44px',
                                fontFamily: "'Inter', sans-serif",
                                transition: 'background 150ms',
                              }}
                            >
                              {t('startWork', lang)}
                            </button>
                          )}

                          {order.status === 'in_progress' && (
                            <button
                              onClick={() => handleResolve(order)}
                              style={{
                                width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600,
                                background: 'rgba(34,197,94,0.08)', color: '#16a34a', border: 'none',
                                borderRadius: '12px', cursor: 'pointer', minHeight: '44px',
                                fontFamily: "'Inter', sans-serif",
                                transition: 'background 150ms',
                              }}
                            >
                              {t('markResolved', lang)}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* ── AI Concierge Insight Card ── */}
            <div style={{
              borderRadius: '16px', padding: '32px', position: 'relative', overflow: 'hidden',
              background: 'linear-gradient(135deg, #fff 0%, rgba(147,242,242,0.05) 100%)',
              boxShadow: 'inset 0 0 0 1px rgba(0,101,101,0.1)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                <span style={{ fontSize: '20px' }}>⚡</span>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#006565' }}>
                  {lang === 'es' ? 'Perspectiva del Conserje' : 'Concierge Insight'}
                </span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '17px', lineHeight: 1.6, color: '#1b1c19', margin: '0 0 20px' }}>
                {aiInsightText}
              </p>
            </div>
          </div>
        ) : activeTab === 'preventive' ? (
          /* ── Preventive Maintenance Tab (Inspections) ── */
          <div className="animate-in stagger-2">
            <InspectionsView />
          </div>
        ) : (
          /* ── Landscaping Tab — Stitch Concierge Layout ── */
          <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            {/* ── Hero Section ── */}
            {(() => {
              const cs = getCurrentSeason();
              const csCfg = SEASON_CONFIG[cs];
              const seasonLabel = lang === 'es' ? csCfg.labelEs : csCfg.label;
              const now = Date.now();
              const inSeasonTasks = lsTasks.filter(t => isTaskInSeason(t));
              const overdueTasks = inSeasonTasks.filter(t => getLsDaysUntilDue(t, now) < 0);
              const dueSoonTasks = inSeasonTasks.filter(t => { const d = getLsDaysUntilDue(t, now); return d >= 0 && d <= 7; });
              const onTrackTasks = inSeasonTasks.filter(t => getLsDaysUntilDue(t, now) > 7);
              const healthPct = inSeasonTasks.length > 0 ? Math.round(((onTrackTasks.length + dueSoonTasks.length) / inSeasonTasks.length) * 100) : 100;
              const completionRate = lsTasks.length > 0 ? Math.round((lsTasks.filter(t => t.lastCompletedAt).length / lsTasks.length) * 100) : 0;

              // Determine cycle phase
              const month = new Date().getMonth();
              const cyclePhase = (() => {
                if (cs === 'spring') return month <= 2 ? 'Early Cycle' : month === 3 ? 'Mid Cycle' : 'Late Cycle';
                if (cs === 'summer') return month <= 5 ? 'Early Cycle' : month === 6 ? 'Mid Cycle' : 'Late Cycle';
                if (cs === 'fall') return month <= 8 ? 'Early Cycle' : month === 9 ? 'Mid Cycle' : 'Late Cycle';
                return month <= 11 ? 'Early Cycle' : month === 0 ? 'Mid Cycle' : 'Late Cycle';
              })();

              // Dynamic hero text
              const heroText = overdueTasks.length > 0
                ? (lang === 'es'
                  ? `${overdueTasks.length} tarea(s) de jardinería vencida(s) requieren atención inmediata. Priorice ${overdueTasks[0].name.toLowerCase()} para mantener los estándares de la propiedad.`
                  : `${overdueTasks.length} landscaping task${overdueTasks.length > 1 ? 's' : ''} overdue and need${overdueTasks.length === 1 ? 's' : ''} attention. Prioritize ${overdueTasks[0].name.toLowerCase()} to maintain property standards.`)
                : dueSoonTasks.length > 0
                  ? (lang === 'es'
                    ? `${dueSoonTasks.length} tarea(s) programada(s) esta semana. Las operaciones de jardinería están en buen camino para ${seasonLabel}.`
                    : `${dueSoonTasks.length} task${dueSoonTasks.length > 1 ? 's' : ''} scheduled this week. Landscaping operations on track for ${seasonLabel}.`)
                  : (lang === 'es'
                    ? `Todas las operaciones de jardinería están al día. El ciclo de ${seasonLabel} avanza según lo programado.`
                    : `All landscaping operations are current. ${seasonLabel} cycle progressing on schedule.`);

              return (
                <div style={{
                  background: '#f5f3ee', padding: '24px 32px', borderRadius: '16px',
                  position: 'relative', overflow: 'hidden',
                  border: '1px solid rgba(78,90,122,0.06)',
                }}>
                  {/* Atmospheric blur */}
                  <div style={{
                    position: 'absolute', top: '-80px', right: '-80px', width: '240px', height: '240px',
                    background: 'rgba(0,101,101,0.04)', borderRadius: '50%', filter: 'blur(60px)',
                  }} />
                  <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '20px' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                        <span style={{ fontSize: '14px' }}>⚡</span>
                        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#006565' }}>
                          {lang === 'es' ? 'Salud del Paisaje' : 'Landscape Health'}
                        </span>
                      </div>
                      <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '26px', fontWeight: 600, color: '#1b1c19', lineHeight: 1.2, margin: 0 }}>
                        {lang === 'es' ? 'Temporada' : 'Season'}:{' '}
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#364262' }}>{seasonLabel}</span> · {healthPct}% {lang === 'es' ? 'Sano' : 'Healthy'}
                      </h2>
                      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', margin: '6px 0 0', lineHeight: 1.5 }}>
                        {heroText}
                      </p>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', marginBottom: '6px' }}>
                        {cyclePhase}
                      </p>
                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {overdueTasks.length > 0 && (
                          <div style={{
                            padding: '5px 12px', background: '#fff', borderRadius: '9999px',
                            border: '1px solid rgba(197,197,212,0.2)',
                            display: 'flex', alignItems: 'center', gap: '6px',
                          }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ba1a1a' }} />
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#1b1c19' }}>
                              {overdueTasks.length} {lang === 'es' ? 'Vencidas' : 'Overdue'}
                            </span>
                          </div>
                        )}
                        {dueSoonTasks.length > 0 && (
                          <div style={{
                            padding: '5px 12px', background: '#fff', borderRadius: '9999px',
                            border: '1px solid rgba(197,197,212,0.2)',
                            display: 'flex', alignItems: 'center', gap: '6px',
                          }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#d3e4f8' }} />
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#1b1c19' }}>
                              {dueSoonTasks.length} {lang === 'es' ? 'Esta semana' : 'This week'}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Active Operations — filter pills ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '22px', fontWeight: 500, color: '#1b1c19' }}>
                {lang === 'es' ? 'Operaciones Activas' : 'Active Operations'}
              </h2>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(() => {
                  const now = Date.now();
                  const overdueCount = filteredLsTasks.filter(t => isTaskInSeason(t) && getLsDaysUntilDue(t, now) < 0).length;
                  const thisMonthCount = filteredLsTasks.filter(t => { const d = getLsDaysUntilDue(t, now); return isTaskInSeason(t) && d >= 0 && d <= 30; }).length;
                  type LsFilterKey = 'all' | 'overdue' | 'thisMonth';
                  const filters: { key: LsFilterKey; label: string }[] = [
                    { key: 'all', label: lang === 'es' ? 'Todos' : 'All' },
                    { key: 'overdue', label: `${lang === 'es' ? 'Vencidas' : 'Overdue'} (${overdueCount})` },
                    { key: 'thisMonth', label: lang === 'es' ? 'Este Mes' : 'This Month' },
                  ];
                  return filters.map(f => {
                    const isActive = lsSeasonFilter === f.key || (f.key === 'all' && lsSeasonFilter === 'all');
                    return (
                      <button
                        key={f.key}
                        onClick={() => {
                          // We reuse lsSeasonFilter for simplicity — 'all' works, overdue/thisMonth handled in rendering
                          if (f.key === 'all') setLsSeasonFilter('all');
                          else if (f.key === 'overdue') setLsSeasonFilter('all'); // Filter applied in render
                          else setLsSeasonFilter('all');
                        }}
                        style={{
                          background: '#f0eee9', color: '#454652',
                          padding: '8px 16px', borderRadius: '9999px', border: 'none',
                          fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 500,
                          cursor: 'pointer', transition: 'all 150ms',
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  });
                })()}
              </div>
            </div>

            {/* ── Season filter pills row ── */}
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '2px', scrollbarWidth: 'none' }}>
              {([
                { key: 'all' as SeasonFilterKey, label: lang === 'es' ? 'Todos' : 'All Seasons' },
                ...(['year-round', 'spring', 'summer', 'fall', 'winter'] as LandscapingSeason[]).map(s => ({
                  key: s as SeasonFilterKey,
                  label: lang === 'es' ? SEASON_CONFIG[s].labelEs : SEASON_CONFIG[s].label,
                })),
              ]).map(f => {
                const isActive = lsSeasonFilter === f.key;
                const cfg = f.key !== 'all' ? SEASON_CONFIG[f.key as LandscapingSeason] : null;
                return (
                  <button
                    key={f.key}
                    onClick={() => setLsSeasonFilter(f.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '8px 16px', border: 'none', cursor: 'pointer',
                      borderRadius: '9999px',
                      fontSize: '12px', fontWeight: 600, fontFamily: "'Inter', sans-serif",
                      background: isActive ? (cfg ? 'rgba(0,101,101,0.08)' : '#364262') : '#f0eee9',
                      color: isActive ? (cfg ? '#006565' : '#fff') : '#454652',
                      outline: isActive && cfg ? '1.5px solid #006565' : 'none',
                      transition: 'all 150ms', flexShrink: 0,
                    }}
                  >
                    {cfg && React.createElement(cfg.icon, { size: 13 })}
                    {f.label}
                  </button>
                );
              })}
            </div>

            {/* ── Task Feed ── */}
            {filteredLsTasks.length === 0 ? (
              <div style={{
                padding: '48px 20px', textAlign: 'center', borderRadius: '24px',
                background: 'rgba(0,0,0,0.02)', border: '1px dashed #c5c5d4',
              }}>
                <TreePine size={28} color="#757684" style={{ margin: '0 auto 10px' }} />
                <p style={{ fontSize: '14px', color: '#757684', lineHeight: 1.5, fontFamily: "'Inter', sans-serif" }}>
                  {t('noLandscapingTasks', lang)}
                </p>
              </div>
            ) : (
              filteredLsTasks.map(task => {
                const daysUntil = getLsDaysUntilDue(task, Date.now());
                const isOverdue = daysUntil < 0;
                const isDueSoon = daysUntil >= 0 && daysUntil <= 3;
                const inSeason = isTaskInSeason(task);
                const seasonCfg = SEASON_CONFIG[task.season];

                // Task icon mapping
                const getTaskIcon = (name: string): string => {
                  const n = name.toLowerCase();
                  if (n.includes('mow') || n.includes('grass') || n.includes('lawn') || n.includes('turf')) return 'grass';
                  if (n.includes('shrub') || n.includes('trim') || n.includes('hedge') || n.includes('topiary')) return 'content_cut';
                  if (n.includes('flower') || n.includes('plant') || n.includes('bloom')) return 'local_florist';
                  if (n.includes('palm') || n.includes('tree')) return 'park';
                  if (n.includes('irrig') || n.includes('water') || n.includes('sprinkler')) return 'water_drop';
                  if (n.includes('weed')) return 'eco';
                  if (n.includes('leaf') || n.includes('cleanup') || n.includes('clean')) return 'compost';
                  if (n.includes('mulch') || n.includes('ground') || n.includes('cover')) return 'landscape';
                  if (n.includes('seed') || n.includes('overseed')) return 'spa';
                  if (n.includes('fertil')) return 'science';
                  return 'yard';
                };

                // Status pill
                const statusLabel = !inSeason
                  ? (lang === 'es' ? 'Fuera de Temp.' : 'Off-Season')
                  : isOverdue
                    ? (lang === 'es' ? 'Vencida' : 'Overdue')
                    : isDueSoon
                      ? (lang === 'es' ? 'Próximamente' : 'Due This Month')
                      : (lang === 'es' ? 'Al Día' : 'Good');
                const statusBg = !inSeason ? '#eae8e3' : isOverdue ? '#ffdad6' : isDueSoon ? '#d3e4f8' : '#eae8e3';
                const statusColor = !inSeason ? '#454652' : isOverdue ? '#93000a' : isDueSoon ? '#394858' : '#454652';

                // Icon container colors
                const iconBg = !inSeason ? '#eae8e3' : isOverdue ? '#ffdad6' : isDueSoon ? '#d3e4f8' : '#eae8e3';
                const iconColor = !inSeason ? '#454652' : isOverdue ? '#ba1a1a' : isDueSoon ? '#364262' : '#454652';

                // Days label
                const daysLabel = isOverdue
                  ? (lang === 'es' ? 'Días Pasados' : 'Days Past')
                  : (lang === 'es' ? 'Días Hasta' : 'Days Until');
                const daysValue = Math.abs(daysUntil);
                const daysColor = isOverdue ? '#ba1a1a' : daysUntil <= 7 ? '#364262' : 'rgba(69,70,82,0.4)';

                return (
                  <div
                    key={task.id}
                    onClick={() => setEditLsTask(task)}
                    style={{
                      background: '#fff', borderRadius: '14px',
                      padding: '18px 22px', display: 'flex', flexDirection: 'column',
                      border: '1px solid rgba(197,197,212,0.2)',
                      opacity: inSeason ? 1 : 0.6,
                      transition: 'all 300ms', cursor: 'pointer',
                    }}
                    className="ls-task-card"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                      {/* Icon */}
                      <div style={{
                        width: '46px', height: '46px', borderRadius: '12px', flexShrink: 0,
                        background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '22px', color: iconColor }}>
                          {getTaskIcon(task.name)}
                        </span>
                      </div>

                      {/* Text */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '2px' }}>
                          <h3 style={{
                            fontFamily: "'Inter', sans-serif", fontSize: '16px', fontWeight: 600,
                            color: '#1b1c19', margin: 0,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {task.name}
                          </h3>
                          <span style={{
                            background: statusBg, color: statusColor,
                            padding: '3px 9px', borderRadius: '9999px',
                            fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                            flexShrink: 0,
                          }}>
                            {statusLabel}
                          </span>
                        </div>
                        <p style={{
                          fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#454652',
                          margin: 0,
                        }}>
                          {lang === 'es' ? `Cada ${task.frequencyDays} días` : `Every ${task.frequencyDays} days`}
                          {' · '}
                          {task.lastCompletedAt
                            ? `${lang === 'es' ? 'Último' : 'Last'}: ${formatShortDate(toJsDate(task.lastCompletedAt))}`
                            : (lang === 'es' ? 'Nunca completada' : 'Never completed')
                          }
                        </p>
                      </div>

                      {/* Days counter */}
                      <div style={{ textAlign: 'center', flexShrink: 0, marginRight: '4px' }}>
                        <p style={{
                          fontFamily: "'Inter', sans-serif", fontSize: '9px',
                          color: '#454652', letterSpacing: '0.1em', textTransform: 'uppercase',
                          marginBottom: '2px',
                        }}>
                          {inSeason ? daysLabel : (lang === 'es' ? 'Fuera de Temp.' : 'Off-Season')}
                        </p>
                        {inSeason && (
                          <p style={{
                            fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', fontWeight: 500,
                            color: daysColor, lineHeight: 1, margin: 0,
                          }}>
                            {String(daysValue).padStart(2, '0')}
                          </p>
                        )}
                      </div>

                    </div>
                  </div>
                );
              })
            )}

            {/* ── Inline "New Task" card ── */}
            <button
              onClick={() => setShowLsModal(true)}
              style={{
                background: 'transparent', borderRadius: '24px',
                padding: '24px', display: 'flex', alignItems: 'center', gap: '20px',
                border: '2px dashed #c5c5d4', cursor: 'pointer',
                transition: 'all 200ms',
              }}
            >
              <div style={{
                width: '56px', height: '56px', borderRadius: '16px', flexShrink: 0,
                background: '#364262', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Plus size={24} color="#fff" />
              </div>
              <span style={{
                fontFamily: "'Inter', sans-serif", fontSize: '17px', fontWeight: 600,
                color: '#364262',
              }}>
                {lang === 'es' ? 'Nueva Tarea' : 'New Task'}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* ── FAB (Work Orders tab only) ── */}
      {activeTab === 'workOrders' && (
        <button
          onClick={() => setShowCreateModal(true)}
          aria-label={t('newWorkOrder', lang)}
          style={{
            position: 'fixed', bottom: '32px', right: '32px', zIndex: 30,
            width: '56px', height: '56px', borderRadius: '50%',
            background: '#364262', color: '#fff', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(54,66,98,0.35)',
            transition: 'transform 200ms cubic-bezier(0.2,0,0,1)',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <Plus size={24} strokeWidth={2.5} />
        </button>
      )}

      {/* ── Create Work Order Modal ── */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowCreateModal(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '500px', maxHeight: '90vh', overflowY: 'auto',
            background: '#fbf9f4', borderRadius: '24px',
            padding: '24px',
            display: 'flex', flexDirection: 'column', gap: '16px',
            boxShadow: '0 24px 48px rgba(0,0,0,0.12)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
                {t('newWorkOrder', lang)}
              </h2>
              <button onClick={() => setShowCreateModal(false)} aria-label={lang === 'es' ? 'Cerrar' : 'Close'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                <X size={18} color="#757684" />
              </button>
            </div>

            {/* Room # */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {t('roomNumber', lang)}
              </label>
              <input
                type="text"
                value={newRoom}
                onChange={e => setNewRoom(e.target.value)}
                placeholder="e.g. 302"
                style={{
                  width: '100%', padding: '12px 16px', fontSize: '14px',
                  border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                  background: '#fff', color: '#1b1c19',
                  fontFamily: "'JetBrains Mono', monospace",
                  outline: 'none', transition: 'border 150ms',
                }}
              />
            </div>

            {/* Description */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {lang === 'es' ? 'Descripción' : 'Description'}
              </label>
              <textarea
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder={t('describeIssue', lang)}
                rows={3}
                style={{
                  width: '100%', padding: '12px 16px', fontSize: '14px',
                  border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                  background: '#fff', color: '#1b1c19',
                  fontFamily: "'Inter', sans-serif", resize: 'none',
                  outline: 'none', transition: 'border 150ms',
                }}
              />
            </div>

            {/* Severity */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {t('severity', lang)}
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['low', 'medium', 'urgent'] as WorkOrderSeverity[]).map(sev => {
                  const isSelected = newSeverity === sev;
                  const pillColors: Record<WorkOrderSeverity, { bg: string; color: string; activeBg: string }> = {
                    low: { bg: '#eae8e3', color: '#454652', activeBg: '#eae8e3' },
                    medium: { bg: '#d3e4f8', color: '#506071', activeBg: '#d3e4f8' },
                    urgent: { bg: '#ffdad6', color: '#93000a', activeBg: '#ffdad6' },
                  };
                  return (
                    <button
                      key={sev}
                      onClick={() => setNewSeverity(sev)}
                      style={{
                        flex: 1, padding: '10px', border: 'none', borderRadius: '12px',
                        fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                        fontFamily: "'Inter', sans-serif",
                        background: isSelected ? pillColors[sev].activeBg : '#f5f3ee',
                        color: isSelected ? pillColors[sev].color : '#757684',
                        outline: isSelected ? `2px solid ${pillColors[sev].color}` : 'none',
                        transition: 'all 150ms',
                      }}
                    >
                      {sevLabel(sev)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Block Room */}
            <div
              onClick={() => setNewBlockRoom(!newBlockRoom)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderRadius: '12px',
                border: newBlockRoom ? '2px solid #ba1a1a' : '1px solid rgba(197,197,212,0.3)',
                background: newBlockRoom ? '#ffdad6' : 'transparent',
                cursor: 'pointer', transition: 'all 150ms',
              }}
            >
              <div>
                <p style={{ fontSize: '14px', fontWeight: 600, color: newBlockRoom ? '#93000a' : '#1b1c19', margin: 0, fontFamily: "'Inter', sans-serif" }}>
                  {lang === 'es' ? 'Bloquear Habitación' : 'Block Room'}
                </p>
                <p style={{ fontSize: '12px', color: '#757684', marginTop: '2px', fontFamily: "'Inter', sans-serif" }}>
                  {lang === 'es' ? 'No se puede rentar hasta resolver' : "Can't rent until resolved"}
                </p>
              </div>
              <div style={{
                width: '42px', height: '24px', borderRadius: '99px',
                background: newBlockRoom ? '#ba1a1a' : 'rgba(0,0,0,0.12)',
                position: 'relative', transition: 'background 150ms',
              }}>
                <div style={{
                  width: '20px', height: '20px', borderRadius: '50%',
                  background: '#fff', position: 'absolute', top: '2px',
                  left: newBlockRoom ? '20px' : '2px',
                  transition: 'left 150ms',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
            </div>

            {/* Submit */}
            <button
              onClick={handleCreateOrder}
              disabled={!newDesc.trim() || submitting}
              style={{
                width: '100%', padding: '14px', border: 'none',
                borderRadius: '12px', cursor: newDesc.trim() && !submitting ? 'pointer' : 'not-allowed',
                background: newDesc.trim() && !submitting ? '#364262' : '#eae8e3',
                color: newDesc.trim() && !submitting ? '#fff' : '#757684',
                fontSize: '14px', fontWeight: 700, fontFamily: "'Inter', sans-serif",
                transition: 'all 150ms', minHeight: '48px',
              }}
            >
              {submitting ? '...' : t('submitWorkOrder', lang)}
            </button>
          </div>
        </div>
      )}

      {/* ── Add Landscaping Task Modal — Stitch Design ── */}
      {showLsModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(27,28,25,0.5)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowLsModal(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '500px',
            background: '#fbf9f4', borderRadius: '24px 24px 0 0',
            padding: '24px 24px calc(24px + env(safe-area-inset-bottom))',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
                {t('addLandscapingTask', lang)}
              </h2>
              <button onClick={() => setShowLsModal(false)} aria-label={lang === 'es' ? 'Cerrar' : 'Close'} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={16} color="#454652" />
              </button>
            </div>

            {/* Task name */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {t('landscapingTaskName', lang)}
              </label>
              <input
                type="text"
                value={newLsName}
                onChange={e => setNewLsName(e.target.value)}
                placeholder={lang === 'es' ? 'ej. Corte de césped' : 'e.g. Grass Mowing'}
                style={{
                  width: '100%', padding: '12px 16px', fontSize: '14px',
                  border: '1px solid #c5c5d4', borderRadius: '16px',
                  background: '#fff', color: '#1b1c19',
                  fontFamily: "'Inter', sans-serif",
                  outline: 'none', transition: 'border-color 150ms',
                }}
              />
            </div>

            {/* Season selector */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {t('season', lang)}
              </label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {(['year-round', 'spring', 'summer', 'fall', 'winter'] as LandscapingSeason[]).map(s => {
                  const cfg = SEASON_CONFIG[s];
                  const isSelected = newLsSeason === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setNewLsSeason(s)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '5px',
                        padding: '8px 14px', border: 'none', borderRadius: '9999px',
                        fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                        fontFamily: "'Inter', sans-serif",
                        background: isSelected ? '#006565' : '#f0eee9',
                        color: isSelected ? '#fff' : '#454652',
                        transition: 'all 150ms',
                      }}
                    >
                      {React.createElement(cfg.icon, { size: 13 })}
                      {lang === 'es' ? cfg.labelEs : cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Frequency */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {t('frequencyDays', lang)}
              </label>
              <input
                type="number"
                value={newLsFreq}
                onChange={e => setNewLsFreq(e.target.value)}
                min="1"
                style={{
                  width: '100%', padding: '12px 16px', fontSize: '14px',
                  border: '1px solid #c5c5d4', borderRadius: '16px',
                  background: '#fff', color: '#1b1c19',
                  fontFamily: "'JetBrains Mono', monospace",
                  outline: 'none',
                }}
              />
            </div>

            <button
              onClick={handleCreateLs}
              disabled={!newLsName.trim() || submitting}
              style={{
                width: '100%', padding: '16px', border: 'none',
                borderRadius: '9999px', cursor: newLsName.trim() && !submitting ? 'pointer' : 'not-allowed',
                background: newLsName.trim() && !submitting ? '#364262' : '#eae8e3',
                color: newLsName.trim() && !submitting ? '#fff' : '#757684',
                fontSize: '15px', fontWeight: 600, fontFamily: "'Inter', sans-serif",
                transition: 'all 150ms', minHeight: '52px',
              }}
            >
              {submitting ? '...' : t('addLandscapingTask', lang)}
            </button>
          </div>
        </div>
      )}

      {/* ── Edit Landscaping Task Modal ── */}
      {editLsTask && user && activePropertyId && (
        <EditLandscapingTaskModal
          task={editLsTask}
          lang={lang}
          onClose={() => setEditLsTask(null)}
          onSave={async (updates) => {
            await updateLandscapingTask(user.uid, activePropertyId, editLsTask.id, updates);
            setToast(`${editLsTask.name} ${lang === 'es' ? 'actualizado' : 'updated'} ✓`);
            setEditLsTask(null);
          }}
          onDelete={async () => {
            if (!window.confirm(`${lang === 'es' ? 'Eliminar' : 'Delete'} "${editLsTask.name}"?`)) return;
            await deleteLandscapingTask(user.uid, activePropertyId, editLsTask.id);
            setToast(`${editLsTask.name} ${lang === 'es' ? 'eliminado' : 'deleted'}`);
            setEditLsTask(null);
          }}
        />
      )}

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 60, padding: '12px 24px', borderRadius: '9999px',
          background: '#364262', color: '#fff',
          fontSize: '14px', fontWeight: 600, fontFamily: "'Inter', sans-serif",
          boxShadow: '0 8px 24px rgba(54,66,98,0.3)',
          animation: 'fadeIn 200ms ease-out',
          backdropFilter: 'blur(12px)',
        }}>
          {toast}
        </div>
      )}
    </AppLayout>
  );
}

// ─── Edit Landscaping Task Modal ─────────────────────────────────────────────

function EditLandscapingTaskModal({ task, lang, onClose, onSave, onDelete }: {
  task: LandscapingTask;
  lang: string;
  onClose: () => void;
  onSave: (updates: Partial<LandscapingTask>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(task.name);
  const [season, setSeason] = useState<LandscapingSeason>(task.season);
  const [freq, setFreq] = useState(task.frequencyDays);
  const [notes, setNotes] = useState(task.notes || '');
  const lastCompleted = toJsDate(task.lastCompletedAt);
  const lastCompletedISO = lastCompleted ? lastCompleted.toISOString().split('T')[0] : '';
  const [lastDone, setLastDone] = useState(lastCompletedISO);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Compute live status from current form state (same pattern as Preventive modal)
  const status = (() => {
    if (!lastDone) return { color: 'var(--text-muted)', label: lang === 'es' ? 'Sin Fecha' : 'Never Done' };
    const done = new Date(lastDone + 'T12:00:00');
    const daysSince = Math.floor((Date.now() - done.getTime()) / (1000 * 60 * 60 * 24));
    const daysUntil = freq - daysSince;
    if (daysUntil < 0) return { color: 'var(--red)', label: lang === 'es' ? 'Vencida' : 'Overdue' };
    if (daysUntil <= 7) return { color: 'var(--amber)', label: lang === 'es' ? 'Pendiente' : 'Due Soon' };
    return { color: 'var(--green)', label: lang === 'es' ? 'Al Día' : 'On Track' };
  })();

  // Next-due preview (auto-derived from lastDone + freq)
  const nextDue = (() => {
    if (!lastDone) return null;
    const done = new Date(lastDone + 'T12:00:00');
    done.setDate(done.getDate() + freq);
    return done.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  })();

  const hasChanges =
    name.trim() !== task.name ||
    season !== task.season ||
    freq !== task.frequencyDays ||
    notes !== (task.notes || '') ||
    lastDone !== lastCompletedISO;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)',
    border: '1.5px solid var(--border)', background: 'var(--bg)',
    fontSize: '14px', color: 'var(--text-primary)',
  };
  const todayISO = new Date().toISOString().split('T')[0];

  if (!mounted) return null;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
    }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)', borderRadius: 'var(--radius-lg)',
          width: '100%', maxWidth: '420px', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{
          padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            {lang === 'es' ? 'Editar Tarea' : 'Edit Task'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: '28px', height: '28px', borderRadius: '6px',
              border: '1px solid var(--border)', background: 'var(--bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text-muted)',
            }}
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Nombre de la Tarea' : 'Task Name'}
            </label>
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{
                width: '8px', height: '8px', borderRadius: '99px',
                background: status.color, flexShrink: 0,
              }} />
              {lang === 'es' ? 'Última Completada' : 'Last Completed'}
              <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: status.color }}>
                · {status.label}
              </span>
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <input
                type="date"
                value={lastDone}
                max={todayISO}
                onChange={e => setLastDone(e.target.value)}
                style={{ ...inputStyle, flex: 1, borderLeftWidth: '4px', borderLeftColor: status.color }}
              />
              <button
                type="button"
                onClick={() => setLastDone(todayISO)}
                style={{
                  padding: '0 14px', borderRadius: 'var(--radius-md)',
                  background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {lang === 'es' ? 'Hoy' : 'Today'}
              </button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Frecuencia' : 'Frequency'}
              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)', marginLeft: '6px' }}>
                · {freq} {lang === 'es' ? 'días' : 'days'}
              </span>
            </label>
            <input
              type="range" min="1" max="365" step="1"
              value={freq}
              onChange={e => setFreq(parseInt(e.target.value, 10) || 1)}
              style={{ width: '100%', accentColor: 'var(--navy, #1b3a5c)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: "'JetBrains Mono', monospace" }}>
              <span>1d</span><span>90d</span><span>180d</span><span>365d</span>
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Próxima Programada' : 'Next Due'}
              {lastDone && (
                <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)', marginLeft: '6px' }}>
                  · {lang === 'es' ? 'auto-calculado' : 'auto-calculated'}
                </span>
              )}
            </label>
            <div style={{ ...inputStyle, background: 'var(--bg)', color: nextDue ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              {nextDue || (lang === 'es' ? 'Marca "Última Completada" para ver' : 'Set "Last Completed" to see')}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              {lang === 'es' ? 'Temporada' : 'Season'}
            </label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['year-round', 'spring', 'summer', 'fall', 'winter'] as LandscapingSeason[]).map(s => {
                const cfg = SEASON_CONFIG[s];
                const isSelected = season === s;
                return (
                  <button
                    key={s}
                    onClick={() => setSeason(s)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px',
                      padding: '6px 11px', border: '1.5px solid var(--border)', borderRadius: '9999px',
                      fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                      background: isSelected ? 'var(--navy, #1b3a5c)' : 'var(--bg)',
                      color: isSelected ? '#fff' : 'var(--text-muted)',
                      borderColor: isSelected ? 'var(--navy, #1b3a5c)' : 'var(--border)',
                      transition: 'all 150ms',
                    }}
                  >
                    {React.createElement(cfg.icon, { size: 12 })}
                    {lang === 'es' ? cfg.labelEs : cfg.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Notas' : 'Notes'}
            </label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder={lang === 'es' ? 'Proveedor, contacto, detalles...' : 'Vendor, contact, details...'}
              rows={2}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        </div>

        <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={() => onSave({
              name: name.trim(),
              season,
              frequencyDays: freq > 0 ? freq : task.frequencyDays,
              notes: notes.trim() || undefined,
              ...(lastDone ? { lastCompletedAt: new Date(lastDone + 'T12:00:00') } : { lastCompletedAt: null }),
            })}
            disabled={!hasChanges || !name.trim()}
            style={{
              width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
              background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
              fontSize: '14px', fontWeight: 700, cursor: hasChanges && name.trim() ? 'pointer' : 'not-allowed',
              opacity: hasChanges && name.trim() ? 1 : 0.5,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            <Check size={16} />
            {lang === 'es' ? 'Guardar Cambios' : 'Save Changes'}
          </button>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onDelete}
              style={{
                flex: 1, padding: '10px', borderRadius: 'var(--radius-md)',
                background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid var(--red-border, rgba(220,38,38,0.2))',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
              }}
            >
              <Trash2 size={13} />
              {lang === 'es' ? 'Eliminar' : 'Remove'}
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1, padding: '10px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                fontSize: '12px', fontWeight: 500, cursor: 'pointer',
              }}
            >
              {lang === 'es' ? 'Cancelar' : 'Cancel'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Helper: days until landscaping task is due ─────────────────────────────

function getLsDaysUntilDue(task: LandscapingTask, now: number): number {
  if (!task.lastCompletedAt) return -task.frequencyDays;
  const completed = toJsDate(task.lastCompletedAt);
  if (!completed) return -task.frequencyDays;
  const daysSince = Math.floor((now - completed.getTime()) / (1000 * 60 * 60 * 24));
  return task.frequencyDays - daysSince;
}
