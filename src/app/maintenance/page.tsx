'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
  Plus, X, Trash2, Wrench, CheckCircle2, Clock, ChevronDown, ChevronUp,
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

  return (
    <AppLayout>
      <div style={{ padding: '16px 20px 100px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* ── Page header ── */}
        <div className="animate-in">
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {t('maintenance', lang)}
          </h1>
        </div>

        {/* ── Tabs ── */}
        <div className="animate-in stagger-1" style={{ display: 'flex', gap: '4px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', padding: '3px' }}>
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
                flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer',
                borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600,
                background: activeTab === tab.key ? 'white' : 'transparent',
                color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
                boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 150ms',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab content ── */}
        {activeTab === 'workOrders' ? (
          <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            {/* Filter pills */}
            <div className="scroll-pills" style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '2px', touchAction: 'pan-x', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
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
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '8px 14px', border: 'none', cursor: 'pointer',
                    borderRadius: 'var(--radius-full)',
                    fontSize: '12px', fontWeight: 600, fontFamily: 'var(--font-sans)',
                    background: filter === f.key ? 'var(--navy)' : 'var(--bg-elevated)',
                    color: filter === f.key ? '#fff' : 'var(--text-secondary)',
                    transition: 'all 150ms', flexShrink: 0,
                    minHeight: '36px',
                  }}
                >
                  {f.label}
                  <span style={{
                    fontSize: '10px', fontWeight: 700,
                    padding: '1px 6px', borderRadius: '99px',
                    background: filter === f.key ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.06)',
                    color: filter === f.key ? '#fff' : 'var(--text-muted)',
                  }}>
                    {filterCounts[f.key]}
                  </span>
                </button>
              ))}
            </div>

            {/* Work order cards */}
            {filteredOrders.length === 0 ? (
              <div style={{
                padding: '48px 20px', textAlign: 'center', borderRadius: 'var(--radius-lg)',
                background: 'rgba(0,0,0,0.02)', border: '1px dashed var(--border)',
              }}>
                <Wrench size={28} color="var(--text-muted)" style={{ margin: '0 auto 10px' }} />
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {t('noWorkOrders', lang)}
                </p>
              </div>
            ) : (
              filteredOrders.map(order => {
                const isExpanded = expandedId === order.id;
                const sev = SEVERITY_STYLE[order.severity];
                const stat = STATUS_STYLE[order.status];

                return (
                  <div
                    key={order.id}
                    className="card"
                    style={{ padding: '10px 14px', cursor: 'pointer', transition: 'box-shadow 150ms' }}
                    onClick={() => setExpandedId(isExpanded ? null : order.id)}
                  >
                    {/* Row 1: severity + room + description + status + time */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span style={{
                        fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
                        color: sev.color, flexShrink: 0,
                      }}>
                        {sevLabel(order.severity)}
                      </span>
                      {order.roomNumber && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)', flexShrink: 0 }}>
                          {order.roomNumber}
                        </span>
                      )}
                      <span style={{
                        fontSize: '13px', color: 'var(--text-secondary)', flex: 1, minWidth: 0,
                        ...(isExpanded ? { whiteSpace: 'normal' as const } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }),
                      }}>
                        {order.description}
                      </span>
                      <span style={{
                        fontSize: '11px', fontWeight: 700, color: stat.color, flexShrink: 0,
                      }}>
                        {statusLabel(order.status)}
                      </span>
                    </div>

                    {/* Row 2: meta line — assignee + time + flags */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {order.assignedName ? order.assignedName : t('unassigned', lang)}
                      </span>
                      {order.blockedRoom && (
                        <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', flexShrink: 0 }}>
                          {lang === 'es' ? 'Bloq' : 'Blocked'}
                        </span>
                      )}
                      <span style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
                        <Clock size={10} />
                        {timeAgo(toJsDate(order.createdAt))}
                      </span>
                      {isExpanded ? <ChevronUp size={12} color="var(--text-muted)" /> : <ChevronDown size={12} color="var(--text-muted)" />}
                    </div>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '10px' }}
                        onClick={e => e.stopPropagation()}
                      >
                        {order.notes && (
                          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            <strong>{t('workOrderNotes', lang)}:</strong> {order.notes}
                          </p>
                        )}
                        {order.submittedByName && (
                          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            {t('submittedBy', lang)}: {order.submittedByName}
                          </p>
                        )}
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {order.createdAt && <span>Created: {formatShortDate(toJsDate(order.createdAt))}</span>}
                          {order.updatedAt && <span>Updated: {formatShortDate(toJsDate(order.updatedAt))}</span>}
                          {order.resolvedAt && <span>Resolved: {formatShortDate(toJsDate(order.resolvedAt))}</span>}
                        </div>

                        {/* Action buttons */}
                        {order.status === 'submitted' && (
                          <div style={{ position: 'relative' }}>
                            <button
                              onClick={() => setAssigningId(assigningId === order.id ? null : order.id)}
                              className="btn"
                              style={{
                                width: '100%', padding: '10px', fontSize: '13px', fontWeight: 600,
                                background: 'var(--navy)', color: '#fff', border: 'none',
                                borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                minHeight: '44px',
                              }}
                            >
                              {t('assign', lang)}
                            </button>
                            {assigningId === order.id && (
                              <div style={{
                                marginTop: '6px', borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border)', background: 'var(--bg-card)',
                                maxHeight: '180px', overflowY: 'auto',
                              }}>
                                {assignableStaff.length === 0 ? (
                                  <p style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
                                    {t('noStaff', lang)}
                                  </p>
                                ) : (
                                  assignableStaff.map(member => (
                                    <button
                                      key={member.id}
                                      onClick={() => handleAssign(order, member)}
                                      style={{
                                        width: '100%', padding: '10px 14px', border: 'none',
                                        background: 'transparent', cursor: 'pointer',
                                        textAlign: 'left', fontSize: '13px', color: 'var(--text-primary)',
                                        borderBottom: '1px solid var(--border)',
                                        minHeight: '44px',
                                      }}
                                    >
                                      {member.name}
                                      {member.department && (
                                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
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
                            className="btn"
                            style={{
                              width: '100%', padding: '10px', fontSize: '13px', fontWeight: 600,
                              background: 'rgba(245,158,11,0.12)', color: 'var(--amber)', border: 'none',
                              borderRadius: 'var(--radius-md)', cursor: 'pointer',
                              minHeight: '44px',
                            }}
                          >
                            {t('startWork', lang)}
                          </button>
                        )}

                        {order.status === 'in_progress' && (
                          <button
                            onClick={() => handleResolve(order)}
                            className="btn"
                            style={{
                              width: '100%', padding: '10px', fontSize: '13px', fontWeight: 600,
                              background: 'rgba(34,197,94,0.12)', color: 'var(--green)', border: 'none',
                              borderRadius: 'var(--radius-md)', cursor: 'pointer',
                              minHeight: '44px',
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
        ) : activeTab === 'preventive' ? (
          /* ── Preventive Maintenance Tab (Inspections) ── */
          <div className="animate-in stagger-2">
            <InspectionsView />
          </div>
        ) : (
          /* ── Landscaping Tab ── */
          <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            {/* Season filter pills */}
            <div className="scroll-pills" style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px', touchAction: 'pan-x', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
              {([
                { key: 'all' as SeasonFilterKey, label: lang === 'es' ? 'Todos' : 'All' },
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
                      display: 'flex', alignItems: 'center', gap: '5px',
                      padding: '7px 12px', border: 'none', cursor: 'pointer',
                      borderRadius: 'var(--radius-full)',
                      fontSize: '11px', fontWeight: 600, fontFamily: 'var(--font-sans)',
                      background: isActive ? (cfg ? cfg.bg : 'var(--navy)') : 'var(--bg-elevated)',
                      color: isActive ? (cfg ? cfg.color : '#fff') : 'var(--text-muted)',
                      outline: isActive && cfg ? `1.5px solid ${cfg.color}` : 'none',
                      transition: 'all 150ms', flexShrink: 0, minHeight: '32px',
                    }}
                  >
                    {cfg && React.createElement(cfg.icon, { size: 12 })}
                    {f.label}
                  </button>
                );
              })}
            </div>

            {/* Current season indicator */}
            {(() => {
              const cs = getCurrentSeason();
              const csCfg = SEASON_CONFIG[cs];
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 14px', borderRadius: 'var(--radius-md)',
                  background: csCfg.bg, fontSize: '12px', fontWeight: 600, color: csCfg.color,
                }}>
                  {React.createElement(csCfg.icon, { size: 14 })}
                  {lang === 'es' ? 'Temporada actual' : 'Current season'}: {lang === 'es' ? csCfg.labelEs : csCfg.label}
                </div>
              );
            })()}

            {/* Add task button */}
            <button
              onClick={() => setShowLsModal(true)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                padding: '10px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)',
                background: 'transparent', cursor: 'pointer',
                fontSize: '13px', fontWeight: 600, color: 'var(--navy)',
                minHeight: '44px',
              }}
            >
              <Plus size={14} />
              {t('addLandscapingTask', lang)}
            </button>

            {/* Task cards */}
            {filteredLsTasks.length === 0 ? (
              <div style={{
                padding: '48px 20px', textAlign: 'center', borderRadius: 'var(--radius-lg)',
                background: 'rgba(0,0,0,0.02)', border: '1px dashed var(--border)',
              }}>
                <TreePine size={28} color="var(--text-muted)" style={{ margin: '0 auto 10px' }} />
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
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
                const SeasonIcon = seasonCfg.icon;
                const borderColor = !inSeason ? 'var(--text-muted)' : isOverdue ? 'var(--red)' : isDueSoon ? 'var(--amber)' : 'var(--green)';

                return (
                  <div
                    key={task.id}
                    className="card"
                    style={{
                      padding: '10px 14px', borderLeft: `3px solid ${borderColor}`,
                      position: 'relative',
                      opacity: inSeason ? 1 : 0.55,
                    }}
                  >
                    {/* Row 1: name + season icon + delete */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <SeasonIcon size={12} color={seasonCfg.color} style={{ flexShrink: 0 }} />
                      <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {task.name}
                      </p>
                      {inSeason && (
                        <button
                          onClick={() => handleMarkLsDone(task)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '4px',
                            padding: '4px 10px', border: 'none', borderRadius: 'var(--radius-md)',
                            background: 'rgba(34,197,94,0.1)', color: 'var(--green)',
                            fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                            flexShrink: 0,
                          }}
                        >
                          <CheckCircle2 size={11} />
                          {t('markDone', lang)}
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteLs(task)}
                        aria-label={`Delete ${task.name}`}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0,
                        }}
                      >
                        <Trash2 size={12} color="var(--text-muted)" />
                      </button>
                    </div>

                    {/* Row 2: meta — due status · frequency · last */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px', fontSize: '11px', minWidth: 0 }}>
                      <span style={{
                        fontWeight: 700,
                        color: !inSeason ? 'var(--text-muted)' : isOverdue ? 'var(--red)' : isDueSoon ? 'var(--amber)' : 'var(--text-secondary)',
                        flexShrink: 0,
                      }}>
                        {!inSeason
                          ? (lang === 'es' ? 'Fuera de temporada' : 'Off-season')
                          : isOverdue
                            ? (lang === 'es' ? `Vencida ${Math.abs(daysUntil)}d` : `Overdue ${Math.abs(daysUntil)}d`)
                            : daysUntil === 0
                              ? t('dueToday', lang)
                              : (lang === 'es' ? `En ${daysUntil}d` : `In ${daysUntil}d`)
                        }
                      </span>
                      <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        · {lang === 'es' ? `cada ${task.frequencyDays}d` : `every ${task.frequencyDays}d`} · {task.lastCompletedAt ? formatShortDate(toJsDate(task.lastCompletedAt)) : t('never', lang)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── FAB (Work Orders tab only) ── */}
      {activeTab === 'workOrders' && (
        <button
          onClick={() => setShowCreateModal(true)}
          aria-label={t('newWorkOrder', lang)}
          style={{
            position: 'fixed', bottom: '80px', right: '20px', zIndex: 30,
            width: '56px', height: '56px', borderRadius: '50%',
            background: 'var(--navy)', color: '#fff', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 14px rgba(27,58,92,0.35)',
            transition: 'transform 150ms, box-shadow 150ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; }}
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
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowCreateModal(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '500px', maxHeight: '90vh', overflowY: 'auto',
            background: 'var(--bg-card)', borderRadius: '16px',
            padding: '20px',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>
                {t('newWorkOrder', lang)}
              </h2>
              <button onClick={() => setShowCreateModal(false)} aria-label={lang === 'es' ? 'Cerrar' : 'Close'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                <X size={20} color="var(--text-muted)" />
              </button>
            </div>

            {/* Room # */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                {t('roomNumber', lang)}
              </label>
              <input
                type="text"
                value={newRoom}
                onChange={e => setNewRoom(e.target.value)}
                placeholder="e.g. 302"
                style={{
                  width: '100%', padding: '12px 14px', fontSize: '14px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              />
            </div>

            {/* Description */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                {lang === 'es' ? 'Descripción' : 'Description'}
              </label>
              <textarea
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder={t('describeIssue', lang)}
                rows={3}
                style={{
                  width: '100%', padding: '12px 14px', fontSize: '14px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)', resize: 'none',
                }}
              />
            </div>

            {/* Severity */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px', display: 'block' }}>
                {t('severity', lang)}
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['low', 'medium', 'urgent'] as WorkOrderSeverity[]).map(sev => {
                  const isSelected = newSeverity === sev;
                  const style = SEVERITY_STYLE[sev];
                  return (
                    <button
                      key={sev}
                      onClick={() => setNewSeverity(sev)}
                      style={{
                        flex: 1, padding: '10px', border: 'none', borderRadius: 'var(--radius-md)',
                        fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                        background: isSelected ? style.bg : 'var(--bg-elevated)',
                        color: isSelected ? style.color : 'var(--text-muted)',
                        outline: isSelected ? `2px solid ${style.color}` : 'none',
                        transition: 'all 150ms', minHeight: '44px',
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
                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                border: newBlockRoom ? '2px solid var(--red)' : '1px solid var(--border)',
                background: newBlockRoom ? 'var(--red-dim)' : 'transparent',
                cursor: 'pointer', transition: 'all 150ms',
              }}
            >
              <div>
                <p style={{ fontSize: '13px', fontWeight: 600, color: newBlockRoom ? 'var(--red)' : 'var(--text-primary)' }}>
                  {lang === 'es' ? 'Bloquear Habitación' : 'Block Room'}
                </p>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {lang === 'es' ? 'No se puede rentar hasta resolver' : "Can't rent until resolved"}
                </p>
              </div>
              <div style={{
                width: '40px', height: '22px', borderRadius: '99px',
                background: newBlockRoom ? 'var(--red)' : 'rgba(0,0,0,0.12)',
                position: 'relative', transition: 'background 150ms',
              }}>
                <div style={{
                  width: '18px', height: '18px', borderRadius: '50%',
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
                borderRadius: 'var(--radius-md)', cursor: newDesc.trim() && !submitting ? 'pointer' : 'not-allowed',
                background: newDesc.trim() && !submitting ? 'var(--navy)' : 'var(--bg-elevated)',
                color: newDesc.trim() && !submitting ? '#fff' : 'var(--text-muted)',
                fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-sans)',
                transition: 'all 150ms', minHeight: '48px',
              }}
            >
              {submitting ? '...' : t('submitWorkOrder', lang)}
            </button>
          </div>
        </div>
      )}

      {/* ── Add Landscaping Task Modal ── */}
      {showLsModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowLsModal(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '500px',
            background: 'var(--bg-card)', borderRadius: '16px 16px 0 0',
            padding: '20px 20px calc(20px + env(safe-area-inset-bottom))',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>
                {t('addLandscapingTask', lang)}
              </h2>
              <button onClick={() => setShowLsModal(false)} aria-label={lang === 'es' ? 'Cerrar' : 'Close'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                <X size={20} color="var(--text-muted)" />
              </button>
            </div>

            {/* Task name */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                {t('landscapingTaskName', lang)}
              </label>
              <input
                type="text"
                value={newLsName}
                onChange={e => setNewLsName(e.target.value)}
                placeholder={lang === 'es' ? 'ej. Corte de césped' : 'e.g. Grass Mowing'}
                style={{
                  width: '100%', padding: '12px 14px', fontSize: '14px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)',
                }}
              />
            </div>

            {/* Season selector */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px', display: 'block' }}>
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
                        display: 'flex', alignItems: 'center', gap: '4px',
                        padding: '8px 12px', border: 'none', borderRadius: 'var(--radius-md)',
                        fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                        background: isSelected ? cfg.bg : 'var(--bg-elevated)',
                        color: isSelected ? cfg.color : 'var(--text-muted)',
                        outline: isSelected ? `2px solid ${cfg.color}` : 'none',
                        transition: 'all 150ms', minHeight: '36px',
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
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                {t('frequencyDays', lang)}
              </label>
              <input
                type="number"
                value={newLsFreq}
                onChange={e => setNewLsFreq(e.target.value)}
                min="1"
                style={{
                  width: '100%', padding: '12px 14px', fontSize: '14px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              />
            </div>

            <button
              onClick={handleCreateLs}
              disabled={!newLsName.trim() || submitting}
              style={{
                width: '100%', padding: '14px', border: 'none',
                borderRadius: 'var(--radius-md)', cursor: newLsName.trim() && !submitting ? 'pointer' : 'not-allowed',
                background: newLsName.trim() && !submitting ? 'var(--navy)' : 'var(--bg-elevated)',
                color: newLsName.trim() && !submitting ? '#fff' : 'var(--text-muted)',
                fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-sans)',
                transition: 'all 150ms', minHeight: '48px',
              }}
            >
              {submitting ? '...' : t('addLandscapingTask', lang)}
            </button>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '140px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 60, padding: '10px 20px', borderRadius: 'var(--radius-full)',
          background: 'var(--navy)', color: '#fff',
          fontSize: '13px', fontWeight: 600, fontFamily: 'var(--font-sans)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          animation: 'fadeIn 200ms ease-out',
        }}>
          {toast}
        </div>
      )}
    </AppLayout>
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
