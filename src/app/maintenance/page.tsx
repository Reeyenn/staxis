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
  subscribeToWorkOrders, addWorkOrder, updateWorkOrder, deleteWorkOrder,
  subscribeToLandscapingTasks, addLandscapingTask, updateLandscapingTask, deleteLandscapingTask,
  subscribeToEquipment, addEquipment, updateEquipment, deleteEquipment,
  subscribeToPreventiveTasks,
  subscribeToInventory, updateInventoryItem,
  addPreventiveTask,
} from '@/lib/db';
import type { WorkOrder, WorkOrderSeverity, WorkOrderStatus, LandscapingTask, LandscapingSeason, Equipment, EquipmentCategory, EquipmentStatus, PreventiveTask, InventoryItem } from '@/types';
import {
  generateColdStartAlerts, predictFailures, repairVsReplace,
  type MaintenanceAlert,
} from '@/lib/maintenance-ml';
import Link from 'next/link';
import {
  Plus, X, Trash2, Wrench, CheckCircle2, Check, Clock, ChevronDown, ChevronUp,
  TreePine, Leaf, Sun, Snowflake, Flower2,
  Settings, AlertTriangle, BarChart3,
} from 'lucide-react';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'workOrders' | 'preventive' | 'equipment' | 'landscaping';

// Default equipment seed — first time the equipment tab loads with zero
// rows, we drop these in so the user has a starting point. They edit
// locations/manufacturers/dates per their property.
const EQUIPMENT_SEED: Omit<Equipment, 'id' | 'propertyId' | 'createdAt' | 'updatedAt'>[] = [
  { name: 'Boiler / Water Heater',  category: 'plumbing',  status: 'operational', expectedLifetimeYears: 12, pmIntervalDays: 180 },
  { name: 'Front Desk HVAC',         category: 'hvac',      status: 'operational', expectedLifetimeYears: 15, pmIntervalDays: 90 },
  { name: 'Lobby HVAC',              category: 'hvac',      status: 'operational', expectedLifetimeYears: 15, pmIntervalDays: 90 },
  { name: 'Elevator',                category: 'elevator',  status: 'operational', expectedLifetimeYears: 25, pmIntervalDays: 30 },
  { name: 'Pool Pump',               category: 'pool',      status: 'operational', expectedLifetimeYears: 8,  pmIntervalDays: 90 },
  { name: 'Pool Heater',             category: 'pool',      status: 'operational', expectedLifetimeYears: 10, pmIntervalDays: 180 },
  { name: 'Ice Machine',             category: 'appliance', status: 'operational', expectedLifetimeYears: 7,  pmIntervalDays: 90 },
  { name: 'Industrial Washer',       category: 'laundry',   status: 'operational', expectedLifetimeYears: 10, pmIntervalDays: 90 },
  { name: 'Industrial Dryer',        category: 'laundry',   status: 'operational', expectedLifetimeYears: 10, pmIntervalDays: 90 },
  { name: 'Breakfast Coffee Machine', category: 'kitchen',  status: 'operational', expectedLifetimeYears: 5,  pmIntervalDays: 60 },
  { name: 'Refrigerator (Breakfast)', category: 'kitchen',  status: 'operational', expectedLifetimeYears: 10, pmIntervalDays: 180 },
  { name: 'Backup Generator',        category: 'electrical', status: 'operational', expectedLifetimeYears: 20, pmIntervalDays: 90 },
];

const EQUIPMENT_CATEGORY_LABEL = (cat: EquipmentCategory, lang: 'en' | 'es'): string => {
  const map: Record<EquipmentCategory, [string, string]> = {
    hvac:       ['HVAC', 'HVAC'],
    plumbing:   ['Plumbing', 'Plomería'],
    electrical: ['Electrical', 'Eléctrico'],
    appliance:  ['Appliance', 'Electrodoméstico'],
    structural: ['Structural', 'Estructural'],
    elevator:   ['Elevator', 'Ascensor'],
    pool:       ['Pool', 'Piscina'],
    laundry:    ['Laundry', 'Lavandería'],
    kitchen:    ['Kitchen', 'Cocina'],
    other:      ['Other', 'Otro'],
  };
  return map[cat][lang === 'es' ? 1 : 0];
};

const EQUIPMENT_STATUS_STYLE: Record<EquipmentStatus, { bg: string; color: string; labelEn: string; labelEs: string }> = {
  operational:    { bg: 'rgba(0,101,101,0.10)', color: '#006565', labelEn: 'Operational',    labelEs: 'Operativo' },
  degraded:       { bg: 'rgba(201,138,20,0.10)', color: '#c98a14', labelEn: 'Degraded',       labelEs: 'Deteriorado' },
  failed:         { bg: 'rgba(186,26,26,0.10)',  color: '#ba1a1a', labelEn: 'Failed',         labelEs: 'Fallado' },
  replaced:       { bg: 'rgba(54,66,98,0.10)',   color: '#364262', labelEn: 'Replaced',       labelEs: 'Reemplazado' },
  decommissioned: { bg: 'rgba(117,118,132,0.10)', color: '#757684', labelEn: 'Decommissioned', labelEs: 'Retirado' },
};

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
    if (p === 'preventive' || p === 'landscaping' || p === 'workOrders' || p === 'equipment') return p;
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
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Create work order form
  const [newRoom, setNewRoom] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newSeverity, setNewSeverity] = useState<WorkOrderSeverity>('medium');
  const [newBlockRoom, setNewBlockRoom] = useState(false);
  const [newEquipmentId, setNewEquipmentId] = useState<string>('');
  const [newRepairCost, setNewRepairCost] = useState<string>('');

  // Inline-edit state — one order at a time. Fields mirror the create form
  // so the same severity pills / block toggle logic works.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRoom, setEditRoom] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSeverity, setEditSeverity] = useState<WorkOrderSeverity>('medium');
  const [editNotes, setEditNotes] = useState('');
  const [editBlockRoom, setEditBlockRoom] = useState(false);
  const [editEquipmentId, setEditEquipmentId] = useState<string>('');
  const [editRepairCost, setEditRepairCost] = useState<string>('');
  const [editPartsUsed, setEditPartsUsed] = useState<string[]>([]);
  const [partsInputDraft, setPartsInputDraft] = useState<string>('');

  // Landscaping state
  const [lsTasks, setLsTasks] = useState<LandscapingTask[]>([]);
  const [lsSeasonFilter, setLsSeasonFilter] = useState<SeasonFilterKey>('all');
  const [showLsModal, setShowLsModal] = useState(false);
  const [editLsTask, setEditLsTask] = useState<LandscapingTask | null>(null);
  const [newLsName, setNewLsName] = useState('');
  const [newLsSeason, setNewLsSeason] = useState<LandscapingSeason>('year-round');
  const [newLsFreq, setNewLsFreq] = useState('7');

  const lsSeededRef = useRef(false);

  // Equipment registry
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [preventiveTasks, setPreventiveTasks] = useState<PreventiveTask[]>([]);
  const [showEquipmentModal, setShowEquipmentModal] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<Equipment | null>(null);
  const equipmentSeededRef = useRef(false);

  // Maintenance-category inventory for the resolve-with-supplies modal.
  // We subscribe to ALL inventory + filter client-side because there's no
  // server-side filter helper for category and the list is small.
  const [maintenanceSupplies, setMaintenanceSupplies] = useState<InventoryItem[]>([]);
  const [resolvingOrder, setResolvingOrder] = useState<WorkOrder | null>(null);
  const [supplyUsage, setSupplyUsage] = useState<Record<string, number>>({});
  const [showSupplyList, setShowSupplyList] = useState(false);
  const [resolving, setResolving] = useState(false);

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

  // Equipment subscription — seeds the default fleet on first load.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToEquipment(user.uid, activePropertyId, (incoming) => {
      setEquipment(incoming);
      if (incoming.length === 0 && !equipmentSeededRef.current) {
        equipmentSeededRef.current = true;
        EQUIPMENT_SEED.forEach(d => {
          addEquipment(user.uid, activePropertyId, {
            ...d, propertyId: activePropertyId,
          }).catch(err => console.error('[equipment] seed failed:', err));
        });
      }
    });
  }, [user, activePropertyId]);

  // Preventive tasks — used by the ML utility's PM-overdue rule.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToPreventiveTasks(user.uid, activePropertyId, setPreventiveTasks);
  }, [user, activePropertyId]);

  // Maintenance-category inventory — drives the supply-deduction modal that
  // shows when a work order is being resolved.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToInventory(user.uid, activePropertyId, (incoming) => {
      setMaintenanceSupplies(incoming.filter(i => i.category === 'maintenance'));
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
    // "All" means all — open AND resolved. Previously "all" was an alias for
    // "open" (filtering out resolved) so the pill label lied and the "All"
    // and "Open" pills showed identical counts. The original concern was
    // duplicate rooms when a ca_ooo work order auto-resolves and a new one
    // opens for the same room — but newest-first sort + the visible
    // BLOCKED/RESOLVED status tag make that readable, and anyone clicking
    // "All" expects to see everything.
    let list: WorkOrder[] = orders;
    if (filter === 'open') list = orders.filter(o => o.status !== 'resolved');
    else if (filter === 'urgent') list = orders.filter(o => o.severity === 'urgent' && o.status !== 'resolved');
    else if (filter === 'resolved') list = orders.filter(o => o.status === 'resolved');

    return [...list].sort((a, b) => {
      const sevOrder: Record<WorkOrderSeverity, number> = { urgent: 0, medium: 1, low: 2 };
      if (a.status !== 'resolved' && b.status !== 'resolved') {
        if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
      }
      // Open before resolved when mixed ("All" view).
      if ((a.status === 'resolved') !== (b.status === 'resolved')) {
        return a.status === 'resolved' ? 1 : -1;
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
        equipmentId: newEquipmentId || undefined,
        repairCost: newRepairCost ? parseFloat(newRepairCost) : undefined,
      });
      setShowCreateModal(false);
      setNewRoom('');
      setNewDesc('');
      setNewSeverity('medium');
      setNewBlockRoom(false);
      setNewEquipmentId('');
      setNewRepairCost('');
      setToast(t('workOrderSubmitted', lang) + ' \u2713');
    } finally {
      setSubmitting(false);
    }
    // `newBlockRoom` is read inside; adding it to deps is correct.
  }, [user, activePropertyId, newRoom, newDesc, newSeverity, submitting, lang, newBlockRoom, newEquipmentId, newRepairCost]);

  const handleStartWork = useCallback(async (order: WorkOrder) => {
    if (!user || !activePropertyId) return;
    await updateWorkOrder(user.uid, activePropertyId, order.id, { status: 'in_progress' });
  }, [user, activePropertyId]);

  // Open the supply-deduction modal. The modal's "No, Just Resolve" path
  // calls handleResolveJustComplete, which is the original behavior.
  const handleOpenResolve = useCallback((order: WorkOrder) => {
    setResolvingOrder(order);
    setSupplyUsage({});
    setShowSupplyList(false);
  }, []);

  const handleResolveJustComplete = useCallback(async (order: WorkOrder) => {
    if (!user || !activePropertyId) return;
    setResolving(true);
    try {
      await updateWorkOrder(user.uid, activePropertyId, order.id, {
        status: 'resolved',
        resolvedAt: new Date(),
      });
      setResolvingOrder(null);
      setSupplyUsage({});
      setShowSupplyList(false);
    } finally {
      setResolving(false);
    }
  }, [user, activePropertyId]);

  // Confirm-and-resolve: deduct each supply from inventory, accumulate the
  // names into parts_used, then mark the work order resolved. Stock is
  // floored at 0 so a typo doesn't drive current_stock negative.
  const handleResolveWithSupplies = useCallback(async () => {
    if (!user || !activePropertyId || !resolvingOrder) return;
    setResolving(true);
    try {
      const partsUsedNames: string[] = [];
      let deductedCount = 0;
      for (const item of maintenanceSupplies) {
        const qty = supplyUsage[item.id] ?? 0;
        if (qty <= 0) continue;
        const newStock = Math.max(0, item.currentStock - qty);
        await updateInventoryItem(user.uid, activePropertyId, item.id, { currentStock: newStock });
        partsUsedNames.push(`${qty} × ${item.name}`);
        deductedCount++;
      }
      const merged = [...(resolvingOrder.partsUsed ?? []), ...partsUsedNames];
      await updateWorkOrder(user.uid, activePropertyId, resolvingOrder.id, {
        status: 'resolved',
        resolvedAt: new Date(),
        partsUsed: merged,
      });
      setToast(lang === 'es'
        ? `Orden completada. ${deductedCount} material${deductedCount === 1 ? '' : 'es'} descontado${deductedCount === 1 ? '' : 's'}.`
        : `Work order resolved. ${deductedCount} suppl${deductedCount === 1 ? 'y' : 'ies'} deducted.`);
      setResolvingOrder(null);
      setSupplyUsage({});
      setShowSupplyList(false);
    } finally {
      setResolving(false);
    }
  }, [user, activePropertyId, resolvingOrder, maintenanceSupplies, supplyUsage, lang]);

  // Back-compat alias — older code paths still reference handleResolve. Now
  // routes through the modal.
  const handleResolve = handleOpenResolve;

  // ─── Edit / delete handlers ──────────────────────────────────────────────

  const handleBeginEdit = useCallback((order: WorkOrder) => {
    setEditingId(order.id);
    setEditRoom(order.roomNumber || '');
    setEditDesc(order.description);
    setEditSeverity(order.severity);
    setEditNotes(order.notes || '');
    setEditBlockRoom(!!order.blockedRoom);
    setEditEquipmentId(order.equipmentId || '');
    setEditRepairCost(order.repairCost != null ? String(order.repairCost) : '');
    setEditPartsUsed(order.partsUsed || []);
    setPartsInputDraft('');
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setPartsInputDraft('');
  }, []);

  const handleSaveEdit = useCallback(async (order: WorkOrder) => {
    if (!user || !activePropertyId || !editDesc.trim()) return;
    // NOTE: ca_ooo work orders are re-synced from Choice Advantage every 15
    // min — description/severity/notes edits will be overwritten on the next
    // scrape. That's by design (CA is source of truth). If Reeyen wants
    // sticky edits on synced rows we'd need a `managerOverride` flag.
    await updateWorkOrder(user.uid, activePropertyId, order.id, {
      roomNumber:  editRoom.trim(),
      description: editDesc.trim(),
      severity:    editSeverity,
      notes:       editNotes.trim() || '',
      blockedRoom: editBlockRoom,
      equipmentId: editEquipmentId || undefined,
      repairCost:  editRepairCost ? parseFloat(editRepairCost) : undefined,
      partsUsed:   editPartsUsed,
    });
    setEditingId(null);
    setPartsInputDraft('');
    setToast((lang === 'es' ? 'Actualizado' : 'Updated') + ' \u2713');
  }, [user, activePropertyId, editRoom, editDesc, editSeverity, editNotes, editBlockRoom, editEquipmentId, editRepairCost, editPartsUsed, lang]);

  const handleDeleteOrder = useCallback(async (order: WorkOrder) => {
    if (!user || !activePropertyId) return;
    const confirmMsg = lang === 'es'
      ? '¿Eliminar esta orden de trabajo? No se puede deshacer.'
      : `Delete this work order? This can't be undone.`;
    if (!window.confirm(confirmMsg)) return;
    await deleteWorkOrder(user.uid, activePropertyId, order.id);
    setEditingId(null);
    setToast((lang === 'es' ? 'Eliminado' : 'Deleted') + ' \u2713');
  }, [user, activePropertyId, lang]);

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
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px', background: 'var(--bg)' }}>
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


  // ─── AI Insight computation ─────────────────────────────────────────────
  // Three tiers, in priority order:
  //   1. Layer 2 prediction (Weibull + repair-vs-replace) when there's
  //      enough data and a high-confidence finding worth surfacing.
  //   2. Layer 1 cold-start alert (recurrence / cost / spatial / PM / age).
  //   3. Status-based fallback (existing copy).
  const aiInsightText = (() => {
    // ── Layer 2 ──────────────────────────────────────────────────────────
    const recommendations = repairVsReplace(equipment, orders);
    const replaceNow = recommendations.find(r => r.recommendation === 'replace_now');
    if (replaceNow) {
      const eq = equipment.find(e => e.id === replaceNow.equipmentId);
      if (eq) {
        return lang === 'es'
          ? `${eq.name} ha costado ${formatShortDollars(replaceNow.cumulativeRepairCost)} en reparaciones (vs ${formatShortDollars(replaceNow.replacementCost)} de reemplazo). Recomendación: reemplazar ahora — ${replaceNow.reasoning.toLowerCase()}`
          : `${eq.name} has cost ${formatShortDollars(replaceNow.cumulativeRepairCost)} in repairs (vs ${formatShortDollars(replaceNow.replacementCost)} to replace). Recommend replacing now — ${replaceNow.reasoning.toLowerCase()}`;
      }
    }
    const planReplace = recommendations.find(r => r.recommendation === 'plan_replacement');
    if (planReplace) {
      const eq = equipment.find(e => e.id === planReplace.equipmentId);
      if (eq) {
        return lang === 'es'
          ? `${eq.name} se acerca al punto de reemplazo. Reparaciones acumuladas: ${formatShortDollars(planReplace.cumulativeRepairCost)} (${Math.round(planReplace.cumulativeRepairCost / planReplace.replacementCost * 100)}% del costo de reemplazo). Considere reemplazar en su próxima ventana de baja ocupación.`
          : `${eq.name} is approaching replacement territory. Cumulative repairs: ${formatShortDollars(planReplace.cumulativeRepairCost)} (${Math.round(planReplace.cumulativeRepairCost / planReplace.replacementCost * 100)}% of replacement cost). Consider scheduling replacement during your next low-occupancy window.`;
      }
    }

    const failurePreds = predictFailures(equipment, orders);
    const highRisk = failurePreds
      .filter(p => p.confidenceLevel !== 'low' && p.probabilityOfFailure30d > 0.5)
      .sort((a, b) => b.probabilityOfFailure30d - a.probabilityOfFailure30d)[0];
    if (highRisk) {
      const eq = equipment.find(e => e.id === highRisk.equipmentId);
      if (eq) {
        const pct = Math.round(highRisk.probabilityOfFailure30d * 100);
        return lang === 'es'
          ? `${eq.name} tiene ${pct}% probabilidad de fallar en los próximos 30 días según patrones históricos. Programar mantenimiento preventivo proactivo.`
          : `${eq.name} has a ${pct}% chance of failing in the next 30 days based on historical patterns. Schedule proactive PM.`;
      }
    }

    // ── Layer 1 ──────────────────────────────────────────────────────────
    const alerts = generateColdStartAlerts(equipment, orders, preventiveTasks);
    const critical = alerts.find(a => a.severity === 'critical');
    if (critical) {
      return lang === 'es'
        ? `${critical.message}. ${critical.recommendation}`
        : `${critical.message}. ${critical.recommendation}`;
    }
    const warning = alerts.find(a => a.severity === 'warning');
    if (warning) {
      return lang === 'es'
        ? `${warning.message}. ${warning.recommendation}`
        : `${warning.message}. ${warning.recommendation}`;
    }

    // ── Layer 0: status fallback (existing copy) ─────────────────────────
    const openCount = orders.filter(o => o.status !== 'resolved').length;
    const urgentCount = orders.filter(o => o.severity === 'urgent' && o.status !== 'resolved').length;
    const resolvedCount = orders.filter(o => o.status === 'resolved').length;
    const blockedCount = orders.filter(o => o.blockedRoom && o.status !== 'resolved').length;

    if (urgentCount >= 2) {
      return lang === 'es'
        ? `${urgentCount} órdenes urgentes requieren atención inmediata. ${blockedCount > 0 ? `${blockedCount} habitación${blockedCount > 1 ? 'es' : ''} bloqueada hasta resolver.` : 'Priorice el despacho.'}`
        : `${urgentCount} urgent work orders require immediate attention. ${blockedCount > 0 ? `${blockedCount} room${blockedCount > 1 ? 's' : ''} blocked from rental until resolved.` : 'Recommend prioritizing dispatch for these units.'}`;
    }
    if (openCount > 5) {
      return lang === 'es'
        ? `Volumen de órdenes mayor que lo típico. ${openCount} órdenes abiertas. Considere agregar personal de mantenimiento.`
        : `Work order volume is higher than typical. ${openCount} open orders across the property. ${urgentCount > 0 ? `${urgentCount} marked urgent.` : 'No urgent items currently.'} Consider scheduling additional maintenance staff.`;
    }
    if (resolvedCount > 0 && openCount <= 3) {
      return lang === 'es'
        ? `Operaciones funcionando bien — ${resolvedCount} resuelta${resolvedCount > 1 ? 's' : ''} con solo ${openCount} pendiente${openCount !== 1 ? 's' : ''}.`
        : `Operations running smoothly — ${resolvedCount} order${resolvedCount > 1 ? 's' : ''} resolved with only ${openCount} remaining open. Team efficiency is strong.`;
    }
    if (openCount === 0) {
      return lang === 'es'
        ? 'Todas las órdenes resueltas. Sin problemas de mantenimiento pendientes.'
        : 'All work orders resolved. No outstanding maintenance issues. Property is in excellent operational condition.';
    }
    return lang === 'es'
      ? `${openCount} orden${openCount !== 1 ? 'es' : ''} abierta${openCount !== 1 ? 's' : ''}. ${urgentCount > 0 ? `${urgentCount} urgente${urgentCount !== 1 ? 's' : ''}.` : 'Sin urgencias.'}`
      : `${openCount} open work order${openCount !== 1 ? 's' : ''} currently tracked. ${urgentCount > 0 ? `${urgentCount} urgent.` : 'No urgent items.'} Maintenance pipeline is manageable.`;
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

        {/* ── Tabs + Analytics link ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          {([
            { key: 'workOrders' as TabKey, label: t('workOrders', lang) },
            { key: 'preventive' as TabKey, label: t('preventive', lang) },
            { key: 'equipment' as TabKey, label: lang === 'es' ? 'Equipos' : 'Equipment' },
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
        <Link
          href="/maintenance/analytics"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '6px 12px', borderRadius: '9999px', border: '1px solid #c5c5d4',
            background: 'transparent', color: '#364262', textDecoration: 'none',
            fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
          }}
        >
          <BarChart3 size={13} />
          {lang === 'es' ? 'Analíticas' : 'Analytics'}
        </Link>
        </div>

        {/* ── Tab content ──
            Keyed wrapper retriggers .animate-in on every tab switch so
            the content cascades in like the dashboard, instead of
            popping in instantly. Inner tab branches keep their own
            stagger-N classes to chain the cascade. */}
        {activeTab === 'workOrders' ? (
          <div key="workOrders" className="animate-in stagger-1" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Blocked-rooms banner — tells Maria at a glance how many rooms
                are currently flagged as unrentable. Hidden when zero so the
                UI stays clean on a quiet day. */}
            {(() => {
              const blockedCount = orders.filter(o => o.blockedRoom && o.status !== 'resolved').length;
              if (blockedCount === 0) return null;
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '10px 14px', borderRadius: '12px',
                  background: '#ffdad6', color: '#93000a',
                  boxShadow: 'inset 0 0 0 1px rgba(186,26,26,0.15)',
                }}>
                  <span style={{ fontSize: '18px', lineHeight: 1 }}>⛔</span>
                  <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600 }}>
                    {lang === 'es'
                      ? `${blockedCount} habitaci${blockedCount === 1 ? 'ón bloqueada' : 'ones bloqueadas'} de renta`
                      : `${blockedCount} room${blockedCount === 1 ? '' : 's'} blocked from rental`}
                  </span>
                </div>
              );
            })()}

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
                      onClick={() => handleBeginEdit(order)}
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
                              {order.description.length > 40 ? order.description.slice(0, 40) + '…' : order.description}
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

                      {/* Notes preview */}
                      {order.notes && (
                        <div style={{
                          background: 'rgba(245,243,238,0.4)', borderRadius: '12px',
                          padding: '12px 16px', marginTop: '16px',
                        }}>
                          <p style={{ fontSize: '14px', color: '#1b1c19', lineHeight: 1.6, fontStyle: 'italic', margin: 0 }}>
                            &ldquo;{order.notes}&rdquo;
                          </p>
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
          /* ── Preventive Maintenance Tab ── */
          <div key="preventive" className="animate-in stagger-1" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <PreventiveIntelligence
              equipment={equipment}
              preventiveTasks={preventiveTasks}
              workOrders={orders}
              uid={user!.uid}
              pid={activePropertyId!}
              lang={lang}
              onToast={(msg) => setToast(msg)}
            />
            <InspectionsView />
          </div>
        ) : activeTab === 'equipment' ? (
          /* ── Equipment Registry Tab ── */
          <EquipmentTab
            equipment={equipment}
            workOrders={orders}
            uid={user!.uid}
            pid={activePropertyId!}
            lang={lang}
            onEdit={(e) => { setEditingEquipment(e); setShowEquipmentModal(true); }}
            onAdd={() => { setEditingEquipment(null); setShowEquipmentModal(true); }}
          />
        ) : (
          /* ── Landscaping Tab — Stitch Concierge Layout ── */
          <div key="landscaping" className="animate-in stagger-1" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

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

            {/* Equipment dropdown — auto-fills Room # when a location looks
                like a room number (purely numeric, max 4 chars). */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {lang === 'es' ? 'Equipo' : 'Equipment'}
              </label>
              <select
                value={newEquipmentId}
                onChange={e => {
                  const id = e.target.value;
                  setNewEquipmentId(id);
                  // Auto-fill Room # if equipment.location is a room-number-shaped string.
                  if (id && !newRoom) {
                    const eq = equipment.find(x => x.id === id);
                    if (eq?.location && /^\d{2,4}$/.test(eq.location.trim())) {
                      setNewRoom(eq.location.trim());
                    }
                  }
                }}
                style={{
                  width: '100%', padding: '12px 16px', fontSize: '14px',
                  border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                  background: '#fff', color: '#1b1c19',
                  fontFamily: "'Inter', sans-serif",
                  outline: 'none', transition: 'border 150ms',
                }}
              >
                <option value="">{lang === 'es' ? 'Ninguno' : 'None'}</option>
                {equipment.map(eq => (
                  <option key={eq.id} value={eq.id}>
                    {eq.name}{eq.location ? ` (${eq.location})` : ''}
                  </option>
                ))}
              </select>
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

            {/* Repair Cost — optional dollar amount */}
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                {lang === 'es' ? 'Costo de Reparación ($)' : 'Repair Cost ($)'}
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={newRepairCost}
                onChange={e => setNewRepairCost(e.target.value)}
                placeholder="0.00"
                style={{
                  width: '100%', padding: '12px 16px', fontSize: '14px',
                  border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                  background: '#fff', color: '#1b1c19',
                  fontFamily: "'JetBrains Mono', monospace",
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

      {/* ── Edit Work Order Modal ─────────────────────────────────────────
          Opens when editingId is set (via the Edit button on a card).
          Mirrors the Create modal's structure so it feels native, plus the
          iOS-style Block Room toggle Reeyen asked for. */}
      {editingId && (() => {
        const order = orders.find(o => o.id === editingId);
        if (!order) return null;
        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 50,
              background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '20px',
            }}
            onClick={e => { if (e.target === e.currentTarget) handleCancelEdit(); }}
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
                  {lang === 'es' ? 'Editar Orden' : 'Edit Work Order'}
                </h2>
                <button onClick={handleCancelEdit} aria-label={lang === 'es' ? 'Cerrar' : 'Close'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
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
                  value={editRoom}
                  onChange={e => setEditRoom(e.target.value)}
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
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
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
                    const isSelected = editSeverity === sev;
                    const pillColors: Record<WorkOrderSeverity, { bg: string; color: string }> = {
                      low: { bg: '#eae8e3', color: '#454652' },
                      medium: { bg: '#d3e4f8', color: '#506071' },
                      urgent: { bg: '#ffdad6', color: '#93000a' },
                    };
                    return (
                      <button
                        key={sev}
                        onClick={() => setEditSeverity(sev)}
                        style={{
                          flex: 1, padding: '10px', border: 'none', borderRadius: '12px',
                          fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                          fontFamily: "'Inter', sans-serif",
                          background: isSelected ? pillColors[sev].bg : '#f5f3ee',
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

              {/* Notes */}
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                  {lang === 'es' ? 'Notas' : 'Notes'}
                </label>
                <textarea
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  rows={2}
                  placeholder={lang === 'es' ? 'Opcional' : 'Optional'}
                  style={{
                    width: '100%', padding: '12px 16px', fontSize: '14px',
                    border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                    background: '#fff', color: '#1b1c19',
                    fontFamily: "'Inter', sans-serif", resize: 'none',
                    outline: 'none', transition: 'border 150ms',
                  }}
                />
              </div>

              {/* Equipment dropdown */}
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                  {lang === 'es' ? 'Equipo' : 'Equipment'}
                </label>
                <select
                  value={editEquipmentId}
                  onChange={e => setEditEquipmentId(e.target.value)}
                  style={{
                    width: '100%', padding: '12px 16px', fontSize: '14px',
                    border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                    background: '#fff', color: '#1b1c19',
                    fontFamily: "'Inter', sans-serif",
                    outline: 'none', transition: 'border 150ms',
                  }}
                >
                  <option value="">{lang === 'es' ? 'Ninguno' : 'None'}</option>
                  {equipment.map(eq => (
                    <option key={eq.id} value={eq.id}>
                      {eq.name}{eq.location ? ` (${eq.location})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Repair Cost */}
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                  {lang === 'es' ? 'Costo de Reparación ($)' : 'Repair Cost ($)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editRepairCost}
                  onChange={e => setEditRepairCost(e.target.value)}
                  placeholder="0.00"
                  style={{
                    width: '100%', padding: '12px 16px', fontSize: '14px',
                    border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                    background: '#fff', color: '#1b1c19',
                    fontFamily: "'JetBrains Mono', monospace",
                    outline: 'none', transition: 'border 150ms',
                  }}
                />
              </div>

              {/* Parts Used — chip input. Press Enter to add a tag, click X to remove. */}
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: '#454652', marginBottom: '6px', display: 'block', fontFamily: "'Inter', sans-serif" }}>
                  {lang === 'es' ? 'Partes Usadas' : 'Parts Used'}
                </label>
                {editPartsUsed.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                    {editPartsUsed.map((part, idx) => (
                      <span key={idx} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        padding: '4px 10px', borderRadius: '9999px',
                        background: '#f0eee9', color: '#454652',
                        fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 500,
                      }}>
                        {part}
                        <button
                          type="button"
                          onClick={() => setEditPartsUsed(prev => prev.filter((_, i) => i !== idx))}
                          aria-label={lang === 'es' ? 'Quitar' : 'Remove'}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: '#757684', display: 'inline-flex', alignItems: 'center' }}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  type="text"
                  value={partsInputDraft}
                  onChange={e => setPartsInputDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const v = partsInputDraft.trim();
                      if (v) {
                        setEditPartsUsed(prev => [...prev, v]);
                        setPartsInputDraft('');
                      }
                    }
                  }}
                  placeholder={lang === 'es' ? 'Escriba y presione Enter' : 'Type and press Enter'}
                  style={{
                    width: '100%', padding: '12px 16px', fontSize: '14px',
                    border: '1px solid rgba(197,197,212,0.3)', borderRadius: '12px',
                    background: '#fff', color: '#1b1c19',
                    fontFamily: "'Inter', sans-serif",
                    outline: 'none', transition: 'border 150ms',
                  }}
                />
              </div>

              {/* Block Room — iOS-style slider toggle */}
              <div
                onClick={() => setEditBlockRoom(!editBlockRoom)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 16px', borderRadius: '12px',
                  border: editBlockRoom ? '2px solid #ba1a1a' : '1px solid rgba(197,197,212,0.3)',
                  background: editBlockRoom ? '#ffdad6' : 'transparent',
                  cursor: 'pointer', transition: 'all 150ms',
                }}
              >
                <div>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: editBlockRoom ? '#93000a' : '#1b1c19', margin: 0, fontFamily: "'Inter', sans-serif" }}>
                    {lang === 'es' ? 'Bloquear Habitación' : 'Block Room'}
                  </p>
                  <p style={{ fontSize: '12px', color: '#757684', marginTop: '2px', fontFamily: "'Inter', sans-serif" }}>
                    {lang === 'es' ? 'No se puede rentar hasta resolver' : "Can't rent until resolved"}
                  </p>
                </div>
                <div style={{
                  width: '42px', height: '24px', borderRadius: '99px',
                  background: editBlockRoom ? '#ba1a1a' : 'rgba(0,0,0,0.12)',
                  position: 'relative', transition: 'background 150ms',
                  flexShrink: 0,
                }}>
                  <div style={{
                    width: '20px', height: '20px', borderRadius: '50%',
                    background: '#fff', position: 'absolute', top: '2px',
                    left: editBlockRoom ? '20px' : '2px',
                    transition: 'left 150ms',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </div>
              </div>

              {order.source === 'ca_ooo' && (
                <p style={{ fontSize: '11px', color: '#757684', fontStyle: 'italic', margin: 0, lineHeight: 1.4 }}>
                  {lang === 'es'
                    ? 'Sincronizado desde Choice Advantage — los cambios pueden sobrescribirse en la próxima sincronización.'
                    : 'Synced from Choice Advantage — edits may be overwritten on next sync.'}
                </p>
              )}

              {/* Status progression — Start Work / Mark Resolved shows based
                  on current status. Submitted stays put until one of these
                  is clicked; Reeyen asked to drop the Assign flow. */}
              {order.status === 'assigned' && (
                <button
                  onClick={() => { handleStartWork(order); setEditingId(null); }}
                  style={{
                    width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600,
                    background: 'rgba(0,101,101,0.08)', color: '#006565', border: 'none',
                    borderRadius: '12px', cursor: 'pointer', minHeight: '44px',
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  {t('startWork', lang)}
                </button>
              )}
              {order.status === 'in_progress' && (
                <button
                  onClick={() => { handleResolve(order); setEditingId(null); }}
                  style={{
                    width: '100%', padding: '12px', fontSize: '14px', fontWeight: 600,
                    background: 'rgba(34,197,94,0.08)', color: '#16a34a', border: 'none',
                    borderRadius: '12px', cursor: 'pointer', minHeight: '44px',
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  {t('markResolved', lang)}
                </button>
              )}

              {/* Save */}
              <button
                onClick={() => handleSaveEdit(order)}
                disabled={!editDesc.trim()}
                style={{
                  width: '100%', padding: '14px', border: 'none',
                  borderRadius: '12px', cursor: editDesc.trim() ? 'pointer' : 'not-allowed',
                  background: editDesc.trim() ? '#364262' : '#eae8e3',
                  color: editDesc.trim() ? '#fff' : '#757684',
                  fontSize: '14px', fontWeight: 700, fontFamily: "'Inter', sans-serif",
                  transition: 'all 150ms', minHeight: '48px',
                }}
              >
                {lang === 'es' ? 'Guardar Cambios' : 'Save Changes'}
              </button>

              {/* Delete — destructive, sits at the bottom of the modal */}
              <button
                onClick={() => handleDeleteOrder(order)}
                style={{
                  width: '100%', padding: '12px', border: '1px solid rgba(186,26,26,0.25)',
                  borderRadius: '12px', cursor: 'pointer',
                  background: 'transparent', color: '#ba1a1a',
                  fontSize: '13px', fontWeight: 500, fontFamily: "'Inter', sans-serif",
                  transition: 'all 150ms', minHeight: '40px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                <Trash2 size={14} />
                {lang === 'es' ? 'Eliminar Orden' : 'Delete Work Order'}
              </button>
            </div>
          </div>
        );
      })()}

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

      {/* Equipment edit modal */}
      {showEquipmentModal && user && activePropertyId && (
        <EquipmentEditModal
          item={editingEquipment}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => { setShowEquipmentModal(false); setEditingEquipment(null); }}
          onSaved={(_msg) => { setShowEquipmentModal(false); setEditingEquipment(null); }}
        />
      )}

      {/* Resolve work order — optional supply deduction */}
      {resolvingOrder && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
          onClick={e => { if (e.target === e.currentTarget && !resolving) { setResolvingOrder(null); setSupplyUsage({}); setShowSupplyList(false); } }}
        >
          <div style={{
            background: '#fbf9f4', borderRadius: '20px',
            width: '100%', maxWidth: '520px', maxHeight: '85vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '17px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                  {lang === 'es' ? 'Completar Orden' : 'Resolve Work Order'}
                </h2>
                <button
                  onClick={() => { setResolvingOrder(null); setSupplyUsage({}); setShowSupplyList(false); }}
                  disabled={resolving}
                  style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: '50%' }}
                >
                  <X size={14} color="#454652" />
                </button>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '4px 0 0' }}>
                {resolvingOrder.roomNumber ? `${resolvingOrder.roomNumber} · ` : ''}{resolvingOrder.description}
              </p>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '18px 22px' }}>
              {!showSupplyList ? (
                <>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', color: '#1b1c19', marginBottom: '6px', fontWeight: 600 }}>
                    {lang === 'es' ? '¿Usaste algún material de mantenimiento?' : 'Did you use any maintenance supplies?'}
                  </div>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: 0 }}>
                    {lang === 'es'
                      ? 'Registrar materiales descuenta del inventario y los anexa a la orden.'
                      : 'Logging supplies deducts from inventory and appends them to the work order.'}
                  </p>
                  {maintenanceSupplies.length === 0 && (
                    <div style={{
                      marginTop: '14px', padding: '10px 12px', borderRadius: '10px',
                      background: 'rgba(0,0,0,0.03)',
                      fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684',
                    }}>
                      {lang === 'es'
                        ? 'Aún no hay materiales registrados.'
                        : 'No maintenance supplies tracked yet.'}
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', marginBottom: '10px', fontWeight: 600 }}>
                    {lang === 'es' ? 'Cantidad usada por artículo:' : 'Quantity used per item:'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {maintenanceSupplies
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(item => (
                        <div key={item.id} style={{
                          display: 'grid', gridTemplateColumns: '1fr 80px',
                          gap: '10px', alignItems: 'center',
                          padding: '8px 10px', borderRadius: '10px',
                          background: '#fff', border: '1px solid rgba(197,197,212,0.3)',
                        }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600, color: '#1b1c19', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {item.name}
                            </div>
                            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684' }}>
                              {lang === 'es' ? 'En stock:' : 'In stock:'} <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{item.currentStock}</span> {item.unit}
                            </div>
                          </div>
                          <input
                            type="number" min="0" max={item.currentStock}
                            value={supplyUsage[item.id] ?? 0}
                            onChange={e => {
                              const v = parseInt(e.target.value) || 0;
                              setSupplyUsage(prev => ({ ...prev, [item.id]: Math.max(0, v) }));
                            }}
                            style={{
                              width: '100%', padding: '8px 10px', borderRadius: '8px',
                              border: '1px solid #c5c5d4', background: '#fff',
                              fontFamily: "'JetBrains Mono', monospace", fontSize: '14px', textAlign: 'center',
                              outline: 'none',
                            }}
                          />
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ padding: '14px 22px', borderTop: '1px solid rgba(197,197,212,0.2)', display: 'flex', gap: '8px' }}>
              {!showSupplyList ? (
                <>
                  <button
                    onClick={() => resolvingOrder && handleResolveJustComplete(resolvingOrder)}
                    disabled={resolving}
                    style={{
                      flex: 1, padding: '12px', borderRadius: '9999px',
                      background: '#fff', border: '1px solid #c5c5d4', color: '#454652',
                      fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
                      cursor: resolving ? 'wait' : 'pointer',
                    }}
                  >
                    {resolving
                      ? (lang === 'es' ? 'Guardando...' : 'Saving...')
                      : (lang === 'es' ? 'No, Solo Completar' : 'No, Just Resolve')}
                  </button>
                  {maintenanceSupplies.length > 0 && (
                    <button
                      onClick={() => setShowSupplyList(true)}
                      disabled={resolving}
                      style={{
                        flex: 1, padding: '12px', borderRadius: '9999px',
                        background: '#364262', border: 'none', color: '#fff',
                        fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
                        cursor: resolving ? 'wait' : 'pointer',
                      }}
                    >
                      {lang === 'es' ? 'Sí, Registrar Materiales' : 'Yes, Log Supplies'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    onClick={() => setShowSupplyList(false)}
                    disabled={resolving}
                    style={{
                      padding: '12px 16px', borderRadius: '9999px',
                      background: '#fff', border: '1px solid #c5c5d4', color: '#454652',
                      fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
                      cursor: resolving ? 'wait' : 'pointer',
                    }}
                  >
                    {lang === 'es' ? 'Atrás' : 'Back'}
                  </button>
                  <button
                    onClick={handleResolveWithSupplies}
                    disabled={resolving}
                    style={{
                      flex: 1, padding: '12px', borderRadius: '9999px',
                      background: '#364262', border: 'none', color: '#fff',
                      fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
                      cursor: resolving ? 'wait' : 'pointer',
                    }}
                  >
                    {resolving
                      ? (lang === 'es' ? 'Guardando...' : 'Saving...')
                      : (lang === 'es' ? 'Confirmar y Completar' : 'Confirm & Resolve')}
                  </button>
                </>
              )}
            </div>
          </div>
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

// ─── Format helper used in AI insight ───────────────────────────────────────
// Thin wrapper around the consolidated formatCurrency in @/lib/utils so the
// AI-insight strings still read as "$1.2k" / "$30" but the implementation
// stays in one place.
import { formatCurrency as formatCurrencyBase } from '@/lib/utils';
function formatShortDollars(n: number): string {
  return formatCurrencyBase(n, true);
}

// ─── Equipment Tab ──────────────────────────────────────────────────────────
function EquipmentTab({
  equipment, workOrders, uid, pid, lang, onEdit, onAdd,
}: {
  equipment: Equipment[];
  workOrders: WorkOrder[];
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onEdit: (e: Equipment) => void;
  onAdd: () => void;
}) {
  // Cold-start alerts for the banner at the top of this tab.
  const alerts = useMemo(
    () => generateColdStartAlerts(equipment, workOrders, []),
    [equipment, workOrders],
  );
  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const warningCount = alerts.filter(a => a.severity === 'warning').length;

  // Group equipment by category for visual organization.
  const grouped = useMemo(() => {
    const m = new Map<EquipmentCategory, Equipment[]>();
    for (const e of equipment) {
      const list = m.get(e.category) ?? [];
      list.push(e);
      m.set(e.category, list);
    }
    return m;
  }, [equipment]);

  // Per-equipment health score (0-100). Lower = worse.
  const healthOf = useCallback((eq: Equipment): number => {
    let score = 100;
    if (eq.installDate && eq.expectedLifetimeYears) {
      const ageYears = (Date.now() - eq.installDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
      const ratio = ageYears / eq.expectedLifetimeYears;
      score -= Math.min(40, ratio * 40); // up to -40 from age
    }
    const recent = workOrders.filter(o =>
      o.equipmentId === eq.id && o.createdAt &&
      Date.now() - o.createdAt.getTime() < 90 * 24 * 60 * 60 * 1000,
    );
    score -= Math.min(40, recent.length * 10); // up to -40 from recurrences
    if (eq.status === 'failed') score -= 30;
    if (eq.status === 'degraded') score -= 15;
    return Math.max(0, Math.round(score));
  }, [workOrders]);

  return (
    <div className="animate-in stagger-1" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Alerts banner */}
      {(criticalCount + warningCount) > 0 && (
        <div style={{
          background: criticalCount > 0 ? 'rgba(186,26,26,0.06)' : 'rgba(201,138,20,0.06)',
          border: criticalCount > 0 ? '1px solid rgba(186,26,26,0.18)' : '1px solid rgba(201,138,20,0.18)',
          borderRadius: '12px', padding: '12px 14px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <AlertTriangle size={16} color={criticalCount > 0 ? '#ba1a1a' : '#c98a14'} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 700, color: '#1b1c19' }}>
              {lang === 'es'
                ? `${criticalCount + warningCount} alerta${criticalCount + warningCount === 1 ? '' : 's'} de equipos`
                : `${criticalCount + warningCount} equipment alert${criticalCount + warningCount === 1 ? '' : 's'}`}
            </div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684' }}>
              {alerts.slice(0, 2).map(a => a.message).join(' · ')}
            </div>
          </div>
        </div>
      )}

      {/* Header + Add button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
          {lang === 'es' ? 'Registro de Equipos' : 'Equipment Registry'}
          <span style={{ marginLeft: '8px', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#757684', fontWeight: 500 }}>
            {equipment.length}
          </span>
        </h2>
        <button
          onClick={onAdd}
          style={{
            background: '#364262', color: '#fff', border: 'none',
            padding: '8px 14px', borderRadius: '9999px',
            fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
          }}
        >
          <Plus size={13} />
          {lang === 'es' ? 'Agregar' : 'Add'}
        </button>
      </div>

      {/* Empty state */}
      {equipment.length === 0 && (
        <div style={{
          padding: '32px 12px', textAlign: 'center', borderRadius: '14px',
          background: 'rgba(0,0,0,0.02)', border: '1px dashed #c5c5d4',
        }}>
          <Settings size={20} color="#757684" style={{ margin: '0 auto 6px' }} />
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
            {lang === 'es' ? 'Sin equipos registrados' : 'No equipment registered yet'}
          </p>
        </div>
      )}

      {/* Per-category lists */}
      {Array.from(grouped.entries())
        .sort(([a], [b]) => EQUIPMENT_CATEGORY_LABEL(a, lang).localeCompare(EQUIPMENT_CATEGORY_LABEL(b, lang)))
        .map(([cat, items]) => (
          <section key={cat} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{
              fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700,
              color: '#454652', textTransform: 'uppercase', letterSpacing: '0.06em',
              padding: '4px 2px',
            }}>
              {EQUIPMENT_CATEGORY_LABEL(cat, lang)} <span style={{ color: '#757684', fontWeight: 500 }}>· {items.length}</span>
            </div>
            {items.sort((a, b) => a.name.localeCompare(b.name)).map(eq => {
              const status = EQUIPMENT_STATUS_STYLE[eq.status];
              const ageYears = eq.installDate
                ? ((Date.now() - eq.installDate.getTime()) / (1000 * 60 * 60 * 24 * 365)).toFixed(1)
                : null;
              const health = healthOf(eq);
              const healthColor = health >= 70 ? '#006565' : health >= 40 ? '#c98a14' : '#ba1a1a';
              return (
                <div
                  key={eq.id}
                  onClick={() => onEdit(eq)}
                  style={{
                    background: '#fff', borderRadius: '12px', padding: '10px 12px',
                    border: '1px solid rgba(78,90,122,0.06)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '12px',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                      <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600, color: '#1b1c19' }}>
                        {eq.name}
                      </span>
                      {eq.location && (
                        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684' }}>
                          {eq.location}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                      <span style={{
                        fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600,
                        background: status.bg, color: status.color,
                        padding: '2px 7px', borderRadius: '6px',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        {lang === 'es' ? status.labelEs : status.labelEn}
                      </span>
                      {ageYears != null && (
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: '#757684' }}>
                          {ageYears}y
                        </span>
                      )}
                      {eq.replacementCost != null && (
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: '#757684' }}>
                          {formatShortDollars(eq.replacementCost)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Health bar */}
                  <div style={{ width: '60px', textAlign: 'right' }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: 700, color: healthColor }}>
                      {health}%
                    </div>
                    <div style={{ width: '60px', height: '3px', background: '#f0eee9', borderRadius: '9999px', marginTop: '2px', overflow: 'hidden' }}>
                      <div style={{ width: `${health}%`, height: '100%', background: healthColor }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      {/* uid/pid passed for future inline actions (not yet wired to UI) */}
    </div>
  );
}

// ─── Equipment Edit Modal ───────────────────────────────────────────────────
function EquipmentEditModal({
  item, uid, pid, lang, onClose, onSaved,
}: {
  item: Equipment | null;     // null = creating
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState<EquipmentCategory>(item?.category ?? 'hvac');
  const [location, setLocation] = useState(item?.location ?? '');
  const [manufacturer, setManufacturer] = useState(item?.manufacturer ?? '');
  const [modelNumber, setModelNumber] = useState(item?.modelNumber ?? '');
  const [installDate, setInstallDate] = useState(
    item?.installDate ? item.installDate.toISOString().slice(0, 10) : '',
  );
  const [expectedLifetime, setExpectedLifetime] = useState(item?.expectedLifetimeYears != null ? String(item.expectedLifetimeYears) : '');
  const [purchaseCost, setPurchaseCost] = useState(item?.purchaseCost != null ? String(item.purchaseCost) : '');
  const [replacementCost, setReplacementCost] = useState(item?.replacementCost != null ? String(item.replacementCost) : '');
  const [pmInterval, setPmInterval] = useState(item?.pmIntervalDays != null ? String(item.pmIntervalDays) : '');
  const [status, setStatus] = useState<EquipmentStatus>(item?.status ?? 'operational');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const patch: Partial<Equipment> = {
        name: name.trim(), category, status,
        location: location.trim() || undefined,
        manufacturer: manufacturer.trim() || undefined,
        modelNumber: modelNumber.trim() || undefined,
        installDate: installDate ? new Date(installDate) : null,
        expectedLifetimeYears: expectedLifetime ? parseFloat(expectedLifetime) : undefined,
        purchaseCost: purchaseCost ? parseFloat(purchaseCost) : undefined,
        replacementCost: replacementCost ? parseFloat(replacementCost) : undefined,
        pmIntervalDays: pmInterval ? parseInt(pmInterval) : undefined,
        notes: notes.trim() || undefined,
      };
      if (item) {
        await updateEquipment(uid, pid, item.id, patch);
        onSaved(lang === 'es' ? 'Equipo actualizado ✓' : 'Equipment updated ✓');
      } else {
        await addEquipment(uid, pid, { ...patch, propertyId: pid } as Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>);
        onSaved(lang === 'es' ? 'Equipo agregado ✓' : 'Equipment added ✓');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!confirm(lang === 'es' ? `¿Eliminar "${item.name}"?` : `Delete "${item.name}"?`)) return;
    setSaving(true);
    try {
      await deleteEquipment(uid, pid, item.id);
      onSaved(lang === 'es' ? 'Equipo eliminado ✓' : 'Equipment deleted ✓');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: '12px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#1b1c19',
    outline: 'none',
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '20px', width: '100%', maxWidth: '520px',
        maxHeight: '90vh', overflowY: 'auto', padding: '20px 22px',
        display: 'flex', flexDirection: 'column', gap: '12px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '17px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
            {item
              ? (lang === 'es' ? 'Editar Equipo' : 'Edit Equipment')
              : (lang === 'es' ? 'Agregar Equipo' : 'Add Equipment')}
          </h2>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: '50%' }}>
            <X size={14} color="#454652" />
          </button>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
            {lang === 'es' ? 'Nombre *' : 'Name *'}
          </label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Categoría' : 'Category'}
            </label>
            <select value={category} onChange={e => setCategory(e.target.value as EquipmentCategory)} style={inputStyle}>
              {(['hvac','plumbing','electrical','appliance','structural','elevator','pool','laundry','kitchen','other'] as EquipmentCategory[]).map(c => (
                <option key={c} value={c}>{EQUIPMENT_CATEGORY_LABEL(c, lang)}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Estado' : 'Status'}
            </label>
            <select value={status} onChange={e => setStatus(e.target.value as EquipmentStatus)} style={inputStyle}>
              {(['operational','degraded','failed','replaced','decommissioned'] as EquipmentStatus[]).map(s => (
                <option key={s} value={s}>{lang === 'es' ? EQUIPMENT_STATUS_STYLE[s].labelEs : EQUIPMENT_STATUS_STYLE[s].labelEn}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
            {lang === 'es' ? 'Ubicación' : 'Location'}
          </label>
          <input value={location} onChange={e => setLocation(e.target.value)} placeholder={lang === 'es' ? 'p.ej. Sala 204, Lavandería' : 'e.g. Room 204, Laundry Room'} style={inputStyle} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Fabricante' : 'Manufacturer'}
            </label>
            <input value={manufacturer} onChange={e => setManufacturer(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? '# Modelo' : 'Model #'}
            </label>
            <input value={modelNumber} onChange={e => setModelNumber(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Instalado' : 'Installed'}
            </label>
            <input type="date" value={installDate} onChange={e => setInstallDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Vida (años)' : 'Life (yrs)'}
            </label>
            <input type="number" step="0.5" min="0" value={expectedLifetime} onChange={e => setExpectedLifetime(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'PM (días)' : 'PM (days)'}
            </label>
            <input type="number" min="0" value={pmInterval} onChange={e => setPmInterval(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Costo de Compra' : 'Purchase Cost'}
            </label>
            <input type="number" step="0.01" min="0" value={purchaseCost} onChange={e => setPurchaseCost(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
              {lang === 'es' ? 'Costo de Reemplazo' : 'Replacement Cost'}
            </label>
            <input type="number" step="0.01" min="0" value={replacementCost} onChange={e => setReplacementCost(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '4px' }}>
            {lang === 'es' ? 'Notas' : 'Notes'}
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder={lang === 'es' ? 'Detalles, ubicación física, manual de servicio…' : 'Details, physical location, service manual…'}
            style={{ ...inputStyle, resize: 'vertical', minHeight: '60px', fontFamily: "'Inter', sans-serif" }}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          {item && (
            <button
              onClick={handleDelete}
              disabled={saving}
              style={{
                padding: '12px 16px', borderRadius: '9999px',
                background: '#fff', border: '1px solid #ffdad6', color: '#ba1a1a',
                fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              <Trash2 size={13} style={{ marginRight: '4px', verticalAlign: '-2px' }} />
              {lang === 'es' ? 'Eliminar' : 'Delete'}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            style={{
              flex: 1, padding: '12px', borderRadius: '9999px',
              background: name.trim() ? '#364262' : '#eae8e3',
              color: name.trim() ? '#fff' : '#757684',
              border: 'none', cursor: name.trim() && !saving ? 'pointer' : 'not-allowed',
              fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
            }}
          >
            {saving
              ? (lang === 'es' ? 'Guardando...' : 'Saving...')
              : (lang === 'es' ? 'Guardar' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Preventive Intelligence panel ──────────────────────────────────────────
//
// Sits above the existing InspectionsView in the Preventive tab. Two
// features:
//
//   1. Auto-Generate from Equipment — scan all equipment with pm_interval_days
//      set, find any without a corresponding preventive_tasks row (matched by
//      equipment_id), and offer to create them. One-shot batch insert.
//
//   2. AI-Recommended Interval card per existing PM task linked to equipment.
//      Computes mean days-between-failures from the work-order history of
//      the linked equipment (only fires when ≥3 failures so the average
//      isn't noise) and recommends 0.7× that interval — the heuristic is
//      "schedule PM at 70% of mean time between failures so you stay ahead
//      of the next break". Shown as: "Your interval: 90d · AI suggests: 60d
//      (based on 4 failures)".

const DAY_MS_LOCAL = 1000 * 60 * 60 * 24;

interface RecommendedInterval {
  taskId: string;
  taskName: string;
  yourInterval: number;
  aiSuggested: number;
  failureCount: number;
}

function computeRecommendedIntervals(
  preventiveTasks: PreventiveTask[],
  workOrders: WorkOrder[],
): RecommendedInterval[] {
  const out: RecommendedInterval[] = [];
  for (const task of preventiveTasks) {
    if (!task.equipmentId) continue;
    const orders = workOrders
      .filter(o => o.equipmentId === task.equipmentId && o.createdAt)
      .sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
    if (orders.length < 3) continue; // need ≥3 failures for a stable mean
    const intervals: number[] = [];
    for (let i = 1; i < orders.length; i++) {
      intervals.push((orders[i].createdAt!.getTime() - orders[i - 1].createdAt!.getTime()) / DAY_MS_LOCAL);
    }
    const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const aiSuggested = Math.max(1, Math.round(mean * 0.7));
    if (aiSuggested === task.frequencyDays) continue; // no recommendation if it matches
    out.push({
      taskId: task.id,
      taskName: task.name,
      yourInterval: task.frequencyDays,
      aiSuggested,
      failureCount: orders.length,
    });
  }
  return out;
}

function PreventiveIntelligence({
  equipment, preventiveTasks, workOrders, uid, pid, lang, onToast,
}: {
  equipment: Equipment[];
  preventiveTasks: PreventiveTask[];
  workOrders: WorkOrder[];
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onToast: (msg: string) => void;
}) {
  const [autoGenOpen, setAutoGenOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Equipment that has pm_interval_days set but no linked preventive task.
  const candidates = useMemo(() => {
    const linkedEquipmentIds = new Set(preventiveTasks.map(t => t.equipmentId).filter(Boolean));
    return equipment.filter(eq =>
      eq.pmIntervalDays != null && eq.pmIntervalDays > 0 && !linkedEquipmentIds.has(eq.id),
    );
  }, [equipment, preventiveTasks]);

  const recommendations = useMemo(
    () => computeRecommendedIntervals(preventiveTasks, workOrders),
    [preventiveTasks, workOrders],
  );

  const handleCreateAll = async () => {
    setCreating(true);
    try {
      for (const eq of candidates) {
        if (!eq.pmIntervalDays) continue;
        await addPreventiveTask(uid, pid, {
          propertyId: pid,
          name: lang === 'es' ? `${eq.name} — Mantenimiento Preventivo` : `${eq.name} PM`,
          frequencyDays: eq.pmIntervalDays,
          equipmentId: eq.id,
          lastCompletedAt: null,
        });
      }
      onToast(lang === 'es'
        ? `${candidates.length} tarea${candidates.length === 1 ? '' : 's'} de MP creada${candidates.length === 1 ? '' : 's'} ✓`
        : `${candidates.length} PM task${candidates.length === 1 ? '' : 's'} created ✓`);
      setAutoGenOpen(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Auto-Generate banner */}
      <div style={{
        background: '#fff', borderRadius: '12px', padding: '12px 14px',
        border: '1px solid rgba(78,90,122,0.06)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '10px', flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 700, color: '#1b1c19' }}>
            {lang === 'es' ? 'Generar tareas desde equipos' : 'Auto-generate from equipment'}
          </div>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '2px' }}>
            {candidates.length === 0
              ? (lang === 'es' ? 'Todos los equipos con intervalo de MP ya tienen tarea.' : 'All equipment with a PM interval already has a task.')
              : (lang === 'es'
                ? `${candidates.length} equipo${candidates.length === 1 ? '' : 's'} sin tarea de MP enlazada.`
                : `${candidates.length} equipment item${candidates.length === 1 ? '' : 's'} without a linked PM task.`)}
          </div>
        </div>
        <button
          onClick={() => candidates.length > 0
            ? setAutoGenOpen(true)
            : onToast(lang === 'es' ? '¡Todos los equipos tienen tareas de MP!' : 'All equipment has PM tasks!')}
          style={{
            padding: '8px 14px', borderRadius: '9999px', border: 'none',
            background: candidates.length > 0 ? '#364262' : '#f0eee9',
            color: candidates.length > 0 ? '#fff' : '#757684',
            fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px',
          }}
        >
          <Settings size={13} />
          {lang === 'es' ? 'Auto-Generar' : 'Auto-Generate'}
        </button>
      </div>

      {/* AI-Recommended Intervals */}
      {recommendations.length > 0 && (
        <div style={{
          background: 'rgba(0,101,101,0.04)', borderRadius: '12px', padding: '12px 14px',
          border: '1px solid rgba(0,101,101,0.12)',
        }}>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 700, color: '#006565', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
            {lang === 'es' ? 'Intervalos sugeridos por IA' : 'AI-Recommended Intervals'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {recommendations.map(r => (
              <div key={r.taskId} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 10px', borderRadius: '10px', background: '#fff',
                gap: '10px', flexWrap: 'wrap',
              }}>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600, color: '#1b1c19', flex: 1, minWidth: 0 }}>
                  {r.taskName}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#757684', whiteSpace: 'nowrap' }}>
                  {lang === 'es' ? 'Tu intervalo:' : 'Your interval:'} <strong style={{ color: '#454652' }}>{r.yourInterval}d</strong>
                  {' · '}
                  <span style={{ color: '#006565' }}>{lang === 'es' ? 'IA sugiere:' : 'AI suggests:'} <strong>{r.aiSuggested}d</strong></span>
                  {' · '}
                  <span style={{ fontSize: '10px' }}>
                    {lang === 'es'
                      ? `basado en ${r.failureCount} fallas`
                      : `based on ${r.failureCount} failures`}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Auto-generate confirmation modal */}
      {autoGenOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
          onClick={e => { if (e.target === e.currentTarget && !creating) setAutoGenOpen(false); }}
        >
          <div style={{
            background: '#fbf9f4', borderRadius: '20px',
            width: '100%', maxWidth: '480px', maxHeight: '85vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '17px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? `Crear ${candidates.length} Tareas de MP` : `Create ${candidates.length} PM Task${candidates.length === 1 ? '' : 's'}`}
              </h2>
              <button onClick={() => setAutoGenOpen(false)} disabled={creating} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: '50%' }}>
                <X size={14} color="#454652" />
              </button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 22px' }}>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '0 0 12px' }}>
                {lang === 'es'
                  ? 'Se creará una tarea de mantenimiento preventivo para cada equipo:'
                  : 'A preventive maintenance task will be created for each:'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {candidates.map(eq => (
                  <div key={eq.id} style={{
                    padding: '8px 10px', borderRadius: '10px',
                    background: '#fff', border: '1px solid rgba(197,197,212,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600, color: '#1b1c19' }}>{eq.name}</div>
                      {eq.location && (
                        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684' }}>{eq.location}</div>
                      )}
                    </div>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#454652', whiteSpace: 'nowrap' }}>
                      {lang === 'es' ? `cada ${eq.pmIntervalDays}d` : `every ${eq.pmIntervalDays}d`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid rgba(197,197,212,0.2)', display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setAutoGenOpen(false)}
                disabled={creating}
                style={{
                  padding: '12px 16px', borderRadius: '9999px',
                  background: '#fff', border: '1px solid #c5c5d4', color: '#454652',
                  fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
                  cursor: creating ? 'wait' : 'pointer',
                }}
              >
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={handleCreateAll}
                disabled={creating}
                style={{
                  flex: 1, padding: '12px', borderRadius: '9999px',
                  background: '#364262', border: 'none', color: '#fff',
                  fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
                  cursor: creating ? 'wait' : 'pointer',
                }}
              >
                {creating
                  ? (lang === 'es' ? 'Creando...' : 'Creating...')
                  : (lang === 'es' ? 'Crear Tareas' : 'Create Tasks')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
