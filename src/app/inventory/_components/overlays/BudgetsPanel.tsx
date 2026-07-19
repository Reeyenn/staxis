'use client';

// Budgets — set the hotel's monthly inventory usage caps, and compare them
// with completed month-close actuals.
//
// Two ways to budget (properties.inventory_budget_mode, migration 0306):
//   • One total budget — a single whole-inventory number per month.
//   • By section — the three app categories PLUS custom hotel sections
//     ("Pool supplies"), each mapped to specific items so spend tracks.
//
// Numbers are always per-month; "Copy to the whole year" fills a year. A year
// switcher covers planning next year in the fall. An empty box = no cap.
//
// Only completed, full-month usage can produce a budget status. Purchases and
// current shelf value remain visible inputs but never count as the actual.
//
// Values are held as strings so an empty field stays empty (not "0") and typing
// never leaves a stray leading zero.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  upsertInventoryBudget,
  upsertInventoryBudgetSection,
  deleteInventoryBudgetSection,
  sectionBudgetKey,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  inventoryBudgetComparisonCap,
  inventoryBudgetBand,
  inventoryPurchaseEvidence,
  resolveInventoryBudgetActual,
  type InventoryBudgetActualPeriod,
  type InventoryBudgetActualState,
} from '@/lib/inventory-budget-actual';
import {
  inventoryCalendarDateInZone,
  shiftInventoryMonthKey,
} from '@/lib/inventory-month-close';
import { propertyTimezoneOrUTC } from '@/lib/property-timezone';
import type { InventoryBudget, InventoryBudgetMode, InventoryBudgetSection } from '@/types';

import { T, fonts, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { numGuard } from './form-kit';
import { fmtMoney } from '../format';
import type { DisplayItem } from '../types';
import { catLabelFor, monthsFor, type Lang } from '../inv-i18n';

interface BudgetsPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  budgets: InventoryBudget[];
  sections: InventoryBudgetSection[];
  mode: InventoryBudgetMode;
  /** Property IANA timezone; planning follows the hotel's calendar. */
  timezone?: string | null;
  /** Full catalog — the custom-section item picker. */
  display: DisplayItem[];
  /** Closed usage actuals plus the current open period, in dollars. */
  actualPeriods: InventoryBudgetActualPeriod[];
  /**
   * Fired after any persisted change so the parent refetches. `mode` is set
   * ONLY when Save wrote it to the property — section add/remove must not
   * report the panel's unsaved mode toggle (the meters would flip modes
   * without the property ever changing).
   */
  onChanged: (mode?: InventoryBudgetMode) => void;
}

const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

// Constant height for the budget-rows panel so the modal never changes size
// between modes. Sized to show the three categories + "Add a section".
const ROWS_PANEL_H = 300;
// Constant max-height for the history strip so the modal height doesn't depend
// on how many months have data.
const HISTORY_PANEL_H = 210;

function bpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Budgets',
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save budgets',
      chooseMethodTitle: 'Choose how to budget',
      chooseMethodSub: 'Use one monthly limit for all inventory, or set separate limits by category and custom section.',
      totalTitle: 'One total budget',
      totalSub: 'A single number for the whole inventory.',
      totalCovers: 'This one budget covers every category — housekeeping, maintenance, food & beverage, and any custom sections.',
      sectionsTitle: 'By category or section',
      sectionsSub: 'Housekeeping, maintenance, food & beverage — plus your own sections.',
      setLimitsTitle: 'Set monthly budget limits',
      setLimitsSub: 'Choose a month and year, then enter the maximum inventory cost the hotel plans to use. Leave an amount blank for no limit.',
      month: 'Month',
      year: 'Year',
      wholeInventory: 'Whole inventory',
      forMonth: (m: string, y: number) => `for ${m} ${y}`,
      budgetLimitLabel: (name: string, m: string, y: number) => `${name} budget limit for ${m} ${y}`,
      addSection: '＋ Add a section',
      sectionNamePh: 'Section name (e.g. Pool supplies)',
      whichItems: 'Which items count toward it',
      searchItems: 'Search items…',
      nothingMatches: 'Nothing matches.',
      pickerEmpty: 'No inventory items yet.',
      createSection: 'Create section',
      saveSection: 'Save section',
      sectionMoveHint: 'An item can belong to one budget section. Selecting it here moves it from another custom section.',
      items: (n: number) => `${n} item${n === 1 ? '' : 's'}`,
      noItemsYet: 'no items yet',
      edit: 'Edit',
      remove: 'Remove',
      confirmRemove: 'Remove?',
      sectionFailed: 'Saving the section failed. Please try again.',
      saveFailed: 'Saving the budgets failed. Please try again.',
      noCapHint: 'Leave an amount blank for no budget limit.',
      copyMonthToYear: (m: string, y: number) => `Copy ${m} to every month in ${y}`,
      // Actual usage
      usedOf: (used: string, cap: string) => `${used} used of ${cap}`,
      left: (v: string) => `${v} left`,
      over: (v: string) => `${v} over`,
      noBudget: (used: string) => `${used} used · no budget set`,
      thisMonthActual: 'Actual inventory used',
      actualPending: 'Budget check pending until month close.',
      partialActual: 'This first tracking period is partial, so it is not compared with a full-month budget.',
      unallocatedActual: 'Only the whole-inventory actual is available because purchases were entered as one monthly total.',
      comparisonUnavailable: 'Budget comparison unavailable — this older close did not save a budget snapshot.',
      actualComparisonUnavailable: (v: string) => `${v} used · budget comparison unavailable`,
      purchasesLogged: (v: string) => `${v} in purchases logged`,
      purchasesConfirmed: (v: string) => `${v} in purchases confirmed at close`,
      purchasesIncomplete: (v: string) => `At least ${v} in purchases logged · some delivery costs are missing`,
      trackingNotStarted: 'Start monthly tracking to calculate actual usage.',
      totalBudget: 'Total budget',
      summaryOf: (cap: string) => `of ${cap}`,
      noBudgetsYet: 'No budgets set for this month. Add limits above to compare with closed usage.',
      overBanner: (names: string) => `Over budget based on closed usage: ${names}.`,
      nearBanner: (names: string) => `Close to budget based on closed usage: ${names}.`,
      planningNote: (m: string, y: number) => `Planning ${m} ${y} — actual usage appears after that month closes.`,
      reviewCurrentTitle: 'Review this month',
      reviewSelectedTitle: 'Review the selected month',
      reviewCurrentSub: 'Budget status uses inventory actually consumed, never purchases or shelf value.',
      reviewSelectedSub: 'Closed months compare actual usage with the budget limit you selected.',
      // History timeline
      compareMonthsTitle: 'Compare recent months',
      compareMonthsSub: 'Compare budget with closed inventory usage for each of the last six months.',
      thisMonthTag: 'NOW',
      monthNoData: 'no activity',
      noBudgetShort: (v: string) => `${v} used · no budget`,
      pendingShort: 'usage pending',
      partialShort: 'partial period',
      historyEmpty: 'Your month-by-month budget vs actual appears here after the first full month closes.',
      legacyPurchaseCapsNotice: 'Older purchase budgets are kept for reference and are not compared with inventory usage.',
      archivedSection: 'Archived section',
    },
    es: {
      eyebrow: 'Presupuestos',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      save: 'Guardar presupuestos',
      chooseMethodTitle: 'Elige cómo presupuestar',
      chooseMethodSub: 'Usa un límite mensual para todo el inventario o fija límites separados por categoría y sección personalizada.',
      totalTitle: 'Un presupuesto total',
      totalSub: 'Un solo número para todo el inventario.',
      totalCovers: 'Este presupuesto cubre todas las categorías: limpieza, mantenimiento, alimentos y bebidas, además de cualquier sección personalizada.',
      sectionsTitle: 'Por categoría o sección',
      sectionsSub: 'Limpieza, mantenimiento, alimentos y bebidas — más tus propias secciones.',
      setLimitsTitle: 'Establece límites mensuales',
      setLimitsSub: 'Elige un mes y un año, luego ingresa el costo máximo de inventario que el hotel planea usar. Deja el monto en blanco si no deseas fijar un límite.',
      month: 'Mes',
      year: 'Año',
      wholeInventory: 'Todo el inventario',
      forMonth: (m: string, y: number) => `para ${m} ${y}`,
      budgetLimitLabel: (name: string, m: string, y: number) => `Límite de presupuesto de ${name} para ${m} de ${y}`,
      addSection: '＋ Agregar sección',
      sectionNamePh: 'Nombre de la sección (ej. Artículos de piscina)',
      whichItems: 'Qué artículos cuentan para ella',
      searchItems: 'Buscar artículos…',
      nothingMatches: 'Nada coincide.',
      pickerEmpty: 'Aún no hay artículos de inventario.',
      createSection: 'Crear sección',
      saveSection: 'Guardar sección',
      sectionMoveHint: 'Un artículo solo puede pertenecer a una sección de presupuesto. Seleccionarlo aquí lo mueve de otra sección personalizada.',
      items: (n: number) => `${n} artículo${n === 1 ? '' : 's'}`,
      noItemsYet: 'sin artículos',
      edit: 'Editar',
      remove: 'Quitar',
      confirmRemove: '¿Quitar?',
      sectionFailed: 'No se pudo guardar la sección. Inténtalo de nuevo.',
      saveFailed: 'No se pudieron guardar los presupuestos. Inténtalo de nuevo.',
      noCapHint: 'Deja un monto en blanco si no deseas fijar un límite.',
      copyMonthToYear: (m: string, y: number) => `Copiar ${m} a todos los meses de ${y}`,
      // Uso real
      usedOf: (used: string, cap: string) => `${used} usado de ${cap}`,
      left: (v: string) => `${v} disponible`,
      over: (v: string) => `${v} sobre`,
      noBudget: (used: string) => `${used} usado · sin presupuesto`,
      thisMonthActual: 'Inventario realmente usado',
      actualPending: 'La revisión del presupuesto queda pendiente hasta el cierre mensual.',
      partialActual: 'Este primer período es parcial y no se compara con un presupuesto mensual completo.',
      unallocatedActual: 'Solo está disponible el total porque las compras se ingresaron como un monto mensual único.',
      comparisonUnavailable: 'La comparación no está disponible porque este cierre anterior no guardó una copia del presupuesto.',
      actualComparisonUnavailable: (v: string) => `${v} usado · comparación no disponible`,
      purchasesLogged: (v: string) => `${v} en compras registradas`,
      purchasesConfirmed: (v: string) => `${v} en compras confirmadas al cierre`,
      purchasesIncomplete: (v: string) => `Al menos ${v} en compras registradas · faltan costos de algunas entregas`,
      trackingNotStarted: 'Inicia el seguimiento mensual para calcular el uso real.',
      totalBudget: 'Presupuesto total',
      summaryOf: (cap: string) => `de ${cap}`,
      noBudgetsYet: 'Sin presupuestos este mes. Agrega límites arriba para compararlos con el uso cerrado.',
      overBanner: (names: string) => `Sobre presupuesto según el uso cerrado: ${names}.`,
      nearBanner: (names: string) => `Cerca del límite según el uso cerrado: ${names}.`,
      planningNote: (m: string, y: number) => `Planeando ${m} ${y} — el uso real aparece después del cierre.`,
      reviewCurrentTitle: 'Revisa este mes',
      reviewSelectedTitle: 'Revisa el mes seleccionado',
      reviewCurrentSub: 'El estado usa inventario realmente consumido, nunca compras ni valor en estante.',
      reviewSelectedSub: 'Los meses cerrados comparan el uso real con el límite seleccionado.',
      // History timeline
      compareMonthsTitle: 'Compara los meses recientes',
      compareMonthsSub: 'Compara el presupuesto con el uso de inventario cerrado en los últimos seis meses.',
      thisMonthTag: 'AHORA',
      monthNoData: 'sin actividad',
      noBudgetShort: (v: string) => `${v} usado · sin presupuesto`,
      pendingShort: 'uso pendiente',
      partialShort: 'período parcial',
      historyEmpty: 'Tu presupuesto vs uso real aparece aquí después del primer cierre mensual completo.',
      legacyPurchaseCapsNotice: 'Los presupuestos anteriores de compras se conservan como referencia y no se comparan con el uso de inventario.',
      archivedSection: 'Sección archivada',
    },
  }[lang];
}

const valKey = (budgetKey: string, year: number) => `${budgetKey}|${year}`;
const EMPTY12 = (): string[] => Array(12).fill('');
const numOf = (s: string): number => Number(s) || 0;

type SpendStatus = 'ok' | 'near' | 'over' | 'nocap';
function spendColor(s: SpendStatus): string {
  return s === 'over' ? T.warm : s === 'near' ? T.caramel : s === 'ok' ? T.forestText : T.ink3;
}

function calendarMonthInZone(now: Date, timezone?: string | null): { year: number; month: number } {
  const calendar = inventoryCalendarDateInZone(now, propertyTimezoneOrUTC(timezone));
  return { year: calendar.year, month: calendar.month - 1 };
}

export function BudgetsPanel({ lang, open, onClose, budgets, sections, mode: savedMode, timezone, display, actualPeriods, onChanged }: BudgetsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const bp = bpStrings(lang);
  const MONTHS = monthsFor(lang);
  // LOCAL now drives the planning picker. Month-close availability itself is
  // returned by the API in the property's timezone.
  const now = useMemo(() => new Date(), []);
  const propertyCalendar = useMemo(() => calendarMonthInZone(now, timezone), [now, timezone]);
  const curMonth = propertyCalendar.month;
  const curYear = propertyCalendar.year;
  const thisYear = curYear;
  const YEARS = [thisYear, thisYear + 1];
  const usageBudgets = useMemo(
    () => budgets.filter((budget) => budget.basis === 'usage'),
    [budgets],
  );
  const hasLegacyPurchaseCaps = useMemo(
    () => budgets.some((budget) => budget.basis === 'purchases' && budget.budgetCents > 0),
    [budgets],
  );

  const [mode, setMode] = useState<InventoryBudgetMode>(savedMode);
  const [year, setYear] = useState<number>(thisYear);
  const [month, setMonth] = useState<number>(curMonth);
  // Raw string values per (budget key, year): key `<budgetKey>|<year>` → 12 months.
  const [vals, setVals] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [localSections, setLocalSections] = useState<InventoryBudgetSection[]>(sections);
  const [formOpen, setFormOpen] = useState(false);
  const [formId, setFormId] = useState<string | null>(null); // null = creating
  const [formName, setFormName] = useState('');
  const [formItems, setFormItems] = useState<Set<string>>(() => new Set());
  const [formQuery, setFormQuery] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const isCurrentMonth = year === curYear && month === curMonth;

  // Hydration. closed→open: full reset. Mid-edit `budgets` refresh: merge only
  // if the GM has no unsaved edits, so typed money is never wiped.
  const wasOpenRef = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const firstOpen = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (!firstOpen && dirtyRef.current.size > 0) return;

    const next: Record<string, string[]> = {};
    for (const b of usageBudgets) {
      if (!b.monthStart) continue;
      const y = b.monthStart.getUTCFullYear();
      if (!YEARS.includes(y)) continue;
      const k = valKey(b.category, y);
      if (!next[k]) next[k] = EMPTY12();
      // 0 cents = no cap → keep the box empty; only real amounts show a number.
      next[k][b.monthStart.getUTCMonth()] = b.budgetCents > 0 ? String(b.budgetCents / 100) : '';
    }
    setVals(next);
    setDirty(new Set());
    if (firstOpen) {
      setMode(savedMode);
      setYear(thisYear);
      setMonth(curMonth);
      setFormOpen(false);
      setConfirmingRemove(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- YEARS/thisYear/curMonth derived; savedMode read on open
  }, [open, usageBudgets]);

  useEffect(() => {
    setLocalSections(sections);
  }, [sections]);

  const arrFor = (budgetKey: string): string[] => vals[valKey(budgetKey, year)] ?? EMPTY12();
  const capOf = (budgetKey: string): number => numOf(arrFor(budgetKey)[month]);

  const setVal = (budgetKey: string, raw: string) => {
    const k = valKey(budgetKey, year);
    setVals((p) => {
      const arr = [...(p[k] ?? EMPTY12())];
      arr[month] = raw;
      return { ...p, [k]: arr };
    });
    setDirty((p) => new Set(p).add(k));
  };

  const activeKeys = useMemo(
    () => (mode === 'total' ? ['total'] : [...CATS, ...localSections.map((s) => sectionBudgetKey(s.id))]),
    [mode, localSections],
  );

  const periodByMonth = useMemo(() => {
    const map = new Map<string, InventoryBudgetActualPeriod>();
    for (const period of actualPeriods) map.set(period.monthStart.slice(0, 7), period);
    return map;
  }, [actualPeriods]);
  const selectedMonthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const selectedPeriod = periodByMonth.get(selectedMonthKey) ?? null;
  const actualFor = (budgetKey: string) => resolveInventoryBudgetActual(selectedPeriod, budgetKey);
  const statusFor = inventoryBudgetBand;
  const selectedHasBudgetSnapshot = selectedPeriod?.status === 'closed'
    && selectedPeriod.usageBudgetMode != null;
  const selectedComparisonUnavailable = selectedPeriod?.status === 'closed'
    && !selectedHasBudgetSnapshot;
  const comparisonCapOf = (budgetKey: string): number | null =>
    inventoryBudgetComparisonCap(selectedPeriod, budgetKey, capOf(budgetKey));

  const copyToYear = () => {
    setVals((p) => {
      const nextVals = { ...p };
      for (const key of activeKeys) {
        const k = valKey(key, year);
        const v = (p[k] ?? EMPTY12())[month];
        nextVals[k] = Array(12).fill(v);
      }
      return nextVals;
    });
    setDirty((p) => {
      const nextD = new Set(p);
      for (const key of activeKeys) nextD.add(valKey(key, year));
      return nextD;
    });
  };

  const monthBudgetTotal = useMemo(
    () => activeKeys.reduce((s, key) => s + capOf(key), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capOf reads vals/year/month
    [activeKeys, vals, year, month],
  );
  const comparisonMonthBudgetTotal = inventoryBudgetComparisonCap(
    selectedPeriod,
    'total',
    monthBudgetTotal,
  );
  const totalActual = actualFor('total');
  const monthActualTotal = totalActual.value;
  const selectedPurchaseEvidence = inventoryPurchaseEvidence(selectedPeriod);
  const selectedPurchaseCopy = selectedPurchaseEvidence == null
    ? null
    : selectedPurchaseEvidence.state === 'confirmed'
      ? bp.purchasesConfirmed(fmtMoney(selectedPurchaseEvidence.value))
      : selectedPurchaseEvidence.state === 'incomplete'
        ? bp.purchasesIncomplete(fmtMoney(selectedPurchaseEvidence.value))
        : bp.purchasesLogged(fmtMoney(selectedPurchaseEvidence.value));

  // GM alerts only use completed full-month actuals. Open/partial months and
  // total-only purchase imports cannot produce an over-budget warning.
  const alerts = useMemo(() => {
    const over: string[] = [];
    const near: string[] = [];
    const comparisonKeys = selectedPeriod?.status === 'closed'
      ? selectedHasBudgetSnapshot
        ? selectedPeriod.usageBudgetMode === 'total'
        ? ['total']
          : Object.keys(selectedPeriod.usageBudgetByKey ?? {}).filter((key) => key !== 'total')
        : []
      : activeKeys;
    for (const key of comparisonKeys) {
      const cap = comparisonCapOf(key);
      if (cap == null || cap <= 0) continue;
      const resolved = resolveInventoryBudgetActual(selectedPeriod, key);
      if (resolved.state !== 'complete' || resolved.value == null) continue;
      const st = statusFor(cap, resolved.value);
      const label = key === 'total' ? bp.wholeInventory
        : key.startsWith('section:') ? (localSections.find((s) => sectionBudgetKey(s.id) === key)?.name ?? bp.archivedSection)
        : catLabelFor(lang, key as InvCat);
      if (st === 'over') over.push(label);
      else if (st === 'near') near.push(label);
    }
    return { over, near };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads vals via capOf
  }, [activeKeys, vals, year, month, selectedPeriod, localSections, lang, selectedHasBudgetSnapshot]);

  // ── Budget-vs-actual timeline (last 6 months) ─────────────────────────
  // Read-only, backward-looking. For each of the last 6 calendar months:
  //   • closed month = the usage caps frozen on that close, independent of
  //     later edits to mode, sections, or live budget rows.
  //   • open month = current usage caps (including unsaved edits for NOW).
  //   • actual = completed full-month usage. Open and partial periods stay
  //              visibly pending and never receive a red/green budget state.
  const timeline = useMemo(() => {
    const activeSet = new Set(activeKeys);
    // Only the year/month fields matter here. Seeding from the property month
    // keeps labels correct when the manager is viewing from another timezone.
    const baseMonthKey = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
    const out: Array<{
      y: number; m: number; label: string; budget: number | null; actual: number | null;
      actualState: InventoryBudgetActualState; status: SpendStatus | null;
      isCurrent: boolean; hasAny: boolean;
    }> = [];
    for (let i = 0; i < 6; i++) {
      const periodMonthKey = shiftInventoryMonthKey(baseMonthKey, -i);
      const [y, month1] = periodMonthKey.split('-').map(Number);
      const mo = month1 - 1;
      let planningBudget = 0;
      for (const b of usageBudgets) {
        if (!b.monthStart) continue;
        if (b.monthStart.getUTCFullYear() === y && b.monthStart.getUTCMonth() === mo && activeSet.has(b.category)) {
          planningBudget += b.budgetCents / 100;
        }
      }
      const period = periodByMonth.get(periodMonthKey) ?? null;
      const resolved = resolveInventoryBudgetActual(period, 'total');
      const isCurrent = y === curYear && mo === curMonth;
      if (isCurrent) planningBudget = monthBudgetTotal;
      const budget = inventoryBudgetComparisonCap(period, 'total', planningBudget);
      out.push({
        y, m: mo,
        label: `${MONTHS[mo]} ’${String(y).slice(2)}`,
        budget,
        actual: resolved.value,
        actualState: resolved.state,
        status: resolved.state === 'complete' && resolved.value != null && budget != null
          ? statusFor(budget, resolved.value)
          : null,
        isCurrent,
        hasAny: planningBudget > 0 || period != null,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusFor/MONTHS stable per render
  }, [usageBudgets, activeKeys, periodByMonth, curYear, curMonth, monthBudgetTotal, MONTHS]);
  const historyHasData = timeline.some((t) => t.hasAny);

  // ── Section create / edit / remove (persist immediately) ────────────
  const openCreateForm = () => { setFormId(null); setFormName(''); setFormItems(new Set()); setFormQuery(''); setFormOpen(true); };
  const openEditForm = (s: InventoryBudgetSection) => { setFormId(s.id); setFormName(s.name); setFormItems(new Set(s.itemIds)); setFormQuery(''); setFormOpen(true); };

  const submitSection = async () => {
    if (!user || !activePropertyId || formBusy) return;
    const name = formName.trim();
    if (!name) return;
    setFormBusy(true);
    try {
      const selectedItemIds = [...formItems];
      const id = await upsertInventoryBudgetSection(user.uid, activePropertyId, {
        ...(formId ? { id: formId } : {}),
        name,
        itemIds: selectedItemIds,
        sort: formId ? (localSections.find((s) => s.id === formId)?.sort ?? 0) : localSections.length,
      });

      // One item may feed only one custom-section budget. Moving it here
      // removes it from other sections so a closed actual cannot be counted
      // twice. The built-in category allocation is resolved by month close.
      const selected = new Set(selectedItemIds);
      const conflictingSections = localSections.filter(
        (s) => s.id !== id && s.itemIds.some((itemId) => selected.has(itemId)),
      );
      await Promise.all(conflictingSections.map((s) => upsertInventoryBudgetSection(
        user.uid,
        activePropertyId,
        { ...s, itemIds: s.itemIds.filter((itemId) => !selected.has(itemId)) },
      )));

      setLocalSections((p) => {
        const withoutMovedItems = p.map((s) => (
          s.id === id ? s : { ...s, itemIds: s.itemIds.filter((itemId) => !selected.has(itemId)) }
        ));
        return formId
          ? withoutMovedItems.map((s) => (s.id === id ? { ...s, name, itemIds: selectedItemIds } : s))
          : [...withoutMovedItems, { id, propertyId: activePropertyId, name, itemIds: selectedItemIds, sort: p.length }];
      });
      setFormOpen(false);
      onChanged();
    } catch (err) {
      console.error('[budgets] section save failed', err);
      alert(bp.sectionFailed);
    } finally {
      setFormBusy(false);
    }
  };

  const removeSection = async (id: string) => {
    if (!user || !activePropertyId) return;
    try {
      await deleteInventoryBudgetSection(user.uid, activePropertyId, id);
      setLocalSections((p) => p.filter((s) => s.id !== id));
      // Purge the removed section's pending edits too. If a cap was typed and
      // THEN the section removed, Save would otherwise re-insert 12 orphan
      // `section:<deletedId>` budget rows — invisible in this panel but summed
      // into the Accounting page's monthly budget forever.
      const key = sectionBudgetKey(id);
      setVals((p) => {
        const next: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(p)) if (!k.startsWith(`${key}|`)) next[k] = v;
        return next;
      });
      setDirty((p) => {
        const next = new Set([...p].filter((k) => !k.startsWith(`${key}|`)));
        return next;
      });
      setConfirmingRemove(null);
      onChanged();
    } catch (err) {
      console.error('[budgets] section remove failed', err);
      alert(bp.sectionFailed);
    }
  };

  // ── Save ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setSaving(true);
    try {
      const writes: Array<Promise<void>> = [];
      for (const composite of dirty) {
        const sep = composite.lastIndexOf('|');
        const budgetKey = composite.slice(0, sep);
        // Never write budget rows for a section that no longer exists (e.g.
        // edited, then removed in the same sitting) — orphan `section:` rows
        // inflate the accounting budget total with no UI to ever remove them.
        if (
          budgetKey.startsWith('section:') &&
          !localSections.some((s) => sectionBudgetKey(s.id) === budgetKey)
        ) continue;
        const y = Number(composite.slice(sep + 1));
        const arr = vals[composite] ?? EMPTY12();
        for (let m = 0; m < 12; m++) {
          writes.push(
            upsertInventoryBudget(user.uid, activePropertyId, {
              category: budgetKey,
              monthStart: new Date(Date.UTC(y, m, 1)),
              budgetCents: Math.max(0, Math.round(numOf(arr[m]) * 100)),
            }),
          );
        }
      }
      if (mode !== savedMode) {
        // Server route, not the anon client: `properties` RLS only lets admins
        // UPDATE, so a GM's mode switch silently didn't persist (reverted on
        // reload). The route re-checks the same management capability.
        writes.push(
          fetchWithAuth('/api/inventory/property-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pid: activePropertyId, budgetMode: mode }),
          }).then((res) => { if (!res.ok) throw new Error(`mode save failed (${res.status})`); }),
        );
      }
      await Promise.all(writes);
      onChanged(mode);
      onClose();
    } catch (err) {
      console.error('[budgets] save failed', err);
      alert(bp.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────
  const rows: Array<{ key: string; label: string; icon: React.ReactNode; section?: InventoryBudgetSection }> =
    mode === 'total'
      ? [{ key: 'total', label: bp.wholeInventory, icon: <SectionDot /> }]
      : [
          ...CATS.map((cat) => ({ key: cat as string, label: catLabelFor(lang, cat), icon: <CatIcon cat={cat} size={32} /> })),
          ...localSections.map((s) => ({ key: sectionBudgetKey(s.id), label: s.name, icon: <SectionDot />, section: s })),
        ];

  const pickerItems = useMemo(() => {
    const q = formQuery.trim().toLowerCase();
    return q ? display.filter((d) => d.name.toLowerCase().includes(q)) : display;
  }, [display, formQuery]);

  const summarySt = monthActualTotal == null || comparisonMonthBudgetTotal == null
    ? null
    : statusFor(comparisonMonthBudgetTotal, monthActualTotal);

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={bp.eyebrow}
      italic={`${MONTHS[month]} ${year}`}
      width={720}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>{bp.cancel}</Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving}>
            {saving ? bp.saving : bp.save}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {hasLegacyPurchaseCaps && (
          <div role="note" style={bannerStyle(T.ink2)}>{bp.legacyPurchaseCapsNotice}</div>
        )}
        {/* Over/near alerts exist only for a completed full-month actual. */}
        {alerts.over.length > 0 && (
          <div style={bannerStyle(T.warm)}>{bp.overBanner(alerts.over.join(', '))}</div>
        )}
        {alerts.over.length === 0 && alerts.near.length > 0 && (
          <div style={bannerStyle(T.caramel)}>{bp.nearBanner(alerts.near.join(', '))}</div>
        )}
        {alerts.over.length === 0 && alerts.near.length === 0 && totalActual.state === 'pending' && isCurrentMonth && (
          <div role="status" style={bannerStyle(T.ink2)}>
            {selectedPeriod ? bp.actualPending : bp.trackingNotStarted}
            {selectedPurchaseCopy ? ` ${selectedPurchaseCopy}.` : ''}
          </div>
        )}
        {alerts.over.length === 0 && alerts.near.length === 0 && totalActual.state === 'partial' && (
          <div role="status" style={bannerStyle(T.caramel)}>{bp.partialActual}</div>
        )}
        {mode === 'sections' && selectedPeriod?.allocation === 'total_only' && selectedPeriod.status === 'closed' && !selectedPeriod.isPartial && (
          <div role="status" style={bannerStyle(T.caramel)}>{bp.unallocatedActual}</div>
        )}
        {selectedComparisonUnavailable && totalActual.state === 'complete' && (
          <div role="status" style={bannerStyle(T.ink2)}>{bp.comparisonUnavailable}</div>
        )}
        {!isCurrentMonth && !selectedPeriod && (
          <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>{bp.planningNote(MONTHS[month], year)}</div>
        )}

        {/* Mode: one total number, or per-section. */}
        <BudgetSection title={bp.chooseMethodTitle} description={bp.chooseMethodSub}>
          <div style={{ display: 'flex', gap: 8 }}>
            <ModeBtn active={mode === 'total'} onClick={() => setMode('total')} title={bp.totalTitle} sub={bp.totalSub} />
            <ModeBtn active={mode === 'sections'} onClick={() => setMode('sections')} title={bp.sectionsTitle} sub={bp.sectionsSub} />
          </div>
        </BudgetSection>

        <BudgetSection title={bp.setLimitsTitle} description={bp.setLimitsSub}>
          {/* Month + year selectors are kept on distinct labelled rows so the
              year chips are not mistaken for additional months. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Caps>{bp.month}</Caps>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {MONTHS.map((m, i) => (
                  <Chip key={m} active={i === month} onClick={() => setMonth(i)}>{m}</Chip>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Caps>{bp.year}</Caps>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {YEARS.map((y) => (
                  <Chip key={y} active={y === year} onClick={() => setYear(y)}>{String(y)}</Chip>
                ))}
              </div>
            </div>
          </div>

          {/* Budget rows — fixed height + internal scroll (same size in both modes). */}
          <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 18px', height: ROWS_PANEL_H, overflowY: 'auto' }}>
          {rows.map((row, i) => {
            const cap = comparisonCapOf(row.key);
            const resolved = actualFor(row.key);
            const actual = resolved.value;
            const st = actual == null || cap == null ? null : statusFor(cap, actual);
            return (
              <div
                key={row.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px minmax(0, 1fr) clamp(112px, 24vw, 150px)',
                  gap: 14,
                  padding: '13px 0',
                  alignItems: 'center',
                  borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
                }}
              >
                {row.icon}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.label}
                  </span>
                  {/* Only a closed, allocatable actual receives budget color. */}
                  {resolved.state === 'complete' && actual != null && cap != null && st ? (
                    <>
                      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: spendColor(st), fontWeight: 500 }}>
                        {cap > 0
                          ? `${bp.usedOf(fmtMoney(actual), fmtMoney(cap))} · ${st === 'over' ? bp.over(fmtMoney(actual - cap)) : bp.left(fmtMoney(Math.max(0, cap - actual)))}`
                          : bp.noBudget(fmtMoney(actual))}
                      </span>
                      {cap > 0 && <MiniBar spent={actual} cap={cap} status={st} />}
                    </>
                  ) : (
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, lineHeight: 1.35 }}>
                      {resolved.state === 'partial'
                        ? bp.partialActual
                        : resolved.state === 'unallocated'
                          ? bp.unallocatedActual
                          : resolved.state === 'complete' && actual != null
                            ? bp.actualComparisonUnavailable(fmtMoney(actual))
                          : selectedPeriod
                            ? `${bp.actualPending}${selectedPurchaseCopy ? ` ${selectedPurchaseCopy}.` : ''}`
                            : isCurrentMonth
                              ? bp.trackingNotStarted
                              : bp.forMonth(MONTHS[month], year)}
                    </span>
                  )}
                  {/* Section controls */}
                  {row.section && (
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {row.section.itemIds.length > 0 ? bp.items(row.section.itemIds.length) : bp.noItemsYet}
                      <TextBtn onClick={() => openEditForm(row.section!)}>{bp.edit}</TextBtn>
                      {confirmingRemove === row.section.id ? (
                        <TextBtn warm onClick={() => void removeSection(row.section!.id)}>{bp.confirmRemove}</TextBtn>
                      ) : (
                        <TextBtn onClick={() => setConfirmingRemove(row.section!.id)}>{bp.remove}</TextBtn>
                      )}
                    </span>
                  )}
                </div>
                <DollarInput
                  ariaLabel={bp.budgetLimitLabel(row.label, MONTHS[month], year)}
                  value={arrFor(row.key)[month]}
                  onChange={(v) => setVal(row.key, v)}
                />
              </div>
            );
          })}

          {mode === 'total' && (
            <div style={{ padding: '12px 2px 4px', borderTop: `1px solid ${T.ruleSoft}`, fontFamily: fonts.sans, fontSize: 12, color: T.ink3, lineHeight: 1.5 }}>
              {bp.totalCovers}
            </div>
          )}

          {mode === 'sections' && !formOpen && (
            <div style={{ padding: '12px 0', borderTop: rows.length > 0 ? `1px solid ${T.ruleSoft}` : 'none' }}>
              <TextBtn onClick={openCreateForm} size={13}>{bp.addSection}</TextBtn>
            </div>
          )}

          {mode === 'sections' && formOpen && (
            <div style={{ padding: '14px 0 16px', borderTop: `1px solid ${T.ruleSoft}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={bp.sectionNamePh} maxLength={60} style={textInput} />
              <div>
                <Caps size={9}>{bp.whichItems}</Caps>
                <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, lineHeight: 1.4, marginTop: 4 }}>
                  {bp.sectionMoveHint}
                </div>
                <input value={formQuery} onChange={(e) => setFormQuery(e.target.value)} placeholder={bp.searchItems} style={{ ...textInput, height: 32, fontSize: 12.5, margin: '6px 0' }} />
                <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${T.ruleSoft}`, borderRadius: 10, padding: 6 }}>
                  {pickerItems.length === 0 && (
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, padding: '8px 6px' }}>
                      {formQuery.trim() ? bp.nothingMatches : bp.pickerEmpty}
                    </div>
                  )}
                  {pickerItems.map((d) => {
                    const on = formItems.has(d.id);
                    return (
                      <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px', cursor: 'pointer', borderRadius: 7 }} className="inv-menu-opt">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setFormItems((p) => { const n = new Set(p); if (on) n.delete(d.id); else n.add(d.id); return n; })}
                          style={{ accentColor: T.brand }}
                        />
                        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink }}>{d.name}</span>
                        <span style={{ fontFamily: fonts.sans, fontSize: 10.5, color: T.faint, marginLeft: 'auto' }}>{catLabelFor(lang, d.cat)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="primary" size="sm" onClick={() => void submitSection()} disabled={formBusy || !formName.trim()}>
                  {formBusy ? bp.saving : formId ? bp.saveSection : bp.createSection}
                </Btn>
                <Btn variant="ghost" size="sm" onClick={() => setFormOpen(false)} disabled={formBusy}>{bp.cancel}</Btn>
              </div>
            </div>
          )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn
              variant="ghost"
              size="md"
              onClick={copyToYear}
              style={{ maxWidth: '100%', height: 'auto', minHeight: 38, padding: '8px 16px', whiteSpace: 'normal', lineHeight: 1.3, textAlign: 'center' }}
            >
              {bp.copyMonthToYear(MONTHS[month], year)}
            </Btn>
          </div>
        </BudgetSection>

        {/* Footer summary — closed usage vs budget, or a clear pending state. */}
        <BudgetSection
          contained
          title={isCurrentMonth ? bp.reviewCurrentTitle : bp.reviewSelectedTitle}
          description={selectedComparisonUnavailable
            ? bp.comparisonUnavailable
            : isCurrentMonth ? bp.reviewCurrentSub : bp.reviewSelectedSub}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <Caps>{selectedPeriod ? bp.thisMonthActual : bp.totalBudget}</Caps>
              {monthActualTotal != null ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 30, color: summarySt ? spendColor(summarySt) : T.ink, letterSpacing: '-0.02em', fontWeight: 600, lineHeight: 1.05 }}>
                    {fmtMoney(monthActualTotal)}
                  </span>
                  {summarySt && comparisonMonthBudgetTotal != null && comparisonMonthBudgetTotal > 0 && (
                    <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
                      {bp.summaryOf(fmtMoney(comparisonMonthBudgetTotal))} · {summarySt === 'over' ? bp.over(fmtMoney(monthActualTotal - comparisonMonthBudgetTotal)) : bp.left(fmtMoney(Math.max(0, comparisonMonthBudgetTotal - monthActualTotal)))}
                    </span>
                  )}
                  {comparisonMonthBudgetTotal == null && (
                    <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
                      {bp.comparisonUnavailable}
                    </span>
                  )}
                </div>
              ) : selectedPeriod || isCurrentMonth ? (
                <div role="status" style={{ marginTop: 5 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 20, color: T.ink, fontWeight: 650 }}>
                    {totalActual.state === 'partial'
                      ? bp.partialActual
                      : totalActual.state === 'unallocated'
                        ? bp.unallocatedActual
                        : bp.actualPending}
                  </div>
                  {selectedPurchaseCopy && (
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2, marginTop: 4 }}>
                      {selectedPurchaseCopy}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontFamily: fonts.sans, fontSize: 30, color: T.ink, letterSpacing: '-0.02em', fontWeight: 600, lineHeight: 1.05, marginTop: 4 }}>
                  {fmtMoney(monthBudgetTotal)}
                </div>
              )}
              <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, marginTop: 4 }}>
                {isCurrentMonth && monthBudgetTotal === 0 ? bp.noBudgetsYet : bp.noCapHint}
              </div>
            </div>
          </div>
          {comparisonMonthBudgetTotal != null && comparisonMonthBudgetTotal > 0 && monthActualTotal != null && summarySt && (
            <MiniBar spent={monthActualTotal} cap={comparisonMonthBudgetTotal} status={summarySt} height={7} />
          )}
        </BudgetSection>

        {/* Budget history — month-by-month closed usage vs budget. */}
        <BudgetSection contained title={bp.compareMonthsTitle} description={bp.compareMonthsSub}>
          {historyHasData ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, maxHeight: HISTORY_PANEL_H, overflowY: 'auto' }}>
              {timeline.map((t) => (
                <div key={`${t.y}-${t.m}`} style={{ display: 'grid', gridTemplateColumns: '82px 1fr 158px', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: t.isCurrent ? T.ink : T.ink2, whiteSpace: 'nowrap' }}>
                    {t.label}
                    {t.isCurrent && <span style={{ fontFamily: fonts.mono, fontSize: 8, letterSpacing: '0.08em', color: T.faint, marginLeft: 5 }}>{bp.thisMonthTag}</span>}
                  </span>
                  {t.actual != null && t.status && t.budget != null ? (
                    <MiniBar spent={t.actual} cap={t.budget} status={t.status} height={7} />
                  ) : (
                    <span style={{ display: 'block', height: 7, borderRadius: 7, background: T.ruleSoft }} />
                  )}
                  <span style={{ fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 500, textAlign: 'right', color: !t.hasAny ? T.faint : t.status ? spendColor(t.status) : T.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {!t.hasAny
                      ? bp.monthNoData
                      : t.actualState === 'partial'
                        ? bp.partialShort
                        : t.actual == null
                          ? bp.pendingShort
                          : t.budget == null
                            ? bp.actualComparisonUnavailable(fmtMoney(t.actual))
                          : t.budget > 0
                            ? `${fmtMoney(t.actual)} / ${fmtMoney(t.budget)}`
                            : bp.noBudgetShort(fmtMoney(t.actual))}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, lineHeight: 1.5 }}>
              {bp.historyEmpty}
            </div>
          )}
        </BudgetSection>
      </div>
    </Overlay>
  );
}

function BudgetSection({
  title,
  description,
  contained = false,
  children,
}: {
  title: string;
  description: string;
  contained?: boolean;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  return (
    <section
      aria-labelledby={titleId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        ...(contained
          ? {
              padding: '18px',
              background: T.paper,
              border: `1px solid ${T.rule}`,
              borderRadius: 14,
            }
          : {}),
      }}
    >
      <header>
        <h2
          id={titleId}
          style={{
            margin: 0,
            fontFamily: fonts.sans,
            fontSize: 18,
            fontWeight: 700,
            lineHeight: 1.25,
            letterSpacing: '-0.015em',
            color: T.ink,
          }}
        >
          {title}
        </h2>
        <p
          style={{
            maxWidth: 620,
            margin: '4px 0 0',
            fontFamily: fonts.sans,
            fontSize: 13,
            lineHeight: 1.5,
            color: T.ink2,
          }}
        >
          {description}
        </p>
      </header>
      {children}
    </section>
  );
}

function MiniBar({ spent, cap, status, height = 5 }: { spent: number; cap: number; status: SpendStatus; height?: number }) {
  const pct = cap > 0 ? Math.min(1, spent / cap) : 0;
  const color = spendColor(status);
  return (
    <span style={{ display: 'block', position: 'relative', height, borderRadius: height, background: T.ruleSoft, overflow: 'hidden', marginTop: 4 }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, background: color, borderRadius: height }} />
    </span>
  );
}

function bannerStyle(color: string): React.CSSProperties {
  return {
    padding: '10px 14px',
    borderRadius: 10,
    background: `${color}14`,
    border: `1px solid ${color}44`,
    fontFamily: fonts.sans,
    fontSize: 12.5,
    fontWeight: 500,
    color,
  };
}

function SectionDot() {
  return (
    <span style={{ width: 32, height: 32, borderRadius: 10, background: T.ruleSoft, border: `1px solid ${T.rule}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ width: 9, height: 9, borderRadius: 999, background: T.ink3 }} />
    </span>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: '6px 10px', borderRadius: 7, cursor: 'pointer',
        background: active ? T.ink : 'transparent', color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`, fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, minWidth: 42,
      }}
    >
      {children}
    </button>
  );
}

function TextBtn({ onClick, children, warm, size = 11 }: { onClick: () => void; children: React.ReactNode; warm?: boolean; size?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ border: 'none', background: 'transparent', padding: 0, fontFamily: fonts.sans, fontSize: size, fontWeight: 600, color: warm ? T.warm : T.ink2, textDecoration: 'underline', cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}

function DollarInput({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontFamily: fonts.sans, fontSize: 18, fontWeight: 600, color: value ? T.ink2 : T.faint }}>$</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => { const v = e.target.value; if (numGuard(v)) onChange(v); }}
        style={{
          width: '100%', height: 42, padding: '0 14px 0 28px', borderRadius: 10, boxSizing: 'border-box',
          background: T.bg, border: `1px solid ${T.rule}`, fontFamily: fonts.sans, fontSize: 20, fontWeight: 600,
          color: T.ink, letterSpacing: '-0.02em', outline: 'none', textAlign: 'right',
        }}
      />
    </div>
  );
}

function ModeBtn({ active, onClick, title, sub }: { active: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1, padding: '14px 16px', borderRadius: 12, cursor: 'pointer',
        background: active ? T.ink : 'transparent', color: active ? T.bg : T.ink,
        border: `1px solid ${active ? T.ink : T.rule}`, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3,
      }}
    >
      <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600 }}>{title}</span>
      <span style={{ fontFamily: fonts.sans, fontSize: 11, color: active ? 'rgba(255,255,255,0.7)' : T.ink2, lineHeight: 1.4 }}>{sub}</span>
    </button>
  );
}

const textInput: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px', borderRadius: 9, boxSizing: 'border-box',
  background: T.bg, border: `1px solid ${T.rule}`, fontFamily: fonts.sans, fontSize: 13.5, color: T.ink, outline: 'none',
};
