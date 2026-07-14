'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryCountBatch,
  addInventoryOrder,
  fetchInventoryStockByIds,
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

import { T, fonts, statusColor, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { Overlay } from './Overlay';
import { numGuard } from './form-kit';
import { entriesFingerprint, computeStockUps, unchangedItemIds } from './count-save';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';

interface CountSheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  items: InventoryItem[];
  display: DisplayItem[];
}

// A count entry and where its value came from: typed (`manual`) or filled from
// a reviewed shelf photo (`photo`, carries the model's confidence so the input
// stays tinted). Photo counting is a manual convenience, not an ML prediction.
type FillSource = 'manual' | 'photo';
type Entry = { value: string; source: FillSource; confidence?: 'high' | 'medium' | 'low' };

// One save attempt: the payload computed at first try + per-step completion
// markers, so a retry after a partial failure resumes instead of re-running
// (scan-commit.ts pattern). Pure helpers live in count-save.ts.
type SaveProgress = {
  fp: string;
  now: Date;
  rows: Array<Omit<InventoryCount, 'id'>>;
  stockUps: Array<{ id: string; delta: number; item: InventoryItem }>;
  countedIds: Set<string>;
  orderedIds: Set<string>;
  stockedIds: Set<string>;
};

// A photo result awaiting review — the AI's estimate, adjustable before it
// touches the count.
type ReviewFill = { itemId: string; name: string; value: string; confidence?: 'high' | 'medium' | 'low' };

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
      cancel: 'Cancel',
      back: 'Back',
      saving: 'Saving…',
      saveCount: '✓ Save count',
      changeWhatToCount: 'Change what to count',
      countByPhoto: '📷 Count by photo',
      reading: 'Reading photo…',
      photoCheck: 'Check the photo counts',
      useCounts: 'Use these counts',
      notInPhoto: (n: number) => `${n} item${n === 1 ? '' : 's'} not in the photo`,
      saveFailed: 'Saving the count failed. Please try again.',
      discardConfirm: 'You have unsaved counts. Close and discard them?',
      noItemsInGroup: 'No items to count.',
      errTooMany: 'Too many items for one photo — snap one shelf at a time.',
      errBadImage: 'Couldn’t read that image. Try a clearer, well-lit photo.',
      errRateLimit: 'Too many photo scans this hour — please try again shortly.',
      errUnavailable: 'Photo counting is briefly unavailable — type the counts for now.',
      errGeneric: 'Couldn’t count that photo. Please try again.',
      couldntReadPhoto: 'Couldn’t read that photo — try a clearer, well-lit shot.',
      nothingRecognized: 'Nothing in the photo matched your items — try a closer shot.',
    },
    es: {
      title: 'Conteo de inventario',
      generalInventory: 'Inventario general',
      breakfastInventory: 'Inventario de desayuno',
      countBoth: 'Contar ambos',
      everything: 'Todo',
      items: 'artículos',
      cancel: 'Cancelar',
      back: 'Atrás',
      saving: 'Guardando…',
      saveCount: '✓ Guardar conteo',
      changeWhatToCount: 'Cambiar qué contar',
      countByPhoto: '📷 Contar por foto',
      reading: 'Leyendo foto…',
      photoCheck: 'Revisa los conteos de la foto',
      useCounts: 'Usar estos conteos',
      notInPhoto: (n: number) => `${n} artículo${n === 1 ? '' : 's'} no salen en la foto`,
      saveFailed: 'No se pudo guardar el conteo. Inténtalo de nuevo.',
      discardConfirm: 'Tienes conteos sin guardar. ¿Cerrar y descartarlos?',
      noItemsInGroup: 'No hay artículos para contar.',
      errTooMany: 'Demasiados artículos para una foto — toma un estante a la vez.',
      errBadImage: 'No se pudo leer la imagen. Intenta una foto más clara y bien iluminada.',
      errRateLimit: 'Demasiados escaneos de foto esta hora — inténtalo de nuevo en un momento.',
      errUnavailable: 'El conteo por foto no está disponible por ahora — escribe los conteos.',
      errGeneric: 'No se pudo contar esa foto. Inténtalo de nuevo.',
      couldntReadPhoto: 'No se pudo leer la foto — intenta una toma más clara y bien iluminada.',
      nothingRecognized: 'Nada en la foto coincidió con tus artículos — intenta una toma más cercana.',
    },
  }[lang];
}

export function CountSheet({ lang, open, onClose, items, display }: CountSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const cs = csStrings(lang);
  // scope: null shows the "what to count" chooser; a value shows the count list.
  const [scope, setScope] = useState<Scope | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saving, setSaving] = useState(false);
  // Photo flow: choose photo → AI reads → `review` holds its estimates for the
  // user to adjust before they're applied to the count list.
  const [review, setReview] = useState<ReviewFill[] | null>(null);
  const [reviewMissing, setReviewMissing] = useState(0);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoErr, setPhotoErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Resume bookkeeping across retries of a count (scan-commit.ts pattern):
  // which save steps already landed per item, so a retry after a partial
  // failure never duplicates count rows or stock-up orders. Keyed by an
  // entries fingerprint — editing a number starts a fresh attempt, but the
  // fresh attempt carries completion forward for entries that didn't change.
  const progRef = useRef<SaveProgress | null>(null);

  // Show the "what to count" chooser fresh on every open (clear any old state).
  useEffect(() => {
    if (open) {
      setScope(null);
      setEntries({});
      setReview(null);
      setReviewMissing(0);
      setPhotoBusy(false);
      setPhotoErr('');
      progRef.current = null;
    }
  }, [open]);

  // Guarded close: a stray tap on the dimmed background, an ESC press, or the
  // Cancel/✕ buttons must not silently throw away a count in progress —
  // entries live only in local state and reopen resets them. An unapplied
  // photo review counts as dirty too.
  const requestClose = () => {
    if (saving) return;
    const dirty = Object.values(entries).some((e) => e.value !== '') || review != null;
    if (dirty && !confirm(cs.discardConfirm)) return;
    onClose();
  };

  // The items in the chosen scope. Empty until a scope is picked.
  const scopedDisplay = useMemo(
    () => (scope === null ? [] : display.filter((d) => inScope(d.cat, scope))),
    [display, scope],
  );

  // Pick a scope → seed the count inputs for just that subset and proceed.
  // Counts always start EMPTY. No AI pre-fill.
  const begin = (s: Scope) => {
    const next: Record<string, Entry> = {};
    for (const d of display.filter((d) => inScope(d.cat, s))) {
      next[d.id] = { value: '', source: 'manual' };
    }
    setEntries(next);
    setScope(s);
  };

  const setEntry = (id: string, val: string) =>
    setEntries((prev) => ({ ...prev, [id]: { value: val, source: 'manual' } }));

  // ── Photo → AI estimates → review ──────────────────────────────────
  const handleFile = async (file: File) => {
    if (!activePropertyId) return;
    if (scopedDisplay.length === 0) {
      setPhotoErr(cs.noItemsInGroup);
      return;
    }
    setPhotoBusy(true);
    setPhotoErr('');
    try {
      const resized = await resizeImageForVision(file);
      const res = await fetchWithAuth('/api/inventory/photo-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          imageBase64: resized.base64,
          mediaType: resized.mediaType,
          itemNames: scopedDisplay.map((d) => d.name),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; counts?: PhotoCount[]; error?: string; detail?: string };
      if (!res.ok || !json.ok) {
        setPhotoErr(photoCountErrorFor(lang, res.status, json.detail || json.error));
        return;
      }
      const { filled } = mergePhotoCounts(json.counts ?? [], buildNameToIdMap(scopedDisplay));
      if (filled.length === 0) {
        setPhotoErr(cs.nothingRecognized);
        return;
      }
      const nameOf = new Map(scopedDisplay.map((d) => [d.id, d.name]));
      setReview(filled.map((f: MergedFill) => ({
        itemId: f.itemId,
        name: nameOf.get(f.itemId) ?? f.itemId,
        value: f.value,
        confidence: f.confidence,
      })));
      setReviewMissing(scopedDisplay.length - filled.length);
    } catch (err) {
      console.error('[photo-count] failed', err);
      setPhotoErr(cs.couldntReadPhoto);
    } finally {
      setPhotoBusy(false);
    }
  };

  const setReviewValue = (itemId: string, val: string) =>
    setReview((prev) => prev?.map((r) => (r.itemId === itemId ? { ...r, value: val } : r)) ?? prev);

  const bumpReview = (itemId: string, d: number) =>
    setReview((prev) => prev?.map((r) => {
      if (r.itemId !== itemId) return r;
      const n = Math.max(0, (Number(r.value) || 0) + d);
      return { ...r, value: String(n) };
    }) ?? prev);

  // Apply the reviewed photo counts onto the entries; items the photo didn't
  // cover are left untouched.
  const applyReview = () => {
    if (!review) return;
    setEntries((prev) => {
      const next: Record<string, Entry> = { ...prev };
      for (const r of review) {
        if (r.value === '') continue;
        next[r.itemId] = { value: r.value, source: 'photo', confidence: r.confidence };
      }
      return next;
    });
    setReview(null);
    setReviewMissing(0);
  };

  if (!open) return null;

  // STEP 1 — the chooser. Plain modal: just the title + three rows (label +
  // item count).
  if (scope === null) {
    const gN = display.filter((d) => d.cat !== 'breakfast').length;
    const bN = display.filter((d) => d.cat === 'breakfast').length;
    return (
      <Overlay open onClose={requestClose} width={560} title={cs.title}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ScopeOption title={cs.generalInventory} n={gN} itemsLabel={cs.items} onPick={() => begin('general')} />
          <ScopeOption title={cs.breakfastInventory} n={bN} itemsLabel={cs.items} onPick={() => begin('breakfast')} />
          <ScopeOption title={cs.countBoth} n={gN + bN} itemsLabel={cs.items} onPick={() => begin('all')} />
        </div>
      </Overlay>
    );
  }

  const total = scopedDisplay.length;
  const filled = scopedDisplay.filter((d) => {
    const e = entries[d.id];
    return e && e.value !== '' && !Number.isNaN(Number(e.value));
  }).length;
  const pct = total > 0 ? Math.round((100 * filled) / total) : 0;

  const scopeLabel =
    scope === 'general' ? cs.generalInventory : scope === 'breakfast' ? cs.breakfastInventory : cs.everything;

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setSaving(true);
    try {
      // Resume or fresh attempt? If a previous attempt of the SAME entries
      // partially failed, resume it — skipping the steps that already landed
      // so a retry never duplicates count rows or stock-up orders (which
      // would inflate month spend and feed phantom consumption into the AI).
      const fp = entriesFingerprint(entries);
      let attempt = progRef.current;
      if (!attempt || attempt.fp !== fp) {
        const prev = attempt;
        const now = new Date();
        const rows: Array<Omit<InventoryCount, 'id'>> = [];
        // Counted items we need to check for a possible auto-"stock-up". We defer
        // the delta computation until AFTER a fresh stock re-fetch below — see
        // the double-log fix note.
        const counted: Array<{
          id: string;
          pageLoadStock: number;
          countedStock: number;
          item: InventoryItem;
        }> = [];
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
          counted.push({
            id: d.id,
            pageLoadStock: d.raw.currentStock ?? 0,
            countedStock: n,
            item: d.raw,
          });
        }

        if (rows.length === 0) {
          setSaving(false);
          return;
        }

        // Re-fetch the CURRENT stored stock right before deciding stock-ups. The
        // page-load value (d.counted) goes stale the moment a delivery is logged
        // in-app after the sheet opened: counting against the stale value would
        // re-log the same goods as a phantom "stock-up" order and double-count
        // them into consumption. Comparing against fresh stock closes that. If an
        // item vanished from the fetch (deleted mid-session), fall back to the
        // page-load value so we don't crash — a rare, low-stakes edge.
        const freshStock = await fetchInventoryStockByIds(
          user.uid, activePropertyId, counted.map((c) => c.id),
        );
        // Counted stock HIGHER than what's on file NOW → log a restock event
        // (someone received stock between counts and forgot to log it).
        const stockUps = computeStockUps(counted, freshStock);

        // Editing entries after a PARTIAL failure must not restart from
        // scratch: the previous attempt's completed steps for items whose
        // value didn't change already landed, and re-running them would
        // duplicate count rows and stock-up orders. Carry the previous
        // per-item completion forward for unchanged entries — only items the
        // user actually edited (or newly counted) run fresh.
        const unchanged = prev ? unchangedItemIds(prev.fp, fp) : new Set<string>();
        const carry = (ids: Set<string>) =>
          new Set([...ids].filter((id) => unchanged.has(id)));

        attempt = {
          fp,
          now,
          rows,
          stockUps,
          countedIds: prev ? carry(prev.countedIds) : new Set(),
          orderedIds: prev ? carry(prev.orderedIds) : new Set(),
          stockedIds: prev ? carry(prev.stockedIds) : new Set(),
        };
        progRef.current = attempt;
      }
      // Progress updates are copy-on-write (never mutate the object the ref
      // holds) and re-assigned to the ref after every completed step, so a
      // throw mid-sequence still leaves the completed steps recorded.
      let prog = attempt;
      const now = prog.now;

      // 1. Batch count log — only rows that haven't landed yet. On a plain
      // retry that's all-or-none (the batch insert is atomic); after an
      // edit-then-retry the carried-forward unchanged rows are skipped and
      // only edited/new rows insert.
      const pendingRows = prog.rows.filter((r) => !prog.countedIds.has(r.itemId));
      if (pendingRows.length > 0) {
        await addInventoryCountBatch(user.uid, activePropertyId, pendingRows);
        const countedIds = new Set(prog.countedIds);
        for (const r of pendingRows) countedIds.add(r.itemId);
        prog = { ...prog, countedIds };
        progRef.current = prog;
      }

      // 2. Restock events for stock-ups — per-item resume: record each
      // success so a retry only re-sends the ones that actually failed.
      const pendingOrders = prog.stockUps.filter((s) => !prog.orderedIds.has(s.id));
      const orderResults = await Promise.allSettled(
        pendingOrders.map(({ item, delta }) =>
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
      const orderedIds = new Set(prog.orderedIds);
      orderResults.forEach((r, i) => {
        if (r.status === 'fulfilled') orderedIds.add(pendingOrders[i].id);
      });
      prog = { ...prog, orderedIds };
      progRef.current = prog;
      const orderFailure = orderResults.find((r) => r.status === 'rejected');
      if (orderFailure) throw (orderFailure as PromiseRejectedResult).reason;

      // 3. Persist new currentStock on each item — same per-item resume.
      const pendingStock = prog.rows.filter((r) => !prog.stockedIds.has(r.itemId));
      const stockResults = await Promise.allSettled(
        pendingStock.map((r) =>
          updateInventoryItem(user.uid, activePropertyId, r.itemId, {
            currentStock: r.countedStock,
            lastCountedAt: now,
          }),
        ),
      );
      const stockedIds = new Set(prog.stockedIds);
      stockResults.forEach((r, i) => {
        if (r.status === 'fulfilled') stockedIds.add(pendingStock[i].itemId);
      });
      prog = { ...prog, stockedIds };
      progRef.current = prog;
      const stockFailure = stockResults.find((r) => r.status === 'rejected');
      if (stockFailure) throw (stockFailure as PromiseRejectedResult).reason;

      // 4. Fire-and-forget: ML post-count processing.
      const itemIds = prog.rows.map((r) => r.itemId);
      void fetchWithAuth('/api/inventory/post-count-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, itemIds }),
      }).catch(() => {});

      progRef.current = null;
      onClose();
    } catch (err) {
      console.error('[count-sheet] save failed', err);
      alert(cs.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  // STEP 3 — photo review: the AI's estimates, adjustable, before they touch
  // the count. Same modal shell; its own footer.
  if (review) {
    return (
      <Overlay
        open
        onClose={requestClose}
        accent={statusColor.good}
        italic={cs.photoCheck}
        width={480}
        footer={
          <>
            <span style={{ marginRight: 'auto' }} />
            <Btn variant="ghost" size="md" onClick={() => { setReview(null); setReviewMissing(0); }}>
              {cs.back}
            </Btn>
            <Btn variant="primary" size="md" onClick={applyReview}>
              {cs.useCounts}
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {review.map((r) => {
            const low = r.confidence === 'low';
            return (
              <div
                key={r.itemId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '9px 2px',
                  borderBottom: `1px solid ${T.ruleFaint}`,
                }}
              >
                <span
                  style={{
                    fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink,
                    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {r.name}
                  {low && <span style={{ color: T.warm, marginLeft: 6, fontSize: 12 }}>⚠</span>}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flex: 'none' }}>
                  <StepBtn label="−" onClick={() => bumpReview(r.itemId, -1)} />
                  <input
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={r.value}
                    onChange={(e) => { const v = e.target.value; if (numGuard(v)) setReviewValue(r.itemId, v); }}
                    style={{
                      width: 64, height: 34, borderRadius: 8, boxSizing: 'border-box',
                      textAlign: 'center', outline: 'none',
                      background: low ? T.warmDim : T.bg,
                      border: `1px solid ${low ? `${T.warm}55` : T.rule}`,
                      fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, color: T.ink,
                    }}
                  />
                  <StepBtn label="+" onClick={() => bumpReview(r.itemId, 1)} solid />
                </span>
              </div>
            );
          })}
          {reviewMissing > 0 && (
            <div style={{ paddingTop: 12, textAlign: 'center' }}>
              <Caps size={8.5}>{cs.notInPhoto(reviewMissing)}</Caps>
            </div>
          )}
        </div>
      </Overlay>
    );
  }

  // STEP 2 — the count list. One slim line per item: name + number box.
  // Blank = skipped. Category dividers only when the scope spans more than one.
  const allCats: InvCat[] =
    scope === 'breakfast'
      ? ['breakfast']
      : scope === 'general'
        ? ['housekeeping', 'maintenance']
        : ['housekeeping', 'maintenance', 'breakfast'];
  const cats = allCats.filter((c) => scopedDisplay.some((d) => d.cat === c));
  const showDividers = cats.length > 1;

  return (
    <Overlay
      open
      onClose={requestClose}
      accent={statusColor.good}
      italic={scopeLabel}
      width={520}
      footer={
        <>
          <span style={{ marginRight: 'auto' }} />
          <Btn variant="ghost" size="md" onClick={requestClose} disabled={saving}>
            {cs.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || filled === 0}>
            {saving ? cs.saving : `${cs.saveCount} · ${filled}/${total}`}
          </Btn>
        </>
      }
    >
      {/* Top row: change scope · photo count */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setScope(null)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 11px 5px 8px', borderRadius: 8, cursor: 'pointer',
            background: T.bg, border: `1px solid ${T.rule}`, color: T.ink2,
            fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
          }}
        >
          <span style={{ fontFamily: fonts.sans, fontWeight: 600, fontSize: 15 }}>‹</span>
          {cs.changeWhatToCount}
        </button>
        <Btn variant="teal" size="sm" onClick={() => fileRef.current?.click()} disabled={photoBusy}>
          {photoBusy ? cs.reading : cs.countByPhoto}
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
      </div>
      {photoErr && (
        <div style={{ marginBottom: 10, fontFamily: fonts.sans, fontSize: 12.5, color: T.warm }}>
          {photoErr}
        </div>
      )}

      {/* Slim progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <span style={{ flex: 1, display: 'block', height: 5, borderRadius: 5, background: T.ruleSoft, overflow: 'hidden' }}>
          <span
            style={{
              display: 'block', height: '100%', width: `${pct}%`,
              background: statusColor.good, borderRadius: 5, transition: 'width .25s',
            }}
          />
        </span>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2, flex: 'none' }}>
          {filled}/{total}
        </span>
      </div>

      {cats.map((cat) => (
        <div key={cat}>
          {showDividers && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 2px' }}>
              <Caps size={8.5}>{catLabelFor(lang, cat)}</Caps>
              <span style={{ flex: 1, height: 1, background: T.ruleSoft }} />
            </div>
          )}
          {scopedDisplay.filter((d) => d.cat === cat).map((d) => (
            <CountLine
              key={d.id}
              d={d}
              entry={entries[d.id] || { value: '', source: 'manual' }}
              onChange={(v) => setEntry(d.id, v)}
            />
          ))}
        </div>
      ))}
    </Overlay>
  );
}

// One slim count line: item name + a number box. Nothing else.
function CountLine({
  d,
  entry,
  onChange,
}: {
  d: DisplayItem;
  entry: Entry;
  onChange: (v: string) => void;
}) {
  const fill = fillStyle(entry);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 2px',
        borderBottom: `1px solid ${T.ruleFaint}`,
      }}
    >
      <span
        style={{
          fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink,
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {d.name}
      </span>
      <input
        type="number"
        min="0"
        inputMode="decimal"
        value={entry.value}
        // numGuard blocks "-5", "abc", "NaN", scientific notation at
        // type-time so the count we save can't be negative or non-finite.
        onChange={(e) => { const v = e.target.value; if (numGuard(v)) onChange(v); }}
        placeholder="—"
        style={{
          width: 88, height: 34, borderRadius: 8, boxSizing: 'border-box',
          flex: 'none', textAlign: 'center', outline: 'none',
          background: fill.bg,
          border: `1px solid ${fill.border}`,
          fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, color: T.ink,
          letterSpacing: '-0.02em',
        }}
      />
    </div>
  );
}

// −/+ stepper for the photo review (matches the ledger's quick-count buttons).
function StepBtn({ label, onClick, solid = false }: { label: string; onClick: () => void; solid?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: 8, padding: 0, lineHeight: 1, fontSize: 14,
        fontFamily: fonts.sans, cursor: 'pointer', flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: solid ? '1px solid rgba(92,122,96,.35)' : `1px solid rgba(31,35,28,.12)`,
        background: solid ? T.tealDim : T.bg,
        color: solid ? T.tealText : T.ink,
      }}
    >
      {label}
    </button>
  );
}

type FillVisual = { bg: string; border: string };

// Photo-reviewed values stay tinted by confidence in the count list so it's
// clear which numbers came from the camera (low = loud so a shaky guess is
// never quietly trusted).
function fillStyle(entry: Entry): FillVisual {
  if (entry.source === 'photo') {
    if (entry.confidence === 'high') return { bg: T.sageDim, border: `${T.sageDeep}44` };
    if (entry.confidence === 'medium') return { bg: `${T.caramel}14`, border: `${T.caramel}55` };
    return { bg: T.warmDim, border: `${T.warm}55` };
  }
  return { bg: T.bg, border: T.rule };
}

function photoCountErrorFor(lang: Lang, status: number, detail?: string): string {
  const cs = csStrings(lang);
  if (status === 422) return cs.errTooMany;
  if (status === 400) return cs.errBadImage;
  if (status === 429) return cs.errRateLimit;
  if (status === 503) return cs.errUnavailable;
  return detail || cs.errGeneric;
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
