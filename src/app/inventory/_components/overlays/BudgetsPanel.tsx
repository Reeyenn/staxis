'use client';

// Budgets — how much the hotel has to spend on inventory, per month.
//
// Two ways to budget (properties.inventory_budget_mode, migration 0306):
//   • One total budget — a single whole-inventory number per month.
//   • By section — the three app categories PLUS custom hotel sections
//     ("Pool supplies"), each mapped to specific items so spend tracks.
//
// Numbers are always per-month (the old "same every month" mode is gone —
// "Copy to the whole year" covers that workflow). A year switcher covers
// planning next year's budgets in the fall. $0 = no cap.
//
// Sections are created/removed immediately (with their budget rows); the
// dollar numbers save on Save. Switching modes never wipes the other mode's
// numbers — they keep living in inventory_budgets and come back if you
// switch back.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  upsertInventoryBudget,
  upsertInventoryBudgetSection,
  deleteInventoryBudgetSection,
  sectionBudgetKey,
  updateProperty,
} from '@/lib/db';
import type { InventoryBudget, InventoryBudgetMode, InventoryBudgetSection } from '@/types';

import { T, fonts, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
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
  /** Full catalog — the custom-section item picker. */
  display: DisplayItem[];
  /**
   * Fired after any persisted change so the parent refetches. `mode` is set
   * ONLY when Save wrote it to the property — section add/remove must not
   * report the panel's unsaved mode toggle (the meters would flip modes
   * without the property ever changing).
   */
  onChanged: (mode?: InventoryBudgetMode) => void;
}

const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

function bpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Budgets',
      italic: 'How much you have to spend',
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save',
      howBudgetsWork: 'How budgets work',
      totalTitle: 'One total budget',
      totalSub: 'A single number for the whole inventory.',
      sectionsTitle: 'By section',
      sectionsSub: 'Housekeeping, maintenance, food & beverage — plus your own sections.',
      month: 'Month',
      wholeInventory: 'Whole inventory',
      forMonth: (m: string, y: number) => `for ${m} ${y}`,
      totalThisMonth: 'Total this month',
      copyToYear: (m: string, y: number) => `Copy ${m} to all of ${y}`,
      addSection: '＋ Add a section',
      sectionNamePh: 'Section name (e.g. Pool supplies)',
      whichItems: 'Which items count toward it',
      searchItems: 'Search items…',
      nothingMatches: 'Nothing matches.',
      createSection: 'Create section',
      saveSection: 'Save section',
      itemsCount: (n: number) => `${n} item${n === 1 ? '' : 's'} tracked`,
      noItemsYet: 'no items yet — spending won’t track',
      edit: 'Edit',
      remove: 'Remove',
      confirmRemove: 'Remove?',
      removeNote: 'Removing a section also removes its budget numbers.',
      sectionFailed: 'Saving the section failed. Please try again.',
      saveFailed: 'Saving the budgets failed. Please try again.',
      zeroHint: '$0 means no cap.',
    },
    es: {
      eyebrow: 'Presupuestos',
      italic: 'Cuánto tienes para gastar',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      save: 'Guardar',
      howBudgetsWork: 'Cómo funcionan los presupuestos',
      totalTitle: 'Un presupuesto total',
      totalSub: 'Un solo número para todo el inventario.',
      sectionsTitle: 'Por sección',
      sectionsSub: 'Limpieza, mantenimiento, alimentos — más tus propias secciones.',
      month: 'Mes',
      wholeInventory: 'Todo el inventario',
      forMonth: (m: string, y: number) => `para ${m} ${y}`,
      totalThisMonth: 'Total este mes',
      copyToYear: (m: string, y: number) => `Copiar ${m} a todo ${y}`,
      addSection: '＋ Agregar sección',
      sectionNamePh: 'Nombre de la sección (ej. Artículos de piscina)',
      whichItems: 'Qué artículos cuentan para ella',
      searchItems: 'Buscar artículos…',
      nothingMatches: 'Nada coincide.',
      createSection: 'Crear sección',
      saveSection: 'Guardar sección',
      itemsCount: (n: number) => `${n} artículo${n === 1 ? '' : 's'} seguido${n === 1 ? '' : 's'}`,
      noItemsYet: 'sin artículos — el gasto no se seguirá',
      edit: 'Editar',
      remove: 'Quitar',
      confirmRemove: '¿Quitar?',
      removeNote: 'Quitar una sección también quita sus números de presupuesto.',
      sectionFailed: 'No se pudo guardar la sección. Inténtalo de nuevo.',
      saveFailed: 'No se pudieron guardar los presupuestos. Inténtalo de nuevo.',
      zeroHint: '$0 significa sin límite.',
    },
  }[lang];
}

const valKey = (budgetKey: string, year: number) => `${budgetKey}|${year}`;

export function BudgetsPanel({ lang, open, onClose, budgets, sections, mode: savedMode, display, onChanged }: BudgetsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const bp = bpStrings(lang);
  const MONTHS = monthsFor(lang);
  // LOCAL year/month for "where the panel opens" — a GM typing "this month's
  // budget" on July 31, 8pm CDT means July, not the UTC August. (Budget ROWS
  // stay keyed by UTC month starts — only the "now" side is local.)
  const thisYear = new Date().getFullYear();
  const YEARS = [thisYear, thisYear + 1];

  const [mode, setMode] = useState<InventoryBudgetMode>(savedMode);
  const [year, setYear] = useState<number>(thisYear);
  const [month, setMonth] = useState<number>(new Date().getMonth());
  // Dollar values per (budget key, year): key `<budgetKey>|<year>` → 12 months.
  const [vals, setVals] = useState<Record<string, number[]>>({});
  // Composite keys with unsaved edits — the only arrays Save writes.
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  // Local mirror so a freshly-created section appears before the parent refetch.
  const [localSections, setLocalSections] = useState<InventoryBudgetSection[]>(sections);
  // Add/edit section mini-form.
  const [formOpen, setFormOpen] = useState(false);
  const [formId, setFormId] = useState<string | null>(null); // null = creating
  const [formName, setFormName] = useState('');
  const [formItems, setFormItems] = useState<Set<string>>(() => new Set());
  const [formQuery, setFormQuery] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  // Hydration. Two distinct cases, and getting them wrong loses typed money:
  //   1. closed→open: full reset from props (fresh session).
  //   2. `budgets` refreshes WHILE open (section add/remove triggers a parent
  //      refetch): merge the fresh numbers ONLY if the GM has no unsaved
  //      edits — never wipe `dirty` values or reset mode/month/year mid-edit.
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
    if (!firstOpen && dirtyRef.current.size > 0) return; // mid-edit refresh — keep typed values

    const next: Record<string, number[]> = {};
    for (const b of budgets) {
      if (!b.monthStart) continue;
      const y = b.monthStart.getUTCFullYear();
      if (!YEARS.includes(y)) continue;
      const k = valKey(b.category, y);
      if (!next[k]) next[k] = Array(12).fill(0);
      next[k][b.monthStart.getUTCMonth()] = b.budgetCents / 100;
    }
    setVals(next);
    setDirty(new Set());
    if (firstOpen) {
      setMode(savedMode);
      setYear(thisYear);
      setMonth(new Date().getMonth());
      setFormOpen(false);
      setConfirmingRemove(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- YEARS/thisYear derived; savedMode only read on open
  }, [open, budgets]);

  useEffect(() => {
    setLocalSections(sections);
  }, [sections]);

  const arrFor = (budgetKey: string): number[] => vals[valKey(budgetKey, year)] ?? Array(12).fill(0);

  const setVal = (budgetKey: string, dollars: number) => {
    const k = valKey(budgetKey, year);
    setVals((p) => {
      const arr = [...(p[k] ?? Array(12).fill(0))];
      arr[month] = dollars;
      return { ...p, [k]: arr };
    });
    setDirty((p) => new Set(p).add(k));
  };

  // The budget keys the active mode edits.
  const activeKeys = useMemo(
    () => (mode === 'total' ? ['total'] : [...CATS, ...localSections.map((s) => sectionBudgetKey(s.id))]),
    [mode, localSections],
  );

  const copyToYear = () => {
    setVals((p) => {
      const next = { ...p };
      for (const key of activeKeys) {
        const k = valKey(key, year);
        const v = (p[k] ?? Array(12).fill(0))[month];
        next[k] = Array(12).fill(v);
      }
      return next;
    });
    setDirty((p) => {
      const next = new Set(p);
      for (const key of activeKeys) next.add(valKey(key, year));
      return next;
    });
  };

  const monthTotal = useMemo(
    () => activeKeys.reduce((s, key) => s + arrFor(key)[month], 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arrFor reads vals/year
    [activeKeys, vals, year, month],
  );

  // ── Section create / edit / remove (persist immediately) ────────────
  const openCreateForm = () => {
    setFormId(null);
    setFormName('');
    setFormItems(new Set());
    setFormQuery('');
    setFormOpen(true);
  };
  const openEditForm = (s: InventoryBudgetSection) => {
    setFormId(s.id);
    setFormName(s.name);
    setFormItems(new Set(s.itemIds));
    setFormQuery('');
    setFormOpen(true);
  };

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
      setConfirmingRemove(null);
      onChanged();
    } catch (err) {
      console.error('[budgets] section remove failed', err);
      alert(bp.sectionFailed);
    }
  };

  // ── Save the numbers (+ mode) ────────────────────────────────────────
  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setSaving(true);
    try {
      const writes: Array<Promise<void>> = [];
      // Every dirty (key, year) array writes in full — including arrays edited
      // in the OTHER mode before switching; nothing typed is silently dropped.
      for (const composite of dirty) {
        const sep = composite.lastIndexOf('|');
        const budgetKey = composite.slice(0, sep);
        const y = Number(composite.slice(sep + 1));
        const arr = vals[composite] ?? Array(12).fill(0);
        for (let m = 0; m < 12; m++) {
          writes.push(
            upsertInventoryBudget(user.uid, activePropertyId, {
              category: budgetKey,
              monthStart: new Date(Date.UTC(y, m, 1)),
              budgetCents: Math.max(0, Math.round(arr[m] * 100)),
            }),
          );
        }
      }
      if (mode !== savedMode) {
        writes.push(updateProperty(user.uid, activePropertyId, { inventoryBudgetMode: mode }));
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

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={bp.eyebrow}
      italic={bp.italic}
      suffix={`· ${MONTHS[month]} ${year}`}
      width={720}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            {bp.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving}>
            {saving ? bp.saving : bp.save}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
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
              <Chip key={m} active={i === month} onClick={() => setMonth(i)}>
                {m}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {YEARS.map((y) => (
              <Chip key={y} active={y === year} onClick={() => setYear(y)}>
                {String(y)}
              </Chip>
            ))}
          </div>
        </div>

        {/* Budget rows */}
        <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 18px' }}>
          {rows.map((row, i) => (
            <div
              key={row.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '40px 1fr 160px',
                gap: 14,
                padding: '14px 0',
                alignItems: 'center',
                borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
              }}
            >
              {row.icon}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.label}
                </span>
                <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {row.section
                    ? (row.section.itemIds.length > 0 ? bp.itemsCount(row.section.itemIds.length) : bp.noItemsYet)
                    : bp.forMonth(MONTHS[month], year)}
                  {row.section && (
                    <>
                      <TextBtn onClick={() => openEditForm(row.section!)}>{bp.edit}</TextBtn>
                      {confirmingRemove === row.section.id ? (
                        <TextBtn warm onClick={() => void removeSection(row.section!.id)}>
                          {bp.confirmRemove}
                        </TextBtn>
                      ) : (
                        <TextBtn onClick={() => setConfirmingRemove(row.section!.id)}>{bp.remove}</TextBtn>
                      )}
                    </>
                  )}
                </span>
              </div>
              <DollarInput value={arrFor(row.key)[month]} onChange={(v) => setVal(row.key, v)} />
            </div>
          ))}

          {/* Add a section */}
          {mode === 'sections' && !formOpen && (
            <div style={{ padding: '12px 0', borderTop: rows.length > 0 ? `1px solid ${T.ruleSoft}` : 'none' }}>
              <TextBtn onClick={openCreateForm} size={13}>
                {bp.addSection}
              </TextBtn>
            </div>
          )}

          {/* Section mini-form (create / edit) */}
          {mode === 'sections' && formOpen && (
            <div style={{ padding: '14px 0 16px', borderTop: `1px solid ${T.ruleSoft}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={bp.sectionNamePh}
                maxLength={60}
                style={textInput}
              />
              <div>
                <Caps size={9}>{bp.whichItems}</Caps>
                <input
                  value={formQuery}
                  onChange={(e) => setFormQuery(e.target.value)}
                  placeholder={bp.searchItems}
                  style={{ ...textInput, height: 32, fontSize: 12.5, margin: '6px 0' }}
                />
                <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${T.ruleSoft}`, borderRadius: 10, padding: 6 }}>
                  {pickerItems.length === 0 && (
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, padding: '8px 6px' }}>{bp.nothingMatches}</div>
                  )}
                  {pickerItems.map((d) => {
                    const on = formItems.has(d.id);
                    return (
                      <label
                        key={d.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px', cursor: 'pointer', borderRadius: 7 }}
                        className="inv-menu-opt"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setFormItems((p) => {
                              const next = new Set(p);
                              if (on) next.delete(d.id);
                              else next.add(d.id);
                              return next;
                            })
                          }
                          style={{ accentColor: T.brand }}
                        />
                        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink }}>{d.name}</span>
                        <span style={{ fontFamily: fonts.sans, fontSize: 10.5, color: T.faint, marginLeft: 'auto' }}>
                          {catLabelFor(lang, d.cat)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="primary" size="sm" onClick={() => void submitSection()} disabled={formBusy || !formName.trim()}>
                  {formBusy ? bp.saving : formId ? bp.saveSection : bp.createSection}
                </Btn>
                <Btn variant="ghost" size="sm" onClick={() => setFormOpen(false)} disabled={formBusy}>
                  {bp.cancel}
                </Btn>
              </div>
            </div>
          )}
        </div>

        {/* Total + copy shortcut */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            padding: '14px 18px',
            background: T.paper,
            border: `1px solid ${T.rule}`,
            borderRadius: 14,
          }}
        >
          <div>
            <Caps>{bp.totalThisMonth}</Caps>
            <div style={{ fontFamily: fonts.sans, fontSize: 30, color: T.ink, letterSpacing: '-0.02em', fontWeight: 600, lineHeight: 1.05, marginTop: 4 }}>
              {fmtMoney(monthTotal)}
            </div>
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, marginTop: 4 }}>{bp.zeroHint}</div>
          </div>
          <Btn variant="ghost" size="md" onClick={copyToYear}>
            {bp.copyToYear(MONTHS[month], year)}
          </Btn>
        </div>
      </div>
    </Overlay>
  );
}

function SectionDot() {
  return (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: 10,
        background: T.ruleSoft,
        border: `1px solid ${T.rule}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
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
        padding: '6px 10px',
        borderRadius: 7,
        cursor: 'pointer',
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        fontFamily: fonts.sans,
        fontSize: 12,
        fontWeight: 600,
        minWidth: 42,
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
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        fontFamily: fonts.sans,
        fontSize: size,
        fontWeight: 600,
        color: warm ? T.warm : T.ink2,
        textDecoration: 'underline',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function DollarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          left: 14,
          top: '50%',
          transform: 'translateY(-50%)',
          fontFamily: fonts.sans,
          fontSize: 18,
          fontWeight: 600,
          color: T.ink2,
        }}
      >
        $
      </span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        style={{
          width: '100%',
          height: 42,
          padding: '0 14px 0 28px',
          borderRadius: 10,
          boxSizing: 'border-box',
          background: T.bg,
          border: `1px solid ${T.rule}`,
          fontFamily: fonts.sans,
          fontSize: 20,
          fontWeight: 600,
          color: T.ink,
          letterSpacing: '-0.02em',
          outline: 'none',
          textAlign: 'right',
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
        flex: 1,
        padding: '14px 16px',
        borderRadius: 12,
        cursor: 'pointer',
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink,
        border: `1px solid ${active ? T.ink : T.rule}`,
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600 }}>{title}</span>
      <span style={{ fontFamily: fonts.sans, fontSize: 11, color: active ? 'rgba(255,255,255,0.7)' : T.ink2, lineHeight: 1.4 }}>{sub}</span>
    </button>
  );
}

const textInput: React.CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 12px',
  borderRadius: 9,
  boxSizing: 'border-box',
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: fonts.sans,
  fontSize: 13.5,
  color: T.ink,
  outline: 'none',
};
