'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { timeAgo } from '@/lib/utils';
import {
  subscribeToWorkOrders, addWorkOrder, updateWorkOrder,
  subscribeToPreventiveTasks, addPreventiveTask, updatePreventiveTask, deletePreventiveTask,
} from '@/lib/firestore';
import type { WorkOrder, WorkOrderSeverity, WorkOrderStatus, PreventiveTask, StaffMember } from '@/types';
import {
  Plus, X, Trash2, Wrench, CheckCircle2, Clock, ChevronDown, ChevronUp,
} from 'lucide-react';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'workOrders' | 'preventive';

// ─── Filter config ───────────────────────────────────────────────────────────

type FilterKey = 'all' | 'open' | 'urgent' | 'resolved';

// ─── Severity / status styles ────────────────────────────────────────────────

const SEVERITY_STYLE: Record<WorkOrderSeverity, { bg: string; color: string }> = {
  urgent: { bg: 'rgba(220,38,38,0.08)', color: '#dc2626' },
  medium: { bg: 'rgba(245,158,11,0.08)', color: '#f59e0b' },
  low:    { bg: 'rgba(156,163,175,0.08)', color: '#6b7280' },
};

const STATUS_STYLE: Record<WorkOrderStatus, { bg: string; color: string }> = {
  submitted:   { bg: 'rgba(220,38,38,0.08)', color: '#dc2626' },
  assigned:    { bg: 'rgba(59,130,246,0.08)', color: '#3b82f6' },
  in_progress: { bg: 'rgba(245,158,11,0.08)', color: '#f59e0b' },
  resolved:    { bg: 'rgba(34,197,94,0.08)', color: '#22c55e' },
};

// ─── Preventive defaults ─────────────────────────────────────────────────────

const PREVENTIVE_DEFAULTS = [
  { name: 'HVAC Filter Change', frequencyDays: 90 },
  { name: 'Fire Extinguisher Inspection', frequencyDays: 365 },
  { name: 'Smoke Detector Test', frequencyDays: 30 },
  { name: 'Water Heater Flush', frequencyDays: 180 },
  { name: 'Elevator Inspection', frequencyDays: 365 },
  { name: 'Pool Equipment Check', frequencyDays: 7 },
  { name: 'Ice Machine Cleaning', frequencyDays: 30 },
  { name: 'Pest Control Service', frequencyDays: 30 },
];

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

  const [activeTab, setActiveTab] = useState<TabKey>('workOrders');
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [tasks, setTasks] = useState<PreventiveTask[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Create work order form
  const [newRoom, setNewRoom] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newSeverity, setNewSeverity] = useState<WorkOrderSeverity>('medium');

  // Create task form
  const [newTaskName, setNewTaskName] = useState('');
  const [newTaskFreq, setNewTaskFreq] = useState('30');

  const seededRef = useRef(false);

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

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToPreventiveTasks(user.uid, activePropertyId, (incoming) => {
      setTasks(incoming);
      if (incoming.length === 0 && !seededRef.current) {
        seededRef.current = true;
        PREVENTIVE_DEFAULTS.forEach(d => {
          addPreventiveTask(user.uid, activePropertyId, {
            propertyId: activePropertyId,
            name: d.name,
            frequencyDays: d.frequencyDays,
            lastCompletedAt: null,
          });
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

  // ─── Sorted preventive tasks ─────────────────────────────────────────────

  const sortedTasks = useMemo(() => {
    const now = Date.now();
    return [...tasks].sort((a, b) => {
      const aDue = getDaysUntilDue(a, now);
      const bDue = getDaysUntilDue(b, now);
      return aDue - bDue;
    });
  }, [tasks]);

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
      });
      setShowCreateModal(false);
      setNewRoom('');
      setNewDesc('');
      setNewSeverity('medium');
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

  const handleMarkTaskDone = useCallback(async (task: PreventiveTask) => {
    if (!user || !activePropertyId) return;
    await updatePreventiveTask(user.uid, activePropertyId, task.id, {
      lastCompletedAt: new Date(),
      lastCompletedBy: user.displayName ?? undefined,
    });
  }, [user, activePropertyId]);

  const handleDeleteTask = useCallback(async (task: PreventiveTask) => {
    if (!user || !activePropertyId) return;
    if (!window.confirm(`Delete "${task.name}"?`)) return;
    await deletePreventiveTask(user.uid, activePropertyId, task.id);
  }, [user, activePropertyId]);

  const handleCreateTask = useCallback(async () => {
    if (!user || !activePropertyId || !newTaskName.trim() || submitting) return;
    setSubmitting(true);
    try {
      await addPreventiveTask(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        name: newTaskName.trim(),
        frequencyDays: Math.max(1, parseInt(newTaskFreq, 10) || 30),
        lastCompletedAt: null,
      });
      setShowTaskModal(false);
      setNewTaskName('');
      setNewTaskFreq('30');
    } finally {
      setSubmitting(false);
    }
  }, [user, activePropertyId, newTaskName, newTaskFreq, submitting]);

  // ─── Loading / auth guard render ─────────────────────────────────────────

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
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
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer',
                borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
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
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '2px' }}>
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
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {filteredOrders.map(order => {
                  const isExpanded = expandedId === order.id;
                  const sev = SEVERITY_STYLE[order.severity];
                  const stat = STATUS_STYLE[order.status];

                  return (
                    <div key={order.id}>
                      {/* Compact row */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                          transition: 'background 150ms',
                          background: isExpanded ? 'rgba(0, 0, 0, 0.02)' : 'transparent',
                          minHeight: '52px',
                        }}
                        onClick={() => setExpandedId(isExpanded ? null : order.id)}
                      >
                        {/* Severity badge - small colored dot */}
                        <div
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: sev.bg,
                            flexShrink: 0,
                          }}
                          title={sevLabel(order.severity)}
                        />

                        {/* Room number + description */}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                            {order.roomNumber && (
                              <span style={{
                                fontFamily: 'var(--font-mono)',
                                fontWeight: 700,
                                fontSize: '13px',
                                color: 'var(--text-primary)',
                                flexShrink: 0,
                              }}>
                                {lang === 'es' ? 'Hab' : 'Room'} {order.roomNumber}
                              </span>
                            )}
                            <p style={{
                              fontSize: '12px',
                              color: 'var(--text-muted)',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              margin: 0,
                            }}>
                              {order.description}
                            </p>
                          </div>
                          {order.assignedName && (
                            <span style={{
                              fontSize: '11px',
                              color: 'var(--text-muted)',
                            }}>
                              {order.assignedName}
                            </span>
                          )}
                        </div>

                        {/* Status badge */}
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-full)',
                          background: stat.bg,
                          color: stat.color,
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}>
                          {statusLabel(order.status)}
                        </span>

                        {/* Time */}
                        <span style={{
                          fontSize: '11px',
                          color: 'var(--text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '3px',
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}>
                          <Clock size={10} />
                          {timeAgo(toJsDate(order.createdAt))}
                        </span>

                        {/* Expand chevron */}
                        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                          {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </span>
                      </div>

                      {/* Expanded details - separate row */}
                      {isExpanded && (
                        <div
                          style={{
                            padding: '12px',
                            paddingLeft: '24px',
                            borderBottom: '1px solid var(--border)',
                            background: 'rgba(0, 0, 0, 0.02)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '10px',
                          }}
                          onClick={e => e.stopPropagation()}
                        >
                          {order.notes && (
                            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
                              <strong>{t('workOrderNotes', lang)}:</strong> {order.notes}
                            </p>
                          )}
                          {order.submittedByName && (
                            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
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
                              background: 'rgba(245,158,11,0.12)', color: '#d97706', border: 'none',
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
                              background: 'rgba(34,197,94,0.12)', color: '#16a34a', border: 'none',
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
                })}
              </div>
            )}
          </div>
        ) : (
          /* ── Preventive Maintenance Tab ── */
          <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            {/* Add task button */}
            <button
              onClick={() => setShowTaskModal(true)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                padding: '10px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)',
                background: 'transparent', cursor: 'pointer',
                fontSize: '13px', fontWeight: 600, color: 'var(--navy)',
                minHeight: '44px',
              }}
            >
              <Plus size={14} />
              {t('addTask', lang)}
            </button>

            {/* Task cards */}
            {sortedTasks.length === 0 ? (
              <div style={{
                padding: '48px 20px', textAlign: 'center', borderRadius: 'var(--radius-lg)',
                background: 'rgba(0,0,0,0.02)', border: '1px dashed var(--border)',
              }}>
                <CheckCircle2 size={28} color="var(--text-muted)" style={{ margin: '0 auto 10px' }} />
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {t('noPreventiveTasks', lang)}
                </p>
              </div>
            ) : (
              sortedTasks.map(task => {
                const daysUntil = getDaysUntilDue(task, Date.now());
                const isOverdue = daysUntil < 0;
                const isDueSoon = daysUntil >= 0 && daysUntil <= 7;
                const borderColor = isOverdue ? '#dc2626' : isDueSoon ? '#f59e0b' : '#22c55e';

                return (
                  <div
                    key={task.id}
                    className="card"
                    style={{
                      padding: '14px 16px', borderLeft: `3px solid ${borderColor}`,
                      position: 'relative',
                    }}
                  >
                    {/* Delete button */}
                    <button
                      onClick={() => handleDeleteTask(task)}
                      aria-label={`Delete ${task.name}`}
                      style={{
                        position: 'absolute', top: '12px', right: '12px',
                        background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
                      }}
                    >
                      <Trash2 size={14} color="var(--text-muted)" />
                    </button>

                    {/* Task name */}
                    <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', marginBottom: '4px', paddingRight: '28px' }}>
                      {task.name}
                    </p>

                    {/* Frequency + last completed */}
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      {lang === 'es' ? `Cada ${task.frequencyDays} días` : `Every ${task.frequencyDays} days`}
                      {' \u00b7 '}
                      {t('lastCompleted', lang)}: {task.lastCompletedAt ? formatShortDate(toJsDate(task.lastCompletedAt)) : t('never', lang)}
                    </p>

                    {/* Due status + mark done */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{
                        fontSize: '12px', fontWeight: 600,
                        color: isOverdue ? '#dc2626' : isDueSoon ? '#d97706' : 'var(--text-secondary)',
                      }}>
                        {isOverdue
                          ? (lang === 'es' ? `Vencida por ${Math.abs(daysUntil)} días` : `Overdue by ${Math.abs(daysUntil)} days`)
                          : daysUntil === 0
                            ? t('dueToday', lang)
                            : (lang === 'es' ? `Vence en ${daysUntil} días` : `Due in ${daysUntil} days`)
                        }
                      </span>
                      <button
                        onClick={() => handleMarkTaskDone(task)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '5px',
                          padding: '7px 14px', border: 'none', borderRadius: 'var(--radius-md)',
                          background: 'rgba(34,197,94,0.1)', color: '#16a34a',
                          fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                          minHeight: '36px',
                        }}
                      >
                        <CheckCircle2 size={13} />
                        {t('markDone', lang)}
                      </button>
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
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowCreateModal(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '500px',
            background: 'var(--bg-card)', borderRadius: '16px 16px 0 0',
            padding: '20px 20px calc(20px + env(safe-area-inset-bottom))',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>
                {t('newWorkOrder', lang)}
              </h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
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

      {/* ── Add Preventive Task Modal ── */}
      {showTaskModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowTaskModal(false); }}
        >
          <div style={{
            width: '100%', maxWidth: '500px',
            background: 'var(--bg-card)', borderRadius: '16px 16px 0 0',
            padding: '20px 20px calc(20px + env(safe-area-inset-bottom))',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>
                {t('addTask', lang)}
              </h2>
              <button onClick={() => setShowTaskModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                <X size={20} color="var(--text-muted)" />
              </button>
            </div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                {t('taskName', lang)}
              </label>
              <input
                type="text"
                value={newTaskName}
                onChange={e => setNewTaskName(e.target.value)}
                placeholder={t('taskName', lang)}
                style={{
                  width: '100%', padding: '12px 14px', fontSize: '14px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)',
                }}
              />
            </div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                {t('frequencyDays', lang)}
              </label>
              <input
                type="number"
                value={newTaskFreq}
                onChange={e => setNewTaskFreq(e.target.value)}
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
              onClick={handleCreateTask}
              disabled={!newTaskName.trim() || submitting}
              style={{
                width: '100%', padding: '14px', border: 'none',
                borderRadius: 'var(--radius-md)', cursor: newTaskName.trim() && !submitting ? 'pointer' : 'not-allowed',
                background: newTaskName.trim() && !submitting ? 'var(--navy)' : 'var(--bg-elevated)',
                color: newTaskName.trim() && !submitting ? '#fff' : 'var(--text-muted)',
                fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-sans)',
                transition: 'all 150ms', minHeight: '48px',
              }}
            >
              {submitting ? '...' : t('addTask', lang)}
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

// ─── Helper: days until preventive task is due ─────────────────────────────

function getDaysUntilDue(task: PreventiveTask, now: number): number {
  if (!task.lastCompletedAt) return -task.frequencyDays;
  const completed = toJsDate(task.lastCompletedAt);
  if (!completed) return -task.frequencyDays;
  const daysSince = Math.floor((now - completed.getTime()) / (1000 * 60 * 60 * 24));
  return task.frequencyDays - daysSince;
}
