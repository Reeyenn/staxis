'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryCountBatch,
  addInventoryOrder,
  updateInventoryItem,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';
import {
  buildNameToIdMap,
  mergePhotoCounts,
  type PhotoCount,
  type MergedFill,
} from '@/lib/photo-count-merge';
import type { InventoryItem, InventoryCount } from '@/types';
import type { AutoFillItem } from '@/lib/db/ml-inventory-cockpit';

import { T, fonts, statusColor, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { ItemThumb } from '../ItemThumb';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { Overlay } from './Overlay';
import type { DisplayItem } from '../types';
import { t, catLabelFor, type Lang } from '../inv-i18n';

interface CountSheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  items: InventoryItem[];
  display: DisplayItem[];
  autoFill: AutoFillItem[];
  aiMode: 'off' | 'auto' | 'always-on';
}

// A count entry and where its value came from. `manual` = typed by the user
// (or untouched); `ai` = prefilled from the ML prediction; `photo` = filled
// from a shelf photo (carries the model's confidence for visual flagging).
// Precedence on display: manual edit > photo > ai.
type FillSource = 'manual' | 'ai' | 'photo';
type Entry = { value: string; source: FillSource; confidence?: 'high' | 'medium' | 'low' };

// Co-located strings for the count sheet (too specific for inv-i18n).
function csStrings(lang: Lang) {
  return {
    en: {
      title: 'Inventory counting',
      generalInventory: 'General inventory',
      breakfastInventory: 'Breakfast inventory',
      countBoth: 'Count both',
      everything: 'Everything',
      items: 'items',
      countMode: 'Count mode',
      walkTally: 'Walk & tally',
      aiPrefilled: 'AI-prefilled',
      cancel: 'Cancel',
      saving: 'Saving…',
      saveCount: '✓ Save count',
      changeWhatToCount: 'Change what to count',
      progress: 'Progress',
      graduatedFor: (n: number) => `graduated for ${n} items`,
      graduatedHelp: ' — those start prefilled with the prediction. Tap the number to change it. The rest you’ll enter yourself.',
      theModelHas: 'The model has ',
      par: 'par',
      last: 'last',
      predicted: 'Predicted',
      noPredictionYet: 'No prediction yet',
      skip: 'Skip',
      countByPhoto: 'Count by photo',
      photoHint: 'Snap a shelf — we’ll fill the counts for you to review. Nothing saves until you hit Save count.',
      allVisible: 'All visible',
      reading: 'Reading…',
      choosePhoto: '📷 Choose photo',
      saveFailed: 'Saving the count failed. Please try again.',
      noItemsInGroup: 'No items in this group to count.',
      filled: (n: number, total: number) => `Filled ${n} of ${total} item${total === 1 ? '' : 's'}`,
      notRecognized: (n: number) => ` · ${n} not recognized`,
      reviewAndSave: '. Review the numbers and Save.',
      lowConfidence: (n: number) => ` ${n} low-confidence — please verify (flagged in red).`,
      couldntReadPhoto: 'Couldn’t read that photo — try a clearer, well-lit shot.',
      errTooMany: 'Too many items for one photo — scan one shelf or category at a time.',
      errBadImage: 'Couldn’t read that image. Try a clearer, well-lit photo.',
      errRateLimit: 'Too many photo scans this hour — please try again shortly.',
      errUnavailable: 'Photo counting is briefly unavailable — enter counts manually for now.',
      errGeneric: 'Couldn’t count that photo. Please try again.',
    },
    es: {
      title: 'Conteo de inventario',
      generalInventory: 'Inventario general',
      breakfastInventory: 'Inventario de desayuno',
      countBoth: 'Contar ambos',
      everything: 'Todo',
      items: 'artículos',
      countMode: 'Modo de conteo',
      walkTally: 'Recorrer y contar',
      aiPrefilled: 'prellenado por IA',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      saveCount: '✓ Guardar conteo',
      changeWhatToCount: 'Cambiar qué contar',
      progress: 'Progreso',
      graduatedFor: (n: number) => `aprendió ${n} artículos`,
      graduatedHelp: ' — esos vienen prellenados con la predicción. Toca el número para cambiarlo. El resto los ingresas tú.',
      theModelHas: 'El modelo ',
      par: 'par',
      last: 'último',
      predicted: 'Predicho',
      noPredictionYet: 'Sin predicción aún',
      skip: 'Omitir',
      countByPhoto: 'Contar por foto',
      photoHint: 'Toma una foto del estante — llenamos los conteos para que los revises. Nada se guarda hasta que toques Guardar conteo.',
      allVisible: 'Todos visibles',
      reading: 'Leyendo…',
      choosePhoto: '📷 Elegir foto',
      saveFailed: 'No se pudo guardar el conteo. Inténtalo de nuevo.',
      noItemsInGroup: 'No hay artículos en este grupo para contar.',
      filled: (n: number, total: number) => `Llenados ${n} de ${total} artículo${total === 1 ? '' : 's'}`,
      notRecognized: (n: number) => ` · ${n} no reconocidos`,
      reviewAndSave: '. Revisa los números y Guarda.',
      lowConfidence: (n: number) => ` ${n} de baja confianza — verifica (marcados en rojo).`,
      couldntReadPhoto: 'No se pudo leer la foto — intenta una toma más clara y bien iluminada.',
      errTooMany: 'Demasiados artículos para una foto — escanea un estante o categoría a la vez.',
      errBadImage: 'No se pudo leer la imagen. Intenta una foto más clara y bien iluminada.',
      errRateLimit: 'Demasiados escaneos de foto esta hora — inténtalo de nuevo en un momento.',
      errUnavailable: 'El conteo por foto no está disponible por ahora — ingresa los conteos manualmente.',
      errGeneric: 'No se pudo contar esa foto. Inténtalo de nuevo.',
    },
  }[lang];
}

export function CountSheet({ lang, open, onClose, items, display, autoFill, aiMode }: CountSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const cs = csStrings(lang);
  // scope: null shows the "what to count" chooser; a value shows the scoped count.
  const [scope, setScope] = useState<Scope | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saving, setSaving] = useState(false);
  const [mae, setMae] = useState<number | null>(null);

  const autoFillById = useMemo(() => {
    const m = new Map<string, AutoFillItem>();
    for (const f of autoFill) m.set(f.itemId, f);
    return m;
  }, [autoFill]);

  // Load MAE % for the header caption when the sheet opens.
  // Honesty-audit Phase 4: read currentMaeRatioVsMean (the real gate ratio)
  // — the "% off" caption only makes sense as gate ratio, not overfit. May
  // be null for ~7 days post-Phase-2 ship until next weekly retrain
  // populates hyperparameters.mean_observed_rate; we leave the caption
  // empty in that window rather than showing a misleading number.
  useEffect(() => {
    if (!open || !activePropertyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/inventory/ai-status?propertyId=${activePropertyId}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: { currentMaeRatioVsMean: number | null };
        };
        const ratio = json.data?.currentMaeRatioVsMean;
        if (!cancelled && typeof ratio === 'number') setMae(ratio * 100);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [open, activePropertyId]);

  // Show the "what to count" chooser fresh on every open (clear any old entries).
  useEffect(() => {
    if (open) {
      setScope(null);
      setEntries({});
    }
  }, [open]);

  // The items in the chosen scope. Empty until a scope is picked.
  const scopedDisplay = useMemo(
    () => (scope === null ? [] : display.filter((d) => inScope(d.cat, scope))),
    [display, scope],
  );

  // Pick a scope → seed the count inputs for just that subset and proceed.
  // Auto-fill rule (unchanged): off → blank; auto → graduated items prefilled;
  // always-on → any available prediction prefilled.
  const begin = (s: Scope) => {
    const next: Record<string, Entry> = {};
    for (const d of display.filter((d) => inScope(d.cat, s))) {
      const f = autoFillById.get(d.id);
      let prefill = '';
      let auto = false;
      if (f && aiMode !== 'off') {
        const shouldFill = aiMode === 'always-on' || f.graduated;
        if (shouldFill && Number.isFinite(f.predictedCurrentStock)) {
          prefill = String(Math.max(0, Math.round(f.predictedCurrentStock)));
          auto = true;
        }
      }
      next[d.id] = { value: prefill, source: auto ? 'ai' : 'manual' };
    }
    setEntries(next);
    setScope(s);
  };

  const setEntry = (id: string, val: string) =>
    setEntries((prev) => ({ ...prev, [id]: { value: val, source: 'manual' } }));

  // Apply shelf-photo counts onto the entries. Photo overrides an AI prefill on
  // the items it covers; items the photo didn't return are left untouched.
  const applyPhotoFills = (fills: MergedFill[]) =>
    setEntries((prev) => {
      const next: Record<string, Entry> = { ...prev };
      for (const f of fills) next[f.itemId] = { value: f.value, source: 'photo', confidence: f.confidence };
      return next;
    });

  if (!open) return null;

  // STEP 1 — the chooser. Plain modal: just the title + three rows (label +
  // item count). No eyebrow, no property name, no subtext, no category chips.
  if (scope === null) {
    const gN = display.filter((d) => d.cat !== 'breakfast').length;
    const bN = display.filter((d) => d.cat === 'breakfast').length;
    return (
      <Overlay open onClose={onClose} width={560} title={cs.title}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ScopeOption title={cs.generalInventory} n={gN} itemsLabel={cs.items} onPick={() => begin('general')} />
          <ScopeOption title={cs.breakfastInventory} n={bN} itemsLabel={cs.items} onPick={() => begin('breakfast')} />
          <ScopeOption title={cs.countBoth} n={gN + bN} itemsLabel={cs.items} onPick={() => begin('all')} />
        </div>
      </Overlay>
    );
  }

  // STEP 2 — the existing walk-&-tally, scoped to the chosen subset.
  const total = scopedDisplay.length;
  const filled = scopedDisplay.filter((d) => {
    const e = entries[d.id];
    return e && e.value !== '' && !Number.isNaN(Number(e.value));
  }).length;
  const auto = scopedDisplay.filter((d) => entries[d.id]?.source === 'ai').length;
  const pct = total > 0 ? Math.round((100 * filled) / total) : 0;

  const scopeLabel =
    scope === 'general' ? cs.generalInventory : scope === 'breakfast' ? cs.breakfastInventory : cs.everything;
  const cats: InvCat[] =
    scope === 'breakfast'
      ? ['breakfast']
      : scope === 'general'
        ? ['housekeeping', 'maintenance']
        : ['housekeeping', 'maintenance', 'breakfast'];

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setSaving(true);
    try {
      const now = new Date();
      const rows: Array<Omit<InventoryCount, 'id'>> = [];
      const stockUps: Array<{ item: InventoryItem; delta: number }> = [];
      for (const d of scopedDisplay) {
        const e = entries[d.id];
        if (!e || e.value === '') continue;
        const n = Number(e.value);
        if (!Number.isFinite(n)) continue;
        const variance = Number.isFinite(d.estimated) ? n - d.estimated : undefined;
        rows.push({
          propertyId: activePropertyId,
          itemId: d.id,
          itemName: d.name,
          countedStock: n,
          estimatedStock: Number.isFinite(d.estimated) ? d.estimated : undefined,
          variance,
          varianceValue:
            variance !== undefined && d.unitCost > 0 ? variance * d.unitCost : undefined,
          unitCost: d.unitCost || undefined,
          countedAt: now,
          countedBy: user.displayName || user.username || 'team',
        });

        // If counted stock is HIGHER than what was on file, log a restock event.
        // (Means someone received stock between counts and forgot to log it.)
        const delta = n - d.counted;
        if (delta > 0) stockUps.push({ item: d.raw, delta });
      }

      if (rows.length === 0) {
        setSaving(false);
        return;
      }

      // 1. Batch count log.
      await addInventoryCountBatch(user.uid, activePropertyId, rows);

      // 2. Restock events for stock-ups.
      await Promise.all(
        stockUps.map(({ item, delta }) =>
          addInventoryOrder(user.uid, activePropertyId, {
            propertyId: activePropertyId,
            itemId: item.id,
            itemName: item.name,
            quantity: delta,
            unitCost: item.unitCost,
            totalCost: item.unitCost ? item.unitCost * delta : undefined,
            vendorName: item.vendorName,
            orderedAt: null,
            receivedAt: now,
            notes: 'Auto-logged from count (stock-up)',
          }),
        ),
      );

      // 3. Persist new currentStock on each item.
      await Promise.all(
        rows.map((r) =>
          updateInventoryItem(user.uid, activePropertyId, r.itemId, {
            currentStock: r.countedStock,
            lastCountedAt: now,
          }),
        ),
      );

      // 4. Fire-and-forget: ML post-count processing.
      const itemIds = rows.map((r) => r.itemId);
      void fetchWithAuth('/api/inventory/post-count-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, itemIds }),
      }).catch(() => {});

      onClose();
    } catch (err) {
      console.error('[count-sheet] save failed', err);
      alert(cs.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open
      onClose={onClose}
      accent={statusColor.good}
      eyebrow={cs.countMode}
      italic={cs.walkTally}
      suffix={scopeLabel}
      width={920}
      footer={
        <>
          <span
            style={{
              marginRight: 'auto',
              fontFamily: fonts.mono,
              fontSize: 10,
              color: T.dim,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {auto} {cs.aiPrefilled}{mae !== null ? ` · MAE ${mae.toFixed(1)}%` : ''}
          </span>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            {cs.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || filled === 0}>
            {saving ? cs.saving : `${cs.saveCount} · ${filled}/${total}`}
          </Btn>
        </>
      }
    >
      <button
        type="button"
        onClick={() => setScope(null)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 16,
          padding: '5px 11px 5px 8px',
          borderRadius: 8,
          cursor: 'pointer',
          background: T.bg,
          border: `1px solid ${T.rule}`,
          color: T.ink2,
          fontFamily: fonts.sans,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span style={{ fontFamily: fonts.serif, fontStyle: 'italic', fontSize: 15 }}>‹</span>
        {cs.changeWhatToCount}
      </button>

      {/* Progress (moved out of the old full-screen header into the modal body) */}
      <div
        style={{
          background: T.paper,
          border: `1px solid ${T.rule}`,
          borderRadius: 12,
          padding: '14px 18px',
          marginBottom: 18,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <Caps size={9}>{cs.progress} · {scopeLabel}</Caps>
          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2 }}>
            {filled}/{total} · {pct}%
          </span>
        </div>
        <span style={{ display: 'block', height: 6, borderRadius: 6, background: T.ruleSoft, overflow: 'hidden' }}>
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${pct}%`,
              background: statusColor.good,
              borderRadius: 6,
              transition: 'width .25s',
            }}
          />
        </span>
      </div>
        <PhotoCountPanel lang={lang} display={scopedDisplay} pid={activePropertyId} onFills={applyPhotoFills} />

        {auto > 0 && (
          <div
            style={{
              background: T.purpleDim,
              border: `1px solid ${T.purple}33`,
              borderRadius: 12,
              padding: '12px 16px',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginBottom: 22,
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: T.purple,
                color: '#fff',
                fontFamily: fonts.mono,
                fontSize: 11,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              AI
            </span>
            <span
              style={{
                fontFamily: fonts.sans,
                fontSize: 13,
                color: T.ink2,
                flex: 1,
                lineHeight: 1.45,
              }}
            >
              {cs.theModelHas}<b style={{ color: T.ink }}>{cs.graduatedFor(auto)}</b>{cs.graduatedHelp}
            </span>
          </div>
        )}

        {cats.map((cat) => {
          const catItems = scopedDisplay.filter((d) => d.cat === cat);
          if (catItems.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 30 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <CatIcon cat={cat} size={24} />
                <span
                  style={{
                    fontFamily: fonts.sans,
                    fontSize: 15,
                    color: T.ink,
                    fontWeight: 600,
                  }}
                >
                  {catLabelFor(lang, cat)}
                </span>
                <span style={{ flex: 1, height: 1, background: T.rule }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {catItems.map((d) => (
                  <CountRow
                    key={d.id}
                    lang={lang}
                    d={d}
                    entry={entries[d.id] || { value: '', source: 'manual' }}
                    onChange={(v) => setEntry(d.id, v)}
                    autoFill={autoFillById.get(d.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
    </Overlay>
  );
}

function CountRow({
  lang,
  d,
  entry,
  onChange,
  autoFill,
}: {
  lang: Lang;
  d: DisplayItem;
  entry: Entry;
  onChange: (v: string) => void;
  autoFill?: AutoFillItem;
}) {
  const cs = csStrings(lang);
  const expected =
    autoFill && Number.isFinite(autoFill.predictedCurrentStock)
      ? Math.max(0, Math.round(autoFill.predictedCurrentStock))
      : null;
  const valNum = Number(entry.value);
  const variance =
    entry.value !== '' && Number.isFinite(valNum) && expected !== null
      ? valNum - expected
      : null;
  const fill = fillStyle(entry);
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '12px 18px',
        display: 'grid',
        gridTemplateColumns: '40px minmax(180px, 1.4fr) 130px 220px 80px',
        gap: 18,
        alignItems: 'center',
      }}
    >
      <ItemThumb thumb={d.thumb} cat={d.cat} size={36} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 600 }}>
          {d.name}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink3,
            letterSpacing: '0.04em',
          }}
        >
          {cs.par} {d.par} · {cs.last} {d.counted}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {expected !== null ? (
          <>
            <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
              {cs.predicted} <b style={{ color: T.ink }}>{expected}</b>
            </span>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: T.purple,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              AI · ±{(d.burn * 1.4).toFixed(1)}
            </span>
          </>
        ) : (
          <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, fontStyle: 'italic' }}>
            {cs.noPredictionYet}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="number"
            min="0"
            inputMode="decimal"
            value={entry.value}
            // Reject anything that isn't empty or a non-negative decimal in progress.
            // Blocks "-5", "abc", "NaN", scientific notation at type-time so the
            // count we save can't be a negative or non-finite number.
            onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) onChange(v); }}
            placeholder="—"
            style={{
              width: '100%',
              height: 42,
              padding: '0 14px',
              borderRadius: 10,
              boxSizing: 'border-box',
              background: fill.bg,
              border: `1px solid ${fill.border}`,
              fontFamily: fonts.serif,
              fontSize: 20,
              fontStyle: 'italic',
              color: T.ink,
              letterSpacing: '-0.02em',
              outline: 'none',
            }}
          />
          {fill.badge && (
            <span
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                fontFamily: fonts.mono,
                fontSize: 9,
                fontWeight: 600,
                color: fill.badge.color,
                background: `${fill.badge.color}22`,
                padding: '2px 6px',
                borderRadius: 4,
                letterSpacing: '0.08em',
              }}
            >
              {fill.badge.text}
            </span>
          )}
        </div>
        {variance !== null && expected !== null && (
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              fontWeight: 600,
              color: Math.abs(variance) > expected * 0.05 ? statusColor.critical : T.ink2,
            }}
          >
            {variance > 0 ? '+' : ''}
            {variance}
          </span>
        )}
      </div>
      <Btn
        variant="ghost"
        size="sm"
        onClick={() => onChange('')}
        style={{ height: 30, fontSize: 11, padding: '0 10px' }}
      >
        {cs.skip}
      </Btn>
    </div>
  );
}

type FillVisual = { bg: string; border: string; badge: { text: string; color: string } | null };

// Maps an entry's source + confidence to its input styling + corner badge.
// AI = purple AUTO; photo = sage/caramel/warm by confidence, with low
// deliberately loud (warm + ⚠) so a shaky guess is never quietly trusted.
function fillStyle(entry: Entry): FillVisual {
  if (entry.source === 'ai') {
    return { bg: T.purpleDim, border: `${T.purple}44`, badge: { text: 'AUTO', color: T.purple } };
  }
  if (entry.source === 'photo') {
    if (entry.confidence === 'high') return { bg: T.sageDim, border: `${T.sageDeep}44`, badge: { text: 'PHOTO', color: T.sageDeep } };
    if (entry.confidence === 'medium') return { bg: `${T.caramel}14`, border: `${T.caramel}55`, badge: { text: 'PHOTO', color: T.caramelDeep } };
    return { bg: T.warmDim, border: `${T.warm}55`, badge: { text: 'PHOTO ⚠', color: T.warm } };
  }
  return { bg: T.bg, border: T.rule, badge: null };
}

function photoCountErrorFor(lang: Lang, status: number, detail?: string): string {
  const cs = csStrings(lang);
  if (status === 422) return cs.errTooMany;
  if (status === 400) return cs.errBadImage;
  if (status === 429) return cs.errRateLimit;
  if (status === 503) return cs.errUnavailable;
  return detail || cs.errGeneric;
}

function PhotoCountPanel({
  lang,
  display,
  pid,
  onFills,
}: {
  lang: Lang;
  display: DisplayItem[];
  pid: string | null;
  onFills: (fills: MergedFill[]) => void;
}) {
  const cs = csStrings(lang);
  const fileRef = useRef<HTMLInputElement>(null);
  const cats = useMemo(
    () => (['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).filter((c) => display.some((d) => d.cat === c)),
    [display],
  );
  const [scope, setScope] = useState<InvCat | 'all'>(cats[0] ?? 'all');
  const [status, setStatus] = useState<'idle' | 'reading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [lowCount, setLowCount] = useState(0);

  const scoped = scope === 'all' ? display : display.filter((d) => d.cat === scope);

  const handleFile = async (file: File) => {
    if (!pid) return;
    if (scoped.length === 0) {
      setStatus('error');
      setMessage(cs.noItemsInGroup);
      return;
    }
    setStatus('reading');
    setMessage('');
    setLowCount(0);
    try {
      // Scope the item list to the chosen category so we stay well within the
      // route's input budget and keep the Vision cost down (one shelf ≈ one category).
      const resized = await resizeImageForVision(file);
      const res = await fetchWithAuth('/api/inventory/photo-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, imageBase64: resized.base64, mediaType: resized.mediaType, itemNames: scoped.map((d) => d.name) }),
      });
      const json = (await res.json()) as { ok?: boolean; counts?: PhotoCount[]; error?: string; detail?: string };
      if (!res.ok || !json.ok) {
        setStatus('error');
        setMessage(photoCountErrorFor(lang, res.status, json.detail || json.error));
        return;
      }
      const { filled, unmatched } = mergePhotoCounts(json.counts ?? [], buildNameToIdMap(scoped));
      onFills(filled);
      const low = filled.filter((f) => f.confidence === 'low').length;
      setLowCount(low);
      setStatus('done');
      setMessage(
        cs.filled(filled.length, scoped.length) +
          (unmatched.length > 0 ? cs.notRecognized(unmatched.length) : '') +
          cs.reviewAndSave,
      );
    } catch (err) {
      console.error('[photo-count] failed', err);
      setStatus('error');
      setMessage(cs.couldntReadPhoto);
    }
  };

  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '12px 16px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        marginBottom: 22,
      }}
    >
      <span style={{ fontFamily: fonts.serif, fontSize: 17, fontStyle: 'italic', color: T.ink, letterSpacing: '-0.02em' }}>
        {cs.countByPhoto}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, flex: '1 1 200px', minWidth: 0 }}>
        {cs.photoHint}
      </span>
      {cats.length > 1 && (
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as InvCat | 'all')}
          style={{
            height: 34,
            padding: '0 10px',
            borderRadius: 8,
            background: T.bg,
            border: `1px solid ${T.rule}`,
            fontFamily: fonts.sans,
            fontSize: 13,
            color: T.ink,
            cursor: 'pointer',
          }}
        >
          <option value="all">{cs.allVisible}</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {catLabelFor(lang, c)}
            </option>
          ))}
        </select>
      )}
      <Btn variant="ghost" size="md" onClick={() => fileRef.current?.click()} disabled={status === 'reading'}>
        {status === 'reading' ? cs.reading : cs.choosePhoto}
      </Btn>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      {status !== 'idle' && message && (
        <div
          style={{
            flexBasis: '100%',
            fontFamily: fonts.sans,
            fontSize: 12.5,
            color: status === 'error' ? T.warm : lowCount > 0 ? T.caramelDeep : T.forestText,
          }}
        >
          {message}
          {lowCount > 0 && status === 'done' ? cs.lowConfidence(lowCount) : ''}
        </div>
      )}
    </div>
  );
}

// What the count is scoped to: general = housekeeping + maintenance,
// breakfast = food & beverage only, all = everything.
type Scope = 'general' | 'breakfast' | 'all';

function inScope(cat: InvCat, scope: Scope): boolean {
  if (scope === 'all') return true;
  if (scope === 'breakfast') return cat === 'breakfast';
  return cat !== 'breakfast';
}

// One chooser row: serif label on the left, "{n} items" + arrow on the right.
// Deliberately plain — no category chip, no subtext (per the handoff).
function ScopeOption({ title, n, itemsLabel, onPick }: { title: string; n: number; itemsLabel: string; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => { Motion.pop(ref.current, 0.98); onPick(); }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.ink; e.currentTarget.style.background = T.inkWash; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.rule; e.currentTarget.style.background = T.bg; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 15,
        padding: '18px 20px',
        borderRadius: 13,
        cursor: 'pointer',
        background: T.bg,
        border: `1px solid ${T.rule}`,
        textAlign: 'left',
        width: '100%',
      }}
    >
      <Serif size={23} style={{ letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{title}</Serif>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flex: 'none' }}>
        <Serif size={22} color={T.ink2}>{n}</Serif>
        <Caps size={9} color={T.dim}>{itemsLabel}</Caps>
        <Serif size={20} color={T.dim} style={{ marginLeft: 4 }}>→</Serif>
      </span>
    </button>
  );
}
