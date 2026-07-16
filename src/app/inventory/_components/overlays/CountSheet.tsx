'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryItem,
  saveInventoryCountAtomic,
  updateInventoryItem,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { resizeImageForVision } from '@/lib/image-resize';
import { generateId } from '@/lib/utils';
import type { AtomicInventoryCountRow } from '@/lib/inventory-atomic';
import {
  clearInventoryCountAttempt,
  hasDefinitiveDatabaseFailure,
  loadInventoryCountAttempt,
  persistInventoryCountAttempt,
  type FrozenInventoryCountAttempt,
} from '@/lib/inventory-count-attempt';
import {
  buildNameToIdMap,
  mergePhotoCounts,
  type PhotoCount,
  type MergedFill,
} from '@/lib/photo-count-merge';
import type { InventoryItem, InventoryCustomCategory, InventoryTabLayout } from '@/types';

import { T, fonts, statusColor, inBucket, type InvCat, type StockBucket } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { toDisplayItem } from '../adapter';
import { Overlay } from './Overlay';
import { numGuard } from './form-kit';
import {
  clearInlineAddAttempt,
  createFrozenInlineAddAttempt,
  entriesFingerprint,
  findInlineAddCommittedItem,
  inlineAddAttemptMarker,
  loadInlineAddAttempt,
  persistInlineAddAttempt,
  type FrozenInlineAddAttempt,
  type InlineAddScope,
} from './count-save';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';

interface CountSheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  items: InventoryItem[];
  display: DisplayItem[];
  /** Hotel-defined custom category tabs (0307) — countable scopes. */
  customCategories: InventoryCustomCategory[];
  /** Tab layout (0308) — respects hidden built-ins + order for the chooser. */
  tabLayout: InventoryTabLayout;
}

// A count entry and where its value came from: typed (`manual`) or filled from
// a reviewed shelf photo (`photo`, carries the model's confidence so the input
// stays tinted). Photo counting is a manual convenience, not an ML prediction.
type FillSource = 'manual' | 'photo';
type Entry = { value: string; source: FillSource; confidence?: 'high' | 'medium' | 'low' };

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
      everything: 'Everything',
      items: 'items',
      cancel: 'Cancel',
      back: 'Back',
      saving: 'Saving…',
      saveCount: '✓ Save count',
      retryCount: 'Retry exact count',
      retryPending: 'The result could not be confirmed. This exact count is locked until it is retried, so its history cannot be duplicated.',
      changeWhatToCount: 'Change what to count',
      countByPhoto: '📷 Count by photo',
      reading: 'Reading photo…',
      photoCheck: 'Check the photo counts',
      useCounts: 'Use these counts',
      notInPhoto: (n: number) => `${n} item${n === 1 ? '' : 's'} not in the photo`,
      saveFailed: 'Saving the count failed. Please try again.',
      stockChanged: 'Inventory changed while this count was open. Nothing was saved—close, refresh, and recount so a newer count or delivery is not overwritten.',
      discardConfirm: 'You have unsaved counts. Close and discard them?',
      noItemsInGroup: 'No items to count.',
      errTooMany: 'Too many items for one photo — snap one shelf at a time.',
      errBadImage: 'Couldn’t read that image. Try a clearer, well-lit photo.',
      errRateLimit: 'Too many photo scans this hour — please try again shortly.',
      errUnavailable: 'Photo counting is briefly unavailable — type the counts for now.',
      errGeneric: 'Couldn’t count that photo. Please try again.',
      couldntReadPhoto: 'Couldn’t read that photo — try a clearer, well-lit shot.',
      nothingRecognized: 'Nothing in the photo matched your items — try a closer shot.',
      addItem: 'Add an item',
      fName: 'Name',
      fNamePh: 'e.g. Orange juice',
      fCount: 'Count',
      fPar: 'Par level',
      fCost: 'Unit cost',
      optional: 'optional',
      addBtn: 'Add',
      addFailed: 'Couldn’t add the item. Please try again.',
      addUnsafe: 'This item was not sent because its recovery copy could not be saved safely. Your fields are still here.',
      addUnconfirmed: 'The result could not be confirmed. These exact item fields are saved, and another insert is blocked while inventory checks for the tagged row.',
      addChecking: 'Checking exact item…',
    },
    es: {
      title: 'Conteo de inventario',
      generalInventory: 'Inventario general',
      breakfastInventory: 'Inventario de desayuno',
      everything: 'Todo',
      items: 'artículos',
      cancel: 'Cancelar',
      back: 'Atrás',
      saving: 'Guardando…',
      saveCount: '✓ Guardar conteo',
      retryCount: 'Reintentar el mismo conteo',
      retryPending: 'No se pudo confirmar el resultado. Este conteo exacto está bloqueado hasta reintentarlo para que no se duplique el historial.',
      changeWhatToCount: 'Cambiar qué contar',
      countByPhoto: '📷 Contar por foto',
      reading: 'Leyendo foto…',
      photoCheck: 'Revisa los conteos de la foto',
      useCounts: 'Usar estos conteos',
      notInPhoto: (n: number) => `${n} artículo${n === 1 ? '' : 's'} no salen en la foto`,
      saveFailed: 'No se pudo guardar el conteo. Inténtalo de nuevo.',
      stockChanged: 'El inventario cambió mientras este conteo estaba abierto. No se guardó nada—cierra, actualiza y vuelve a contar para no sobrescribir un conteo o una entrega más reciente.',
      discardConfirm: 'Tienes conteos sin guardar. ¿Cerrar y descartarlos?',
      noItemsInGroup: 'No hay artículos para contar.',
      errTooMany: 'Demasiados artículos para una foto — toma un estante a la vez.',
      errBadImage: 'No se pudo leer la imagen. Intenta una foto más clara y bien iluminada.',
      errRateLimit: 'Demasiados escaneos de foto esta hora — inténtalo de nuevo en un momento.',
      errUnavailable: 'El conteo por foto no está disponible por ahora — escribe los conteos.',
      errGeneric: 'No se pudo contar esa foto. Inténtalo de nuevo.',
      couldntReadPhoto: 'No se pudo leer la foto — intenta una toma más clara y bien iluminada.',
      nothingRecognized: 'Nada en la foto coincidió con tus artículos — intenta una toma más cercana.',
      addItem: 'Agregar un artículo',
      fName: 'Nombre',
      fNamePh: 'ej. Jugo de naranja',
      fCount: 'Conteo',
      fPar: 'Nivel par',
      fCost: 'Costo unitario',
      optional: 'opcional',
      addBtn: 'Agregar',
      addFailed: 'No se pudo agregar el artículo. Inténtalo de nuevo.',
      addUnsafe: 'Este artículo no se envió porque no se pudo guardar una copia segura para recuperarlo. Tus datos siguen aquí.',
      addUnconfirmed: 'No se pudo confirmar el resultado. Estos datos exactos están guardados y se bloqueó otra inserción mientras el inventario busca la fila marcada.',
      addChecking: 'Verificando el artículo…',
    },
  }[lang];
}

export function CountSheet({ lang, open, onClose, items, display, customCategories, tabLayout }: CountSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const cs = csStrings(lang);
  // scope: null shows the "what to count" chooser; a StockBucket shows the count
  // list for that tab. Mirrors the ledger's tabs — general/breakfast/custom:<id>
  // or 'all' (Count everything) — via the shared inBucket().
  const [scope, setScope] = useState<StockBucket | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saving, setSaving] = useState(false);
  const [retryLocked, setRetryLocked] = useState(false);
  // Items created via the inline "Add item" form during this count session.
  // `extra` is the local optimistic copy (merged into scopedDisplay until
  // realtime echoes the real row into the `display` prop); `createdIdsRef`
  // marks them so handleSave never mistakes a just-catalogued item for a
  // received stock-up (which would fabricate a phantom order + inflate spend).
  const [extra, setExtra] = useState<DisplayItem[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addQty, setAddQty] = useState('');
  const [addPar, setAddPar] = useState('');
  const [addCost, setAddCost] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addRetryLocked, setAddRetryLocked] = useState(false);
  const createdIdsRef = useRef<Set<string>>(new Set());
  // Freeze each item's authoritative stock when its count scope begins. A
  // realtime delivery arriving after the employee starts counting must make
  // Save conflict; rebuilding expectedStock from the later realtime render
  // would incorrectly treat the stale physical observation as current and
  // could erase the received quantity.
  const stockBaselineRef = useRef<Map<string, number>>(new Map());
  // Photo flow: choose photo → AI reads → `review` holds its estimates for the
  // user to adjust before they're applied to the count list.
  const [review, setReview] = useState<ReviewFill[] | null>(null);
  const [reviewMissing, setReviewMissing] = useState(0);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoErr, setPhotoErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Same-entry retries reuse this attempt's request UUID. The database owns
  // both the count-history inserts and stock updates in one transaction.
  const progRef = useRef<FrozenInventoryCountAttempt | null>(null);
  const inlineAddAttemptRef = useRef<FrozenInlineAddAttempt | null>(null);
  // Synchronous re-entrancy lock for handleAdd — `addBusy` state lags the insert
  // by a render, so a fast double-click / Enter would otherwise create two rows.
  const addLockRef = useRef(false);

  // Collapse + clear the inline add form. Does NOT clear `extra`/`createdIds`
  // (those persist for the whole count session; only a fresh open resets them),
  // so a created item survives a scope change instead of vanishing before the
  // realtime echo lands.
  const resetAddForm = () => {
    setAddOpen(false);
    setAddName('');
    setAddQty('');
    setAddPar('');
    setAddCost('');
  };

  // Resolve an inline add exactly once. A successful direct response supplies
  // the row id immediately; after an ambiguous response, realtime finds the
  // same row by the frozen request marker stored in `notes`.
  const finishInlineAdd = useCallback((attempt: FrozenInlineAddAttempt, raw: InventoryItem) => {
    if (inlineAddAttemptRef.current?.requestId !== attempt.requestId) return;
    inlineAddAttemptRef.current = null;
    clearInlineAddAttempt(attempt.propertyId);
    setAddRetryLocked(false);
    addLockRef.current = false;
    createdIdsRef.current.add(raw.id);
    stockBaselineRef.current.set(raw.id, attempt.quantity);
    const d = toDisplayItem(raw, {
      occupancy: null,
      dailyAverages: null,
      mlRateMap: new Map(),
      autoFillGraduated: new Set(),
    });
    setExtra((prev) => prev.some((item) => item.id === d.id) ? prev : [...prev, d]);
    setEntries((prev) => ({
      ...prev,
      [raw.id]: { value: attempt.quantityInput, source: 'manual' },
    }));
    setAddOpen(false);
    setAddName('');
    setAddQty('');
    setAddPar('');
    setAddCost('');

    // The marker is only a recovery key. Clearing it is an idempotent metadata
    // cleanup; a failure merely leaves an internal marker, never a duplicate.
    if (user) {
      void updateInventoryItem(user.uid, attempt.propertyId, raw.id, { notes: '' })
        .catch((err) => console.error('[count-sheet] inline add marker cleanup failed', err));
    }
  }, [user]);

  // Show a fresh chooser, unless a prior response was ambiguous. In that case
  // restore the immutable UUID + payload and expose only an exact retry.
  useEffect(() => {
    if (open) {
      const restored = activePropertyId
        ? loadInventoryCountAttempt(activePropertyId)
        : null;
      const restoredAdd = activePropertyId
        ? loadInlineAddAttempt(activePropertyId)
        : null;
      setScope(restored ? 'all' : restoredAdd?.scope ?? null);
      setEntries({});
      setReview(null);
      setReviewMissing(0);
      setPhotoBusy(false);
      setPhotoErr('');
      progRef.current = restored;
      setRetryLocked(!!restored);
      inlineAddAttemptRef.current = restoredAdd;
      setAddRetryLocked(!!restoredAdd);
      setExtra([]);
      setAddOpen(!!restoredAdd);
      setAddName(restoredAdd?.nameInput ?? '');
      setAddQty(restoredAdd?.quantityInput ?? '');
      setAddPar(restoredAdd?.parInput ?? '');
      setAddCost(restoredAdd?.costInput ?? '');
      createdIdsRef.current = new Set();
      stockBaselineRef.current = new Map(
        restored?.rows.map((row) => [row.itemId, row.expectedStock]) ?? [],
      );
      if (restored) {
        setScope('all');
        setEntries(Object.fromEntries(restored.rows.map((row) => [
          row.itemId,
          { value: String(row.countedStock), source: 'manual' as const },
        ])));
      }
    }
  }, [open, activePropertyId]);

  // A committed insert with a dropped response is identified by its unique
  // marker as soon as the authoritative inventory subscription includes it.
  useEffect(() => {
    if (!open || !activePropertyId) return;
    const attempt = inlineAddAttemptRef.current;
    if (!attempt || attempt.propertyId !== activePropertyId) return;
    const committed = findInlineAddCommittedItem(attempt, items);
    if (committed) finishInlineAdd(attempt, committed);
  }, [open, activePropertyId, items, finishInlineAdd]);

  // Guarded close: a stray tap on the dimmed background, an ESC press, or the
  // Cancel/✕ buttons must not silently throw away a count in progress —
  // entries live only in local state and reopen resets them. An unapplied
  // photo review counts as dirty too.
  const requestClose = () => {
    if (saving || retryLocked || addRetryLocked) return;
    const dirty = Object.values(entries).some((e) => e.value !== '')
      || review != null
      || (addOpen && (addName.trim() !== '' || addQty !== '' || addPar !== '' || addCost !== ''));
    if (dirty && !confirm(cs.discardConfirm)) return;
    onClose();
  };

  // The items in the chosen scope. Empty until a scope is picked. Items created
  // in-sheet (`extra`) are merged in and deduped by id — once realtime echoes
  // the real row into `display`, the prop version wins (same id), so there's no
  // double render.
  const scopedDisplay = useMemo(() => {
    if (scope === null) return [];
    const byId = new Map<string, DisplayItem>();
    for (const d of extra) byId.set(d.id, d);
    for (const d of display) byId.set(d.id, d);
    return [...byId.values()].filter((d) => inBucket(d, scope));
  }, [display, extra, scope]);

  // The countable scopes = the hotel's VISIBLE tabs (built-ins minus any hidden
  // via the tab editor, plus every custom tab), ordered like the ledger's tabs.
  // "Count everything" ('all') is offered separately below.
  const scopeOptions = useMemo(() => {
    const hidden = new Set(tabLayout.hidden);
    const opts: Array<{ bucket: StockBucket; label: string }> = [];
    if (!hidden.has('general')) opts.push({ bucket: 'general', label: cs.generalInventory });
    if (!hidden.has('breakfast')) opts.push({ bucket: 'breakfast', label: cs.breakfastInventory });
    for (const c of customCategories) opts.push({ bucket: `custom:${c.id}` as StockBucket, label: c.name });
    const orderIndex = new Map(tabLayout.order.map((k, i) => [k, i]));
    opts.sort((a, b) => (orderIndex.get(a.bucket) ?? 999) - (orderIndex.get(b.bucket) ?? 999));
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cs strings stable per lang
  }, [tabLayout, customCategories, lang]);

  const bucketLabel = (b: StockBucket): string =>
    b === 'all' ? cs.everything : scopeOptions.find((o) => o.bucket === b)?.label ?? cs.everything;

  // Pick a scope → seed the count inputs for just that subset and proceed.
  // Counts always start EMPTY. No AI pre-fill.
  const begin = (s: StockBucket) => {
    if (retryLocked || addRetryLocked) return;
    const next: Record<string, Entry> = {};
    for (const d of display.filter((d) => inBucket(d, s))) {
      next[d.id] = { value: '', source: 'manual' };
      stockBaselineRef.current.set(d.id, d.raw.currentStock ?? 0);
    }
    // Keep any in-sheet created items that belong to this scope (and their typed
    // count) so switching scope doesn't lose a just-added item before realtime
    // echoes it into `display`.
    for (const d of extra) {
      if (inBucket(d, s)) next[d.id] = entries[d.id] ?? { value: '', source: 'manual' };
    }
    resetAddForm();
    setEntries(next);
    setScope(s);
  };

  // Create a brand-new item from the inline "Add item" form and drop it into the
  // count list immediately (with an optional pre-typed count). Created with
  // currentStock = the typed count so its on-hand reads right away; its id is
  // recorded in createdIdsRef so Save never fabricates a stock-up order for it.
  const handleAdd = async () => {
    if (!user || !activePropertyId || retryLocked || addRetryLocked
      || inlineAddAttemptRef.current || addBusy || addLockRef.current) return;
    if (!addName.trim()) return;
    // The durable helper predates hotel-defined tabs, so freeze their built-in
    // category in its supported scope and keep the selected custom tab id as a
    // separate immutable value for this one insert.
    const attemptScope: InlineAddScope = scope === 'breakfast'
      ? 'breakfast'
      : scope === 'all'
        ? 'all'
        : 'general';
    const customCategoryId = typeof scope === 'string' && scope.startsWith('custom:')
      ? scope.slice(7)
      : null;
    const attempt = createFrozenInlineAddAttempt({
      propertyId: activePropertyId,
      requestId: generateId(),
      startedAt: new Date().toISOString(),
      scope: attemptScope,
      nameInput: addName,
      quantityInput: addQty,
      parInput: addPar,
      costInput: addCost,
    });
    addLockRef.current = true;
    inlineAddAttemptRef.current = attempt;
    setAddBusy(true);
    try {
      try {
        persistInlineAddAttempt(attempt);
      } catch (err) {
        console.error('[count-sheet] inline add recovery persistence failed', err);
        inlineAddAttemptRef.current = null;
        setAddRetryLocked(false);
        alert(cs.addUnsafe);
        return;
      }
      setAddRetryLocked(true);
      const id = await addInventoryItem(user.uid, activePropertyId, {
        name: attempt.name,
        category: attempt.category,
        customCategoryId,
        currentStock: attempt.quantity,
        parLevel: attempt.parLevel,
        unitCost: attempt.unitCost ?? undefined,
        unit: 'each',
        reorderLeadDays: 3,
        notes: inlineAddAttemptMarker(attempt.requestId),
        lastCountedAt: attempt.quantity > 0 ? new Date(attempt.startedAt) : null,
        propertyId: activePropertyId,
      });
      const raw: InventoryItem = {
        id,
        propertyId: activePropertyId,
        name: attempt.name,
        category: attempt.category,
        customCategoryId,
        currentStock: attempt.quantity,
        parLevel: attempt.parLevel,
        unit: 'each',
        reorderLeadDays: 3,
        unitCost: attempt.unitCost ?? undefined,
        notes: inlineAddAttemptMarker(attempt.requestId),
        updatedAt: null,
        lastCountedAt: attempt.quantity > 0 ? new Date(attempt.startedAt) : null,
      };
      finishInlineAdd(attempt, raw);
    } catch (err) {
      console.error('[count-sheet] add item failed', err);
      // Realtime may have resolved a committed insert just before the rejected
      // response reached this catch. In that case there is no failure left to
      // release or report.
      if (inlineAddAttemptRef.current?.requestId !== attempt.requestId) return;
      if (hasDefinitiveDatabaseFailure(err)) {
        clearInlineAddAttempt(attempt.propertyId);
        inlineAddAttemptRef.current = null;
        setAddRetryLocked(false);
        alert(cs.addFailed);
      } else {
        // Unknown outcome: preserve the exact fields and marker, and never send
        // another insert. Realtime will call finishInlineAdd if it committed.
        setAddRetryLocked(true);
        alert(cs.addUnconfirmed);
      }
    } finally {
      addLockRef.current = false;
      setAddBusy(false);
    }
  };

  const setEntry = (id: string, val: string) => {
    if (retryLocked || addRetryLocked) return;
    setEntries((prev) => ({ ...prev, [id]: { value: val, source: 'manual' } }));
  };

  // ── Photo → AI estimates → review ──────────────────────────────────
  const handleFile = async (file: File) => {
    if (!activePropertyId || retryLocked || addRetryLocked) return;
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

  const setReviewValue = (itemId: string, val: string) => {
    if (retryLocked || addRetryLocked) return;
    setReview((prev) => prev?.map((r) => (r.itemId === itemId ? { ...r, value: val } : r)) ?? prev);
  };

  const bumpReview = (itemId: string, d: number) => {
    if (retryLocked || addRetryLocked) return;
    setReview((prev) => prev?.map((r) => {
      if (r.itemId !== itemId) return r;
      const n = Math.max(0, (Number(r.value) || 0) + d);
      return { ...r, value: String(n) };
    }) ?? prev);
  };

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

  // STEP 1 — the chooser: one row per visible tab (General / Breakfast / each
  // custom tab), plus "Count everything". "Everything" always appears when a
  // single tab wouldn't cover every item (multiple tabs, or items whose tab is
  // hidden) so nothing is ever un-countable.
  if (scope === null) {
    const showEverything = scopeOptions.length !== 1
      || display.some((d) => !inBucket(d, scopeOptions[0].bucket));
    return (
      <Overlay open onClose={requestClose} width={560} title={cs.title}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {scopeOptions.map((o) => (
            <ScopeOption
              key={o.bucket}
              title={o.label}
              n={display.filter((d) => inBucket(d, o.bucket)).length}
              itemsLabel={cs.items}
              onPick={() => begin(o.bucket)}
            />
          ))}
          {showEverything && (
            <ScopeOption title={cs.everything} n={display.length} itemsLabel={cs.items} onPick={() => begin('all')} />
          )}
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

  const scopeLabel = bucketLabel(scope);

  const handleSave = async () => {
    if (!user || !activePropertyId || saving || addRetryLocked) return;
    setSaving(true);
    let submittedPropertyId = activePropertyId;
    let submittedRequestId: string | null = null;
    try {
      const fp = entriesFingerprint(entries);
      let attempt = progRef.current;
      if (!retryLocked && (!attempt || attempt.fingerprint !== fp)) {
        const countedAt = new Date().toISOString();
        const rows: AtomicInventoryCountRow[] = [];
        for (const d of scopedDisplay) {
          const e = entries[d.id];
          if (!e || e.value === '') continue;
          const n = Number(e.value);
          if (!Number.isFinite(n)) continue;
          // A first-ever count establishes the baseline. Passing no estimate
          // prevents the database from fabricating a shrinkage variance.
          const isNew = createdIdsRef.current.has(d.id);
          const hadPriorCount = !isNew && d.lastCountedAt != null;
          rows.push({
            itemId: d.id,
            expectedStock: stockBaselineRef.current.get(d.id) ?? (d.raw.currentStock ?? 0),
            countedStock: n,
            estimatedStock: hadPriorCount && Number.isFinite(d.estimated) ? d.estimated : undefined,
          });
        }

        if (rows.length === 0) {
          return;
        }
        attempt = {
          version: 1,
          propertyId: activePropertyId,
          fingerprint: fp,
          requestId: generateId(),
          countedAt,
          countedBy: user.displayName || user.username || 'team',
          rows,
        };
        progRef.current = attempt;
      }
      if (!attempt) {
        setRetryLocked(false);
        return;
      }
      submittedPropertyId = attempt.propertyId;
      submittedRequestId = attempt.requestId;

      persistInventoryCountAttempt(attempt);
      setRetryLocked(true);

      await saveInventoryCountAtomic(
        user.uid,
        attempt.propertyId,
        attempt.requestId,
        new Date(attempt.countedAt),
        attempt.countedBy,
        attempt.rows,
      );

      // The transaction has committed both stock and history. Learning is
      // intentionally non-blocking; its sweep can recover a missed request.
      const itemIds = attempt.rows.map((r) => r.itemId);
      void fetchWithAuth('/api/inventory/post-count-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: attempt.propertyId, itemIds }),
      }).catch(() => {});

      clearInventoryCountAttempt(attempt.propertyId);
      // A property switch can restore another hotel's attempt while this RPC
      // is in flight. Only retire/close the sheet still owned by this request.
      if (progRef.current?.requestId === attempt.requestId) {
        progRef.current = null;
        setRetryLocked(false);
        onClose();
      }
    } catch (err) {
      console.error('[count-sheet] save failed', err);
      if (hasDefinitiveDatabaseFailure(err, retryLocked)) {
        clearInventoryCountAttempt(submittedPropertyId);
        if (!submittedRequestId || progRef.current?.requestId === submittedRequestId) {
          progRef.current = null;
          setRetryLocked(false);
        }
      } else if (progRef.current?.requestId === submittedRequestId) {
        setRetryLocked(true);
      }
      alert((err as { code?: unknown })?.code === '40001' ? cs.stockChanged : cs.saveFailed);
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
  // Blank = skipped. Group by whatever built-in categories are actually present
  // in the scope (a custom tab's items keep their built-in category for the
  // icon/divider); dividers only when more than one category is present.
  const cats = (['housekeeping', 'maintenance', 'breakfast'] as InvCat[])
    .filter((c) => scopedDisplay.some((d) => d.cat === c));
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
          <Btn variant="ghost" size="md" onClick={requestClose} disabled={saving || retryLocked || addRetryLocked}>
            {cs.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || addRetryLocked || (!retryLocked && filled === 0)}>
            {saving ? cs.saving : retryLocked ? cs.retryCount : `${cs.saveCount} · ${filled}/${total}`}
          </Btn>
        </>
      }
    >
      {retryLocked && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 9, background: T.warmDim, color: T.warm, fontFamily: fonts.sans, fontSize: 12.5 }}>
          {cs.retryPending}
        </div>
      )}
      {addRetryLocked && !addBusy && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 9, background: T.warmDim, color: T.warm, fontFamily: fonts.sans, fontSize: 12.5 }}>
          {cs.addUnconfirmed}
        </div>
      )}
      {/* Top row: change scope · photo count */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => { setScope(null); resetAddForm(); }}
          disabled={retryLocked || addRetryLocked}
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
        <Btn variant="teal" size="sm" onClick={() => fileRef.current?.click()} disabled={photoBusy || retryLocked || addRetryLocked}>
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

      {/* Add an item mid-count — collapsed button that drops down into a small
          form (name + count, optional par + unit cost). Created on Add and
          appears in the list right below, ready to keep counting. */}
      {!retryLocked && <div style={{ margin: '12px 0 2px' }}>
        {!addOpen ? (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            style={{
              width: '100%', height: 38, borderRadius: 10, cursor: 'pointer',
              background: T.bg, border: `1px dashed ${T.rule}`, color: T.ink2,
              fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>＋</span>{cs.addItem}
          </button>
        ) : (
          <div
            style={{
              padding: 12, borderRadius: 12, background: T.inkWash,
              border: `1px solid ${T.rule}`, display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            <AddField label={cs.fName}>
              <input
                autoFocus={!addRetryLocked}
                type="text"
                value={addName}
                disabled={addRetryLocked}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && addName.trim() && !addBusy && !addRetryLocked) { e.preventDefault(); void handleAdd(); } }}
                placeholder={cs.fNamePh}
                style={addInputStyle}
              />
            </AddField>
            <div style={{ display: 'flex', gap: 8 }}>
              <AddField label={cs.fCount}>
                <input
                  type="number" min="0" inputMode="decimal" value={addQty}
                  disabled={addRetryLocked}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) setAddQty(v); }}
                  placeholder="—" style={addInputStyle}
                />
              </AddField>
              <AddField label={cs.fPar} hint={cs.optional}>
                <input
                  type="number" min="0" inputMode="decimal" value={addPar}
                  disabled={addRetryLocked}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) setAddPar(v); }}
                  placeholder="—" style={addInputStyle}
                />
              </AddField>
              <AddField label={cs.fCost} hint={cs.optional}>
                <input
                  type="number" min="0" step="0.01" inputMode="decimal" value={addCost}
                  disabled={addRetryLocked}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) setAddCost(v); }}
                  placeholder="0.00" style={addInputStyle}
                />
              </AddField>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" size="sm" onClick={resetAddForm} disabled={addBusy || addRetryLocked}>{cs.cancel}</Btn>
              <Btn variant="primary" size="sm" onClick={() => void handleAdd()} disabled={addBusy || addRetryLocked || !addName.trim()}>
                {addRetryLocked ? cs.addChecking : addBusy ? cs.saving : cs.addBtn}
              </Btn>
            </div>
          </div>
        )}
      </div>}

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
              disabled={retryLocked || addRetryLocked}
            />
          ))}
        </div>
      ))}
    </Overlay>
  );
}

// Compact input for the inline add-item form (matches the sheet's density).
const addInputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 11px', borderRadius: 8, boxSizing: 'border-box',
  background: T.bg, border: `1px solid ${T.rule}`, outline: 'none',
  fontFamily: fonts.sans, fontSize: 13.5, color: T.ink,
};

// A tiny labelled field for the inline add-item form: a caps label (with an
// optional "optional" hint) stacked over its input.
function AddField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <Caps size={8.5}>{label}</Caps>
        {hint && <span style={{ fontFamily: fonts.sans, fontSize: 9, color: T.faint }}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

// One slim count line: item name + a number box. Nothing else.
function CountLine({
  d,
  entry,
  onChange,
  disabled = false,
}: {
  d: DisplayItem;
  entry: Entry;
  onChange: (v: string) => void;
  disabled?: boolean;
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
        disabled={disabled}
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
