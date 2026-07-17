'use client';

// Budgets — set the hotel's monthly inventory spend caps, and see this month's
// spend against them.
//
// Two ways to budget (properties.inventory_budget_mode, migration 0306):
//   • One total budget — a single whole-inventory number per month.
//   • By section — the three app categories PLUS custom hotel sections
//     ("Pool supplies"), each mapped to specific items so spend tracks.
//
// Numbers are always per-month; "Copy to the whole year" fills a year. A year
// switcher covers planning next year in the fall. An empty box = no cap.
//
// Spend vs budget: when the panel is showing the CURRENT calendar month, each
// row shows what's been spent against its cap (green under, amber near, red
// over) and the footer rolls it up — a GM opening Budgets sees where they
// stand at a glance. Other months (planning ahead) just show the caps.
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
  type MonthSpendDetail,
  type MonthlySpend,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { InventoryBudget, InventoryBudgetMode, InventoryBudgetSection } from '@/types';

import { T, fonts, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { numGuard } from './form-kit';
import { fmtMoney } from '../format';
import { startOfLocalMonth, addLocalMonths } from '../month';
import type { DisplayItem } from '../types';
import { catLabelFor, monthsFor, type Lang } from '../inv-i18n';

interface BudgetsPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  budgets: InventoryBudget[];
  sections: InventoryBudgetSection[];
  mode: InventoryBudgetMode;
  /** Full catalog — the custom-section item picker. */
  display: DisplayItem[];
  /** Month-to-date spend (dollars) — total, per category, per item. */
  spendDetail: MonthSpendDetail;
  /** Per-month spend for the last 6 months (dollars) — drives the timeline. */
  spendHistory: MonthlySpend[];
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
      save: 'Save',
      howBudgetsWork: 'How budgets work',
      totalTitle: 'One total budget',
      totalSub: 'A single number for the whole inventory.',
      totalCovers: 'This one budget covers every category — housekeeping, maintenance, food & beverage, and any sections.',
      sectionsTitle: 'By section',
      sectionsSub: 'Housekeeping, maintenance, food & beverage — plus your own sections.',
      month: 'Month',
      wholeInventory: 'Whole inventory',
      forMonth: (m: string, y: number) => `for ${m} ${y}`,
      addSection: '＋ Add a section',
      sectionNamePh: 'Section name (e.g. Pool supplies)',
      whichItems: 'Which items count toward it',
      searchItems: 'Search items…',
      nothingMatches: 'Nothing matches.',
      pickerEmpty: 'No inventory items yet.',
      createSection: 'Create section',
      saveSection: 'Save section',
      items: (n: number) => `${n} item${n === 1 ? '' : 's'}`,
      noItemsYet: 'no items yet',
      edit: 'Edit',
      remove: 'Remove',
      confirmRemove: 'Remove?',
      sectionFailed: 'Saving the section failed. Please try again.',
      saveFailed: 'Saving the budgets failed. Please try again.',
      noCapHint: 'Leave a box empty for no cap.',
      // Spend
      spentOf: (spent: string, cap: string) => `${spent} spent of ${cap}`,
      left: (v: string) => `${v} left`,
      over: (v: string) => `${v} over`,
      noBudget: (spent: string) => `${spent} spent · no budget set`,
      thisMonthSpend: 'This month’s spend',
      totalBudget: 'Total budget',
      noBudgetsYet: 'No budgets set for this month. Add caps below to track spend against them.',
      overBanner: (names: string) => `Over budget: ${names}.`,
      nearBanner: (names: string) => `Close to budget: ${names}.`,
      planningNote: (m: string, y: number) => `Planning ${m} ${y} — spend shows on the current month.`,
      // History timeline
      budgetHistory: 'Budget history',
      thisMonthTag: 'NOW',
      monthNoData: 'no activity',
      noBudgetShort: (v: string) => `${v} · no budget`,
      historyEmpty: 'Your month-by-month budget vs spend appears here as you set budgets and log received orders.',
    },
    es: {
      eyebrow: 'Presupuestos',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      save: 'Guardar',
      howBudgetsWork: 'Cómo funcionan los presupuestos',
      totalTitle: 'Un presupuesto total',
      totalSub: 'Un solo número para todo el inventario.',
      totalCovers: 'Este presupuesto cubre todas las categorías — limpieza, mantenimiento, alimentos y cualquier sección.',
      sectionsTitle: 'Por sección',
      sectionsSub: 'Limpieza, mantenimiento, alimentos — más tus propias secciones.',
      month: 'Mes',
      wholeInventory: 'Todo el inventario',
      forMonth: (m: string, y: number) => `para ${m} ${y}`,
      addSection: '＋ Agregar sección',
      sectionNamePh: 'Nombre de la sección (ej. Artículos de piscina)',
      whichItems: 'Qué artículos cuentan para ella',
      searchItems: 'Buscar artículos…',
      nothingMatches: 'Nada coincide.',
      pickerEmpty: 'Aún no hay artículos de inventario.',
      createSection: 'Crear sección',
      saveSection: 'Guardar sección',
      items: (n: number) => `${n} artículo${n === 1 ? '' : 's'}`,
      noItemsYet: 'sin artículos',
      edit: 'Editar',
      remove: 'Quitar',
      confirmRemove: '¿Quitar?',
      sectionFailed: 'No se pudo guardar la sección. Inténtalo de nuevo.',
      saveFailed: 'No se pudieron guardar los presupuestos. Inténtalo de nuevo.',
      noCapHint: 'Deja una casilla vacía para no poner límite.',
      // Spend
      spentOf: (spent: string, cap: string) => `${spent} gastado de ${cap}`,
      left: (v: string) => `${v} disponible`,
      over: (v: string) => `${v} sobre`,
      noBudget: (spent: string) => `${spent} gastado · sin presupuesto`,
      thisMonthSpend: 'Gasto de este mes',
      totalBudget: 'Presupuesto total',
      noBudgetsYet: 'Sin presupuestos este mes. Agrega límites abajo para seguir el gasto.',
      overBanner: (names: string) => `Sobre presupuesto: ${names}.`,
      nearBanner: (names: string) => `Cerca del límite: ${names}.`,
      planningNote: (m: string, y: number) => `Planeando ${m} ${y} — el gasto se muestra en el mes actual.`,
      // History timeline
      budgetHistory: 'Historial de presupuesto',
      thisMonthTag: 'AHORA',
      monthNoData: 'sin actividad',
      noBudgetShort: (v: string) => `${v} · sin presupuesto`,
      historyEmpty: 'Tu presupuesto vs gasto mes a mes aparece aquí a medida que fijas presupuestos y registras pedidos recibidos.',
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

export function BudgetsPanel({ lang, open, onClose, budgets, sections, mode: savedMode, display, spendDetail, spendHistory, onChanged }: BudgetsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const bp = bpStrings(lang);
  const MONTHS = monthsFor(lang);
  // LOCAL now — "this month" is the hotel's calendar month, and it's the only
  // month spendDetail covers.
  const now = useMemo(() => new Date(), []);
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();
  const thisYear = curYear;
  const YEARS = [thisYear, thisYear + 1];

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

  // Whether the panel is showing the live month (the only one with spend).
  const showSpend = year === curYear && month === curMonth;

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
    for (const b of budgets) {
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
  }, [open, budgets]);

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

  // Spend against a budget key (only meaningful for the live month).
  const spentFor = (budgetKey: string): number => {
    if (budgetKey === 'total') return spendDetail.total;
    if (budgetKey.startsWith('section:')) {
      const sec = localSections.find((s) => sectionBudgetKey(s.id) === budgetKey);
      if (!sec) return 0;
      return sec.itemIds.reduce((s, id) => s + (spendDetail.byItem[id] ?? 0), 0);
    }
    return spendDetail.byCat[budgetKey as InvCat] ?? 0;
  };

  const statusFor = (cap: number, spent: number): SpendStatus => {
    if (cap <= 0) return 'nocap';
    if (spent > cap) return 'over';
    if (spent >= cap * 0.8) return 'near';
    return 'ok';
  };

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
  const monthSpentTotal = spendDetail.total;

  // GM alerts for the live month: which rows are over / near their cap.
  const alerts = useMemo(() => {
    if (!showSpend) return { over: [] as string[], near: [] as string[] };
    const over: string[] = [];
    const near: string[] = [];
    for (const key of activeKeys) {
      const cap = capOf(key);
      if (cap <= 0) continue;
      const st = statusFor(cap, spentFor(key));
      const label = key === 'total' ? bp.wholeInventory
        : key.startsWith('section:') ? (localSections.find((s) => sectionBudgetKey(s.id) === key)?.name ?? '')
        : catLabelFor(lang, key as InvCat);
      if (st === 'over') over.push(label);
      else if (st === 'near') near.push(label);
    }
    return { over, near };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads vals via capOf
  }, [showSpend, activeKeys, vals, year, month, spendDetail, localSections, lang]);

  // ── Budget-vs-spend timeline (last 6 months) ─────────────────────────
  // Read-only, backward-looking. For each of the last 6 calendar months:
  //   • budget = sum of the STORED caps (dollars) for that month over the active
  //     keys (mode-aware). Read straight from the `budgets` prop (all months) —
  //     matched by UTC year/month, the same way hydration buckets them.
  //   • spent  = that month's total received-order spend (from spendHistory).
  // Newest month first. A month with no budget AND no spend reads as "no activity".
  const timeline = useMemo(() => {
    const activeSet = new Set(activeKeys);
    const spendByKey = new Map<string, MonthlySpend>();
    for (const h of spendHistory) spendByKey.set(`${h.monthStart.getFullYear()}-${h.monthStart.getMonth()}`, h);
    const base = startOfLocalMonth(now);
    const out: Array<{
      y: number; m: number; label: string; budget: number; spent: number;
      status: SpendStatus; isCurrent: boolean; hasAny: boolean;
    }> = [];
    for (let i = 0; i < 6; i++) {
      const d = addLocalMonths(base, -i);
      const y = d.getFullYear();
      const mo = d.getMonth();
      let budget = 0;
      for (const b of budgets) {
        if (!b.monthStart) continue;
        if (b.monthStart.getUTCFullYear() === y && b.monthStart.getUTCMonth() === mo && activeSet.has(b.category)) {
          budget += b.budgetCents / 100;
        }
      }
      let spent = spendByKey.get(`${y}-${mo}`)?.total ?? 0;
      const isCurrent = y === curYear && mo === curMonth;
      // The current-month row mirrors the live footer (edited caps + MTD spend)
      // rather than the last-saved budget, so the two "this month" figures on
      // screen can never disagree while a cap is being typed.
      if (isCurrent) { budget = monthBudgetTotal; spent = monthSpentTotal; }
      out.push({
        y, m: mo,
        label: `${MONTHS[mo]} ’${String(y).slice(2)}`,
        budget, spent,
        status: statusFor(budget, spent),
        isCurrent,
        hasAny: budget > 0 || spent > 0,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusFor/MONTHS stable per render
  }, [spendHistory, budgets, activeKeys, now, curYear, curMonth, monthBudgetTotal, monthSpentTotal]);
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
      const id = await upsertInventoryBudgetSection(user.uid, activePropertyId, {
        ...(formId ? { id: formId } : {}),
        name,
        itemIds: [...formItems],
        sort: formId ? (localSections.find((s) => s.id === formId)?.sort ?? 0) : localSections.length,
      });
      setLocalSections((p) =>
        formId
          ? p.map((s) => (s.id === formId ? { ...s, name, itemIds: [...formItems] } : s))
          : [...p, { id, propertyId: activePropertyId, name, itemIds: [...formItems], sort: p.length }],
      );
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

  const summarySt = statusFor(monthBudgetTotal, monthSpentTotal);

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* GM alerts — over / near budget on the live month. */}
        {showSpend && alerts.over.length > 0 && (
          <div style={bannerStyle(T.warm)}>{bp.overBanner(alerts.over.join(', '))}</div>
        )}
        {showSpend && alerts.over.length === 0 && alerts.near.length > 0 && (
          <div style={bannerStyle(T.caramel)}>{bp.nearBanner(alerts.near.join(', '))}</div>
        )}
        {!showSpend && (
          <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>{bp.planningNote(MONTHS[month], year)}</div>
        )}

        {/* Mode: one total number, or per-section */}
        <div>
          <Caps>{bp.howBudgetsWork}</Caps>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <ModeBtn active={mode === 'total'} onClick={() => setMode('total')} title={bp.totalTitle} sub={bp.totalSub} />
            <ModeBtn active={mode === 'sections'} onClick={() => setMode('sections')} title={bp.sectionsTitle} sub={bp.sectionsSub} />
          </div>
        </div>

        {/* Year + month */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Caps>{bp.month}</Caps>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {MONTHS.map((m, i) => (
              <Chip key={m} active={i === month} onClick={() => setMonth(i)}>{m}</Chip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {YEARS.map((y) => (
              <Chip key={y} active={y === year} onClick={() => setYear(y)}>{String(y)}</Chip>
            ))}
          </div>
        </div>

        {/* Budget rows — fixed height + internal scroll (same size in both modes). */}
        <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 18px', height: ROWS_PANEL_H, overflowY: 'auto' }}>
          {rows.map((row, i) => {
            const cap = capOf(row.key);
            const spent = spentFor(row.key);
            const st = statusFor(cap, spent);
            return (
              <div
                key={row.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 150px',
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
                  {/* Spend line (live month) or the plain "for month" caption. */}
                  {showSpend ? (
                    <>
                      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: spendColor(st), fontWeight: 500 }}>
                        {cap > 0
                          ? `${bp.spentOf(fmtMoney(spent), fmtMoney(cap))} · ${st === 'over' ? bp.over(fmtMoney(spent - cap)) : bp.left(fmtMoney(Math.max(0, cap - spent)))}`
                          : bp.noBudget(fmtMoney(spent))}
                      </span>
                      {cap > 0 && <MiniBar spent={spent} cap={cap} status={st} />}
                    </>
                  ) : (
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3 }}>{bp.forMonth(MONTHS[month], year)}</span>
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
                <DollarInput value={arrFor(row.key)[month]} onChange={(v) => setVal(row.key, v)} />
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

        {/* Footer summary — spend vs budget (live month) or just the total cap. */}
        <div style={{ padding: '14px 18px', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <Caps>{showSpend ? bp.thisMonthSpend : bp.totalBudget}</Caps>
              {showSpend ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 30, color: spendColor(summarySt), letterSpacing: '-0.02em', fontWeight: 600, lineHeight: 1.05 }}>
                    {fmtMoney(monthSpentTotal)}
                  </span>
                  {monthBudgetTotal > 0 && (
                    <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
                      of {fmtMoney(monthBudgetTotal)} · {summarySt === 'over' ? bp.over(fmtMoney(monthSpentTotal - monthBudgetTotal)) : bp.left(fmtMoney(Math.max(0, monthBudgetTotal - monthSpentTotal)))}
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ fontFamily: fonts.sans, fontSize: 30, color: T.ink, letterSpacing: '-0.02em', fontWeight: 600, lineHeight: 1.05, marginTop: 4 }}>
                  {fmtMoney(monthBudgetTotal)}
                </div>
              )}
              <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, marginTop: 4 }}>
                {showSpend && monthBudgetTotal === 0 ? bp.noBudgetsYet : bp.noCapHint}
              </div>
            </div>
            <Btn variant="ghost" size="md" onClick={copyToYear}>{`Copy ${MONTHS[month]} → all of ${year}`}</Btn>
          </div>
          {showSpend && monthBudgetTotal > 0 && <MiniBar spent={monthSpentTotal} cap={monthBudgetTotal} status={summarySt} height={7} />}
        </div>

        {/* Budget history — month-by-month spent vs budget (newest first). */}
        <div style={{ padding: '14px 18px', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14 }}>
          <Caps>{bp.budgetHistory}</Caps>
          {historyHasData ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 13, maxHeight: HISTORY_PANEL_H, overflowY: 'auto' }}>
              {timeline.map((t) => (
                <div key={`${t.y}-${t.m}`} style={{ display: 'grid', gridTemplateColumns: '82px 1fr 158px', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: t.isCurrent ? T.ink : T.ink2, whiteSpace: 'nowrap' }}>
                    {t.label}
                    {t.isCurrent && <span style={{ fontFamily: fonts.mono, fontSize: 8, letterSpacing: '0.08em', color: T.faint, marginLeft: 5 }}>{bp.thisMonthTag}</span>}
                  </span>
                  <MiniBar spent={t.spent} cap={t.budget} status={t.status} height={7} />
                  <span style={{ fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 500, textAlign: 'right', color: !t.hasAny ? T.faint : t.budget > 0 ? spendColor(t.status) : T.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {!t.hasAny
                      ? bp.monthNoData
                      : t.budget > 0
                        ? `${fmtMoney(t.spent)} / ${fmtMoney(t.budget)}`
                        : bp.noBudgetShort(fmtMoney(t.spent))}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 10, fontFamily: fonts.sans, fontSize: 12, color: T.ink3, lineHeight: 1.5 }}>
              {bp.historyEmpty}
            </div>
          )}
        </div>
      </div>
    </Overlay>
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

function DollarInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontFamily: fonts.sans, fontSize: 18, fontWeight: 600, color: value ? T.ink2 : T.faint }}>$</span>
      <input
        type="text"
        inputMode="decimal"
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
