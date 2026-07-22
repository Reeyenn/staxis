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
import { SetAsideTag } from '../SetAsideTag';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { toDisplayItem } from '../adapter';
import { Overlay, useOverlayPresence } from './Overlay';
import { intGuard, numGuard, warnBannerStyle } from './form-kit';
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
import { catLabelFor, setAsideTip, type Lang } from '../inv-i18n';
import {
  clearInventoryOverlayDraft,
  loadInventoryOverlayDraft,
  persistInventoryOverlayDraft,
} from './inventory-overlay-draft';
import overlayStyles from './Overlay.module.css';

interface CountSheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  /** Month close launches a full count directly; ordinary counts keep the
   * category chooser. Durable retry attempts always take precedence. */
  startWithAll?: boolean;
  /** A month-end count must cover every active item in one atomic session. */
  requireComplete?: boolean;
  /** Called after the count transaction commits; cancel still uses onClose. */
  onSaved?: () => void;
  /** Controls whether inline item discovery may capture/submit a unit cost. */
  canViewFinancials?: boolean;
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

interface CountOverlayDraft {
  scope: StockBucket | null;
  entries: Record<string, Entry>;
  baselines: Record<string, number>;
  review: ReviewFill[] | null;
  reviewMissing: number;
  addOpen: boolean;
  addName: string;
  addQty: string;
  addPar: string;
  addCost: string;
  addSetAside: string;
  addVendor: string;
  addCategory: InvCat;
  addCustomCategoryId: string | null;
  addOpeningAdjustmentConfirmed: boolean;
  createdIds: string[];
}

function validCountDraft(value: unknown): CountOverlayDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<CountOverlayDraft>;
  const validScope = draft.scope === null
    || draft.scope === 'all'
    || draft.scope === 'general'
    || draft.scope === 'breakfast'
    || (typeof draft.scope === 'string' && /^custom:.+/.test(draft.scope));
  if (
    !validScope
    || !draft.entries || typeof draft.entries !== 'object'
    || !draft.baselines || typeof draft.baselines !== 'object'
    || (draft.review !== null && !Array.isArray(draft.review))
    || typeof draft.reviewMissing !== 'number'
    || typeof draft.addOpen !== 'boolean'
    || typeof draft.addName !== 'string'
    || typeof draft.addQty !== 'string'
    || typeof draft.addPar !== 'string'
    || typeof draft.addCost !== 'string'
    || typeof draft.addSetAside !== 'string'
    || typeof draft.addVendor !== 'string'
    || !draft.addCategory || !['housekeeping', 'maintenance', 'breakfast'].includes(draft.addCategory)
    || (draft.addCustomCategoryId !== null && typeof draft.addCustomCategoryId !== 'string')
    || typeof draft.addOpeningAdjustmentConfirmed !== 'boolean'
    || !Array.isArray(draft.createdIds)
    || !draft.createdIds.every((id) => typeof id === 'string')
  ) return null;
  for (const entry of Object.values(draft.entries)) {
    if (!entry || typeof entry.value !== 'string' || (entry.source !== 'manual' && entry.source !== 'photo')) return null;
  }
  for (const baseline of Object.values(draft.baselines)) {
    if (typeof baseline !== 'number' || !Number.isFinite(baseline) || baseline < 0) return null;
  }
  return draft as CountOverlayDraft;
}

// Co-located strings for the count sheet (too specific for inv-i18n).
function csStrings(lang: Lang) {
  return {
    en: {
      title: 'Inventory counting',
      generalInventory: 'General inventory',
      breakfastInventory: 'Breakfast inventory',
      everything: 'Everything',
      otherGroup: 'Other',
      items: 'items',
      cancel: 'Cancel',
      back: 'Back',
      saving: 'Saving…',
      saveCount: '✓ Save count',
      retryCount: 'Retry exact count',
      retryPending: 'The result could not be confirmed. This exact count is locked until it is retried, so its history cannot be duplicated.',
      changeWhatToCount: 'Change what to count',
      changeScopeConfirm: 'Changing what to count will discard the counts already entered. Continue?',
      countByPhoto: '📷 Count by photo',
      reading: 'Reading photo…',
      photoCheck: 'Check the photo counts',
      useCounts: 'Use these counts',
      notInPhoto: (n: number) => `${n} item${n === 1 ? '' : 's'} not in the photo`,
      saveFailed: 'Saving the count failed. Please try again.',
      stockChanged: 'Inventory changed while this count was open. Nothing was saved—close, refresh, and recount so a newer count or delivery is not overwritten.',
      discardConfirm: 'You have unsaved counts. Close and discard them?',
      draftRestored: 'Your unsaved count was restored.',
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
      fSetAside: 'Set aside',
      fVendor: 'Vendor',
      fCategory: 'Category',
      optional: 'optional',
      addBtn: 'Add',
      addFailed: 'Couldn’t add the item. Please try again.',
      discardInlineAddConfirm: 'Discard the new item fields?',
      setAsideTooHigh: 'Set aside cannot be greater than the count.',
      addUnsafe: 'This item was not sent because its recovery copy could not be saved safely. Your fields are still here.',
      addUnconfirmed: 'The result could not be confirmed. These exact item fields are saved, and another insert is blocked while inventory checks for the tagged row.',
      addChecking: 'Checking exact item…',
      completeRequired: 'Month close requires a count for every active item. Fill every row before saving.',
      openingAdjustmentTitle: 'Already on the shelf',
      openingAdjustmentBody: 'This new item’s count is pre-existing opening inventory, not a delivery or purchase.',
      openingAdjustmentConfirm: 'Yes, this stock was already at the hotel.',
      openingAdjustmentCost: 'Enter its unit cost so the opening adjustment can be valued.',
      openingAdjustmentPermission: 'Only a manager who can enter costs can add positive starting stock. Otherwise add the item at zero, then log a delivery.',
    },
    es: {
      title: 'Conteo de inventario',
      generalInventory: 'Inventario general',
      breakfastInventory: 'Inventario de desayuno',
      everything: 'Todo',
      otherGroup: 'Otros',
      items: 'artículos',
      cancel: 'Cancelar',
      back: 'Atrás',
      saving: 'Guardando…',
      saveCount: '✓ Guardar conteo',
      retryCount: 'Reintentar el mismo conteo',
      retryPending: 'No se pudo confirmar el resultado. Este conteo exacto está bloqueado hasta reintentarlo para que no se duplique el historial.',
      changeWhatToCount: 'Cambiar qué contar',
      changeScopeConfirm: 'Cambiar qué contar descartará los conteos ya ingresados. ¿Continuar?',
      countByPhoto: '📷 Contar por foto',
      reading: 'Leyendo foto…',
      photoCheck: 'Revisa los conteos de la foto',
      useCounts: 'Usar estos conteos',
      notInPhoto: (n: number) => `${n} artículo${n === 1 ? '' : 's'} no salen en la foto`,
      saveFailed: 'No se pudo guardar el conteo. Inténtalo de nuevo.',
      stockChanged: 'El inventario cambió mientras este conteo estaba abierto. No se guardó nada—cierra, actualiza y vuelve a contar para no sobrescribir un conteo o una entrega más reciente.',
      discardConfirm: 'Tienes conteos sin guardar. ¿Cerrar y descartarlos?',
      draftRestored: 'Se restauró tu conteo sin guardar.',
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
      fSetAside: 'Apartado',
      fVendor: 'Proveedor',
      fCategory: 'Categoría',
      optional: 'opcional',
      addBtn: 'Agregar',
      addFailed: 'No se pudo agregar el artículo. Inténtalo de nuevo.',
      discardInlineAddConfirm: '¿Descartar los datos del artículo nuevo?',
      setAsideTooHigh: 'La cantidad apartada no puede ser mayor que el conteo.',
      addUnsafe: 'Este artículo no se envió porque no se pudo guardar una copia segura para recuperarlo. Tus datos siguen aquí.',
      addUnconfirmed: 'No se pudo confirmar el resultado. Estos datos exactos están guardados y se bloqueó otra inserción mientras el inventario busca la fila marcada.',
      addChecking: 'Verificando el artículo…',
      completeRequired: 'El cierre mensual requiere un conteo de cada artículo activo. Completa todas las filas antes de guardar.',
      openingAdjustmentTitle: 'Ya estaba en el hotel',
      openingAdjustmentBody: 'El conteo de este artículo nuevo es inventario de apertura preexistente, no una entrega ni una compra.',
      openingAdjustmentConfirm: 'Sí, este inventario ya estaba en el hotel.',
      openingAdjustmentCost: 'Ingresa el costo unitario para valorar el ajuste de apertura.',
      openingAdjustmentPermission: 'Solo un gerente que pueda ingresar costos puede agregar inventario inicial positivo. Si no, agrega el artículo en cero y luego registra una entrega.',
    },
  }[lang];
}

export function CountSheet({
  lang,
  open,
  onClose,
  startWithAll = false,
  requireComplete = false,
  onSaved,
  canViewFinancials = false,
  items,
  display,
  customCategories,
  tabLayout,
}: CountSheetProps) {
  const present = useOverlayPresence(open);
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
  const [addSetAside, setAddSetAside] = useState('0');
  const [addVendor, setAddVendor] = useState('');
  const [addCategory, setAddCategory] = useState<InvCat>('housekeeping');
  const [addCustomCategoryId, setAddCustomCategoryId] = useState<string | null>(null);
  const [addOpeningAdjustmentConfirmed, setAddOpeningAdjustmentConfirmed] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addRetryLocked, setAddRetryLocked] = useState(false);
  const [addError, setAddError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftReadyContext, setDraftReadyContext] = useState('');
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
  const displayRef = useRef(display);
  displayRef.current = display;
  // Synchronous re-entrancy lock for handleAdd — `addBusy` state lags the insert
  // by a render, so a fast double-click / Enter would otherwise create two rows.
  const addLockRef = useRef(false);

  const draftContext = user?.uid && activePropertyId ? `${user.uid}:${activePropertyId}` : '';
  const draftStorageInput = useMemo(() => user?.uid && activePropertyId
    ? { kind: 'count' as const, userId: user.uid, propertyId: activePropertyId }
    : null, [activePropertyId, user?.uid]);

  const defaultAddPlacement = useCallback((nextScope: StockBucket | null) => {
    if (nextScope === 'breakfast') return { category: 'breakfast' as InvCat, customCategoryId: null };
    if (nextScope?.startsWith('custom:')) {
      return { category: 'housekeeping' as InvCat, customCategoryId: nextScope.slice(7) };
    }
    if (nextScope === 'general') return { category: 'housekeeping' as InvCat, customCategoryId: null };
    const hidden = new Set(tabLayout.hidden);
    if (!hidden.has('general')) return { category: 'housekeeping' as InvCat, customCategoryId: null };
    if (!hidden.has('breakfast')) return { category: 'breakfast' as InvCat, customCategoryId: null };
    return {
      category: 'housekeeping' as InvCat,
      customCategoryId: customCategories[0]?.id ?? null,
    };
  }, [customCategories, tabLayout.hidden]);

  // Collapse + clear the inline add form. Does NOT clear `extra`/`createdIds`
  // (those persist for the whole count session; only a fresh open resets them),
  // so a created item survives a scope change instead of vanishing before the
  // realtime echo lands.
  const resetAddForm = (nextScope: StockBucket | null = scope) => {
    const placement = defaultAddPlacement(nextScope);
    setAddOpen(false);
    setAddName('');
    setAddQty('');
    setAddPar('');
    setAddCost('');
    setAddSetAside('0');
    setAddVendor('');
    setAddCategory(placement.category);
    setAddCustomCategoryId(placement.customCategoryId);
    setAddOpeningAdjustmentConfirmed(false);
    setAddError('');
  };

  const openAddForm = () => {
    const placement = defaultAddPlacement(scope);
    setAddCategory(placement.category);
    setAddCustomCategoryId(placement.customCategoryId);
    setAddError('');
    setAddOpen(true);
  };

  const cancelAddForm = () => {
    const addDirty = addName.trim() !== '' || addQty !== '' || addPar !== '' || addCost !== ''
      || addSetAside !== '0' || addVendor.trim() !== '' || addOpeningAdjustmentConfirmed;
    if (addDirty && !confirm(cs.discardInlineAddConfirm)) return;
    resetAddForm();
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
    setAddSetAside('0');
    setAddVendor('');
    const placement = defaultAddPlacement(scope);
    setAddCategory(placement.category);
    setAddCustomCategoryId(placement.customCategoryId);
    setAddOpeningAdjustmentConfirmed(false);

    // The marker is only a recovery key. Clearing it is an idempotent metadata
    // cleanup; a failure merely leaves an internal marker, never a duplicate.
    if (user) {
      void updateInventoryItem(user.uid, attempt.propertyId, raw.id, { notes: '' })
        .catch((err) => console.error('[count-sheet] inline add marker cleanup failed', err));
    }
  }, [defaultAddPlacement, scope, user]);

  // Show a fresh chooser, unless a prior response was ambiguous. In that case
  // restore the immutable UUID + payload and expose only an exact retry.
  useEffect(() => {
    if (open) {
      setAddError('');
      setSaveError('');
      const restored = activePropertyId
        ? loadInventoryCountAttempt(activePropertyId)
        : null;
      const restoredAdd = activePropertyId
        ? loadInlineAddAttempt(activePropertyId)
        : null;
      const savedDraft = !restored && draftStorageInput
        ? validCountDraft(loadInventoryOverlayDraft<CountOverlayDraft>(draftStorageInput))
        : null;
      const beginFullCount = (startWithAll || requireComplete) && !restored && !restoredAdd && !savedDraft;
      const freshDisplay = displayRef.current;
      const nextScope = restored || beginFullCount
        ? 'all'
        : restoredAdd?.scope ?? savedDraft?.scope ?? null;
      const placement = defaultAddPlacement(nextScope);
      setScope(nextScope);
      setEntries(restored
        ? Object.fromEntries(restored.rows.map((row) => [
            row.itemId,
            { value: String(row.countedStock), source: 'manual' as const },
          ]))
        : savedDraft?.entries
          ?? (beginFullCount
            ? Object.fromEntries(freshDisplay.map((d) => [d.id, { value: '', source: 'manual' as const }]))
            : {}));
      setReview(savedDraft?.review ?? null);
      setReviewMissing(savedDraft?.reviewMissing ?? 0);
      setPhotoBusy(false);
      setPhotoErr('');
      setDraftRestored(!!savedDraft);
      progRef.current = restored;
      setRetryLocked(!!restored);
      inlineAddAttemptRef.current = restoredAdd;
      setAddRetryLocked(!!restoredAdd);
      setExtra([]);
      setAddOpen(!!restoredAdd || (savedDraft?.addOpen ?? false));
      setAddName(restoredAdd?.nameInput ?? savedDraft?.addName ?? '');
      setAddQty(restoredAdd?.quantityInput ?? savedDraft?.addQty ?? '');
      setAddPar(restoredAdd?.parInput ?? savedDraft?.addPar ?? '');
      setAddCost(restoredAdd?.costInput ?? savedDraft?.addCost ?? '');
      setAddSetAside(restoredAdd?.setAsideInput ?? savedDraft?.addSetAside ?? '0');
      setAddVendor(restoredAdd?.vendorInput ?? savedDraft?.addVendor ?? '');
      setAddCategory(restoredAdd?.category ?? savedDraft?.addCategory ?? placement.category);
      setAddCustomCategoryId(
        restoredAdd
          ? restoredAdd.customCategoryId
          : savedDraft
            ? savedDraft.addCustomCategoryId
            : placement.customCategoryId,
      );
      setAddOpeningAdjustmentConfirmed(
        restoredAdd?.openingAdjustmentConfirmed
          ?? savedDraft?.addOpeningAdjustmentConfirmed
          ?? false,
      );
      createdIdsRef.current = new Set(savedDraft?.createdIds ?? []);
      stockBaselineRef.current = new Map(
        restored?.rows.map((row) => [row.itemId, row.expectedStock])
          ?? (savedDraft ? Object.entries(savedDraft.baselines) : undefined)
          ?? (beginFullCount
            ? freshDisplay.map((d) => [d.id, d.raw.currentStock ?? 0] as const)
            : []),
      );
      setDraftReadyContext(draftContext);
    }
  }, [
    open, activePropertyId, startWithAll, requireComplete, draftContext,
    draftStorageInput, defaultAddPlacement,
  ]);

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
  const dirty = Object.values(entries).some((e) => e.value !== '')
    || review != null
    || (addOpen && (
      addName.trim() !== '' || addQty !== '' || addPar !== '' || addCost !== ''
      || addSetAside !== '0' || addVendor.trim() !== '' || addOpeningAdjustmentConfirmed
    ));

  const currentCountDraft = useMemo<CountOverlayDraft>(() => ({
    scope,
    entries,
    baselines: Object.fromEntries(stockBaselineRef.current),
    review,
    reviewMissing,
    addOpen,
    addName,
    addQty,
    addPar,
    addCost,
    addSetAside,
    addVendor,
    addCategory,
    addCustomCategoryId,
    addOpeningAdjustmentConfirmed,
    createdIds: [...createdIdsRef.current],
  }), [
    scope, entries, review, reviewMissing, addOpen, addName, addQty, addPar,
    addCost, addSetAside, addVendor, addCategory, addCustomCategoryId,
    addOpeningAdjustmentConfirmed,
  ]);

  useEffect(() => {
    if (!open || !draftStorageInput || draftReadyContext !== draftContext) return;
    if (dirty || retryLocked || addRetryLocked) {
      persistInventoryOverlayDraft({ ...draftStorageInput, data: currentCountDraft });
    } else {
      clearInventoryOverlayDraft(draftStorageInput);
    }
  }, [
    open, draftStorageInput, draftReadyContext, draftContext, dirty,
    retryLocked, addRetryLocked, currentCountDraft,
  ]);

  useEffect(() => {
    setAddError('');
  }, [
    addName, addQty, addPar, addCost, addSetAside, addVendor,
    addCategory, addCustomCategoryId, addOpeningAdjustmentConfirmed,
  ]);

  const requestClose = () => {
    if (saving || retryLocked || addRetryLocked) return;
    if (dirty && !confirm(cs.discardConfirm)) return;
    if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
    onClose();
  };

  const requestScopeChange = () => {
    if (saving || retryLocked || addRetryLocked) return;
    if (dirty && !confirm(cs.changeScopeConfirm)) return;
    setEntries({});
    setReview(null);
    setReviewMissing(0);
    setSaveError('');
    setDraftRestored(false);
    resetAddForm(null);
    setScope(null);
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
    resetAddForm(s);
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
    setAddError('');
    if (!addName.trim()) return;
    const startingQuantity = Math.max(0, Number(addQty) || 0);
    const setAsideQuantity = Math.max(0, Math.round(Number(addSetAside) || 0));
    if (setAsideQuantity > startingQuantity) {
      setAddError(cs.setAsideTooHigh);
      return;
    }
    if (startingQuantity > 0) {
      if (!canViewFinancials) {
        setAddError(cs.openingAdjustmentPermission);
        return;
      }
      const startingCost = addCost.trim() === '' ? Number.NaN : Number(addCost);
      if (!Number.isFinite(startingCost) || startingCost < 0) {
        setAddError(cs.openingAdjustmentCost);
        return;
      }
      if (!addOpeningAdjustmentConfirmed) {
        setAddError(cs.openingAdjustmentConfirm);
        return;
      }
    }
    // The durable helper predates hotel-defined tabs, so freeze their built-in
    // category in its supported scope and keep the selected custom tab id as a
    // separate immutable value for this one insert.
    const attemptScope: InlineAddScope = scope === 'breakfast'
      ? 'breakfast'
      : scope === 'all'
        ? 'all'
        : 'general';
    const attempt = createFrozenInlineAddAttempt({
      propertyId: activePropertyId,
      requestId: generateId(),
      startedAt: new Date().toISOString(),
      scope: attemptScope,
      nameInput: addName,
      quantityInput: addQty,
      parInput: addPar,
      costInput: addCost,
      setAsideInput: addSetAside,
      vendorInput: addVendor,
      category: addCategory,
      customCategoryId: addCustomCategoryId,
      openingAdjustmentConfirmed: addOpeningAdjustmentConfirmed,
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
        setAddError(cs.addUnsafe);
        return;
      }
      setAddRetryLocked(true);
      const id = await addInventoryItem(user.uid, activePropertyId, {
        name: attempt.name,
        category: attempt.category,
        customCategoryId: attempt.customCategoryId,
        currentStock: attempt.quantity,
        setAside: attempt.setAside,
        parLevel: attempt.parLevel,
        unitCost: attempt.unitCost ?? undefined,
        vendorName: attempt.vendorName ?? undefined,
        unit: 'each',
        reorderLeadDays: 3,
        notes: inlineAddAttemptMarker(attempt.requestId),
        lastCountedAt: attempt.quantity > 0 ? new Date(attempt.startedAt) : null,
        openingAdjustmentQuantity: attempt.openingAdjustmentConfirmed ? attempt.quantity : null,
        openingAdjustmentUnitCost: attempt.openingAdjustmentConfirmed ? attempt.unitCost : null,
        openingAdjustmentAt: attempt.openingAdjustmentConfirmed ? new Date(attempt.startedAt) : null,
        openingAdjustmentRequestId: attempt.openingAdjustmentConfirmed ? attempt.requestId : null,
        propertyId: activePropertyId,
      });
      const raw: InventoryItem = {
        id,
        propertyId: activePropertyId,
        name: attempt.name,
        category: attempt.category,
        customCategoryId: attempt.customCategoryId,
        currentStock: attempt.quantity,
        setAside: attempt.setAside,
        parLevel: attempt.parLevel,
        unit: 'each',
        reorderLeadDays: 3,
        unitCost: attempt.unitCost ?? undefined,
        vendorName: attempt.vendorName ?? undefined,
        notes: inlineAddAttemptMarker(attempt.requestId),
        updatedAt: null,
        lastCountedAt: attempt.quantity > 0 ? new Date(attempt.startedAt) : null,
        openingAdjustmentQuantity: attempt.openingAdjustmentConfirmed ? attempt.quantity : null,
        openingAdjustmentUnitCost: attempt.openingAdjustmentConfirmed ? attempt.unitCost : null,
        openingAdjustmentAt: attempt.openingAdjustmentConfirmed ? new Date(attempt.startedAt) : null,
        openingAdjustmentRequestId: attempt.openingAdjustmentConfirmed ? attempt.requestId : null,
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
        setAddError(cs.addFailed);
      } else {
        // Unknown outcome: preserve the exact fields and marker, and never send
        // another insert. Realtime will call finishInlineAdd if it committed.
        setAddRetryLocked(true);
        setAddError(cs.addUnconfirmed);
      }
    } finally {
      addLockRef.current = false;
      setAddBusy(false);
    }
  };

  const setEntry = (id: string, val: string) => {
    if (retryLocked || addRetryLocked) return;
    setSaveError('');
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

  // Keep the component's draft state mounted between opens, but stop rebuilding
  // this large JSX tree after the shared Overlay's exit window has elapsed.
  // A direct `if (!open)` would tear down the subtree before the exit animation.
  if (!present) return null;

  // STEP 1 — the chooser: one row per visible tab (General / Breakfast / each
  // custom tab), plus "Count everything". "Everything" always appears when a
  // single tab wouldn't cover every item (multiple tabs, or items whose tab is
  // hidden) so nothing is ever un-countable.
  if (scope === null) {
    const showEverything = scopeOptions.length !== 1
      || display.some((d) => !inBucket(d, scopeOptions[0].bucket));
    return (
      <Overlay open={open} onClose={requestClose} hasUnsavedChanges={dirty} width={560} title={cs.title}>
        {draftRestored && <div role="status" style={restoredDraftStyle}>{cs.draftRestored}</div>}
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

  const hiddenCategoryTabs = new Set(tabLayout.hidden);
  const inlineCategoryOptions: Array<{
    key: string;
    label: string;
    category: InvCat;
    customCategoryId: string | null;
  }> = (() => {
    if (scope === 'breakfast') {
      return [{ key: 'breakfast', label: catLabelFor(lang, 'breakfast'), category: 'breakfast', customCategoryId: null }];
    }
    if (scope.startsWith('custom:')) {
      const id = scope.slice(7);
      const custom = customCategories.find((entry) => entry.id === id);
      return [{ key: `custom:${id}`, label: custom?.name ?? cs.otherGroup, category: 'housekeeping', customCategoryId: id }];
    }
    const builtins: Array<{ key: string; label: string; category: InvCat; customCategoryId: null }> = [];
    if (!hiddenCategoryTabs.has('general') && (scope === 'all' || scope === 'general')) {
      builtins.push(
        { key: 'housekeeping', label: catLabelFor(lang, 'housekeeping'), category: 'housekeeping', customCategoryId: null },
        { key: 'maintenance', label: catLabelFor(lang, 'maintenance'), category: 'maintenance', customCategoryId: null },
      );
    }
    if (!hiddenCategoryTabs.has('breakfast') && scope === 'all') {
      builtins.push({ key: 'breakfast', label: catLabelFor(lang, 'breakfast'), category: 'breakfast', customCategoryId: null });
    }
    const custom = scope === 'all'
      ? customCategories.map((entry) => ({
          key: `custom:${entry.id}`,
          label: entry.name,
          category: 'housekeeping' as InvCat,
          customCategoryId: entry.id,
        }))
      : [];
    const options = [...builtins, ...custom];
    return options.length > 0 ? options : [{
      key: 'housekeeping-fallback',
      label: catLabelFor(lang, 'housekeeping'),
      category: 'housekeeping' as InvCat,
      customCategoryId: null,
    }];
  })();

  const handleSave = async () => {
    if (!user || !activePropertyId || saving || addRetryLocked) return;
    setSaveError('');
    setSaving(true);
    let submittedPropertyId = activePropertyId;
    let submittedRequestId: string | null = null;
    try {
      const fp = entriesFingerprint(entries);
      let attempt = progRef.current;
      if (!retryLocked && (!attempt || attempt.fingerprint !== fp)) {
        if (requireComplete && (
          scope !== 'all'
          || scopedDisplay.length !== display.length
          || scopedDisplay.some((d) => {
            const value = entries[d.id]?.value ?? '';
            const parsed = Number(value);
            return value === '' || !Number.isFinite(parsed) || parsed < 0;
          })
        )) {
          alert(cs.completeRequired);
          return;
        }
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
        if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
        if (onSaved) onSaved();
        else onClose();
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
      setSaveError((err as { code?: unknown })?.code === '40001' ? cs.stockChanged : cs.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  // STEP 3 — photo review: the AI's estimates, adjustable, before they touch
  // the count. Same modal shell; its own footer.
  if (review) {
    return (
      <Overlay
        open={open}
        onClose={requestClose}
        hasUnsavedChanges={dirty}
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
        {draftRestored && <div role="status" style={restoredDraftStyle}>{cs.draftRestored}</div>}
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
                    className={overlayStyles.formControl}
                    aria-label={`${r.name} ${cs.fCount}`}
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={r.value}
                    onChange={(e) => { const v = e.target.value; if (numGuard(v)) setReviewValue(r.itemId, v); }}
                    style={{
                      width: 72, height: 44, borderRadius: 8, boxSizing: 'border-box',
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
  // Blank = skipped. Grouping mirrors what the hotel actually sees: a hotel
  // that removed both built-in tabs and runs on custom tabs gets its
  // "Everything" count grouped BY TAB (with an "Other" tail for unassigned
  // items) — Housekeeping/Maintenance dividers would name sections that
  // hotel's tabs don't have. Everyone else keeps the built-in category
  // dividers; either way dividers only appear when there's more than one group.
  // Any hidden built-in switches the Everything count to grouping BY THE
  // HOTEL'S VISIBLE TABS (same list as the scope chooser) + an "Other" tail
  // for items stranded in hidden buckets — a hotel that removed Breakfast
  // must not see a "Food & Beverage" divider, and one that removed both
  // built-ins should see its own tab names. Hotels with all built-ins visible
  // keep the finer category dividers.
  const anyBuiltinHidden = (tabLayout?.hidden ?? []).length > 0;
  const groups: Array<{ key: string; label: string; items: DisplayItem[] }> =
    scope === 'all' && anyBuiltinHidden && scopeOptions.length > 0
      ? (() => {
          const tabGroups = scopeOptions.map((o) => ({
            key: String(o.bucket),
            label: o.label,
            items: scopedDisplay.filter((d) => inBucket(d, o.bucket)),
          }));
          const claimed = new Set(tabGroups.flatMap((g) => g.items.map((d) => d.id)));
          return [
            ...tabGroups,
            { key: 'other', label: cs.otherGroup, items: scopedDisplay.filter((d) => !claimed.has(d.id)) },
          ].filter((g) => g.items.length > 0);
        })()
      : (['housekeeping', 'maintenance', 'breakfast'] as InvCat[])
          .filter((c) => scopedDisplay.some((d) => d.cat === c))
          .map((c) => ({
            key: c,
            label: catLabelFor(lang, c),
            items: scopedDisplay.filter((d) => d.cat === c),
          }));
  const showDividers = groups.length > 1;

  return (
    <Overlay
      open={open}
      onClose={requestClose}
      hasUnsavedChanges={dirty}
      accent={statusColor.good}
      italic={scopeLabel}
      width={520}
      footer={
        <>
          <span style={{ marginRight: 'auto' }} />
          <Btn variant="ghost" size="md" onClick={requestClose} disabled={saving || retryLocked || addRetryLocked}>
            {cs.cancel}
          </Btn>
          <Btn
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={saving || addRetryLocked || (!retryLocked && (filled === 0 || (requireComplete && filled !== total)))}
            aria-busy={saving}
          >
            {saving ? cs.saving : retryLocked ? cs.retryCount : `${cs.saveCount} · ${filled}/${total}`}
          </Btn>
        </>
      }
    >
      {draftRestored && <div role="status" style={restoredDraftStyle}>{cs.draftRestored}</div>}
      {retryLocked && <div style={warnBannerStyle}>{cs.retryPending}</div>}
      {addRetryLocked && !addBusy && <div style={warnBannerStyle}>{cs.addUnconfirmed}</div>}
      {saveError && <div role="alert" style={countErrorStyle}>{saveError}</div>}
      {requireComplete && !retryLocked && filled !== total && (
        <div style={warnBannerStyle}>{cs.completeRequired}</div>
      )}
      {/* Top row: change scope · photo count */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          className={overlayStyles.compactButton}
          onClick={requestScopeChange}
          disabled={retryLocked || addRetryLocked || requireComplete}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            minHeight: 44, padding: '5px 11px 5px 8px', borderRadius: 8, cursor: 'pointer',
            background: T.bg, border: `1px solid ${T.controlBorder}`, color: T.ink,
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
        <div role="alert" style={{ marginBottom: 10, fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: T.warm }}>
          {photoErr}
        </div>
      )}

      {/* Slim progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <span
          role="progressbar"
          aria-label={cs.title}
          aria-valuemin={0}
          aria-valuemax={Math.max(1, total)}
          aria-valuenow={filled}
          style={{ flex: 1, display: 'block', height: 5, borderRadius: 5, background: T.ruleSoft, overflow: 'hidden' }}
        >
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
            className={overlayStyles.compactButton}
            onClick={openAddForm}
            style={{
              width: '100%', minHeight: 44, borderRadius: 10, cursor: 'pointer',
              background: T.bg, border: `1px dashed ${T.controlBorder}`, color: T.ink,
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 700,
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
            {addError && <div role="alert" style={countErrorStyle}>{addError}</div>}
            <AddField label={cs.fName}>
              <input
                className={overlayStyles.formControl}
                aria-label={cs.fName}
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
            <AddField label={cs.fCategory}>
              <div className={overlayStyles.categoryRow} role="group" aria-label={cs.fCategory}>
                {inlineCategoryOptions.map((option) => {
                  const active = addCategory === option.category
                    && addCustomCategoryId === option.customCategoryId;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={overlayStyles.categoryChip}
                      aria-pressed={active}
                      disabled={addRetryLocked}
                      onClick={() => {
                        setAddCategory(option.category);
                        setAddCustomCategoryId(option.customCategoryId);
                      }}
                      style={{
                        padding: '0 12px',
                        minHeight: 40,
                        borderRadius: 8,
                        border: `1px solid ${active ? T.ink : T.controlBorder}`,
                        background: active ? T.ink : T.bg,
                        color: active ? T.bg : T.ink,
                        fontFamily: fonts.sans,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </AddField>
            <div className={overlayStyles.formGrid2}>
              <AddField label={cs.fCount}>
                <input
                  className={overlayStyles.formControl}
                  aria-label={cs.fCount}
                  type="number" min="0" inputMode="decimal" value={addQty}
                  disabled={addRetryLocked}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) setAddQty(v); }}
                  placeholder="—" style={addInputStyle}
                />
              </AddField>
              <AddField label={cs.fPar} hint={cs.optional}>
                <input
                  className={overlayStyles.formControl}
                  aria-label={cs.fPar}
                  type="number" min="0" inputMode="decimal" value={addPar}
                  disabled={addRetryLocked}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) setAddPar(v); }}
                  placeholder="—" style={addInputStyle}
                />
              </AddField>
            </div>
            <div className={overlayStyles.formGrid2}>
              <AddField label={cs.fSetAside} hint={cs.optional} tip={setAsideTip(lang)}>
                <input
                  className={overlayStyles.formControl}
                  aria-label={cs.fSetAside}
                  type="number" min="0" step="1" inputMode="numeric" value={addSetAside}
                  disabled={addRetryLocked}
                  onChange={(e) => { const v = e.target.value; if (intGuard(v)) setAddSetAside(v); }}
                  placeholder="0" style={addInputStyle}
                />
              </AddField>
              {canViewFinancials ? (
                <AddField label={cs.fCost} hint={(Number(addQty) || 0) > 0 ? undefined : cs.optional}>
                  <input
                    className={overlayStyles.formControl}
                    aria-label={cs.fCost}
                    type="number" min="0" step="0.01" inputMode="decimal" value={addCost}
                    disabled={addRetryLocked}
                    onChange={(e) => { const v = e.target.value; if (numGuard(v)) setAddCost(v); }}
                    placeholder="0.00" style={addInputStyle}
                  />
                </AddField>
              ) : <span />}
            </div>
            <AddField label={cs.fVendor} hint={cs.optional}>
              <input
                className={overlayStyles.formControl}
                aria-label={cs.fVendor}
                type="text"
                value={addVendor}
                disabled={addRetryLocked}
                onChange={(event) => setAddVendor(event.target.value)}
                placeholder={cs.fVendor}
                style={addInputStyle}
              />
            </AddField>
            {(Number(addQty) || 0) > 0 && (
              <div
                style={{
                  padding: '9px 10px',
                  borderRadius: 9,
                  background: T.warmDim,
                  border: `1px solid ${T.rule}`,
                  color: T.ink,
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ fontWeight: 700 }}>{cs.openingAdjustmentTitle}</div>
                <div style={{ color: T.ink2, marginTop: 2 }}>
                  {canViewFinancials ? cs.openingAdjustmentBody : cs.openingAdjustmentPermission}
                </div>
                {canViewFinancials && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 8, cursor: 'pointer' }}>
                    <input
                      aria-label={cs.openingAdjustmentConfirm}
                      type="checkbox"
                      checked={addOpeningAdjustmentConfirmed}
                      disabled={addRetryLocked}
                      onChange={(event) => setAddOpeningAdjustmentConfirmed(event.target.checked)}
                      style={{ marginTop: 2, width: 18, height: 18, flex: 'none' }}
                    />
                    <span>{cs.openingAdjustmentConfirm}</span>
                  </label>
                )}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" size="sm" onClick={cancelAddForm} disabled={addBusy || addRetryLocked}>{cs.cancel}</Btn>
              <Btn
                variant="primary"
                size="sm"
                onClick={() => void handleAdd()}
                disabled={addBusy || addRetryLocked || !addName.trim()}
                aria-busy={addBusy}
              >
                {addRetryLocked ? cs.addChecking : addBusy ? cs.saving : cs.addBtn}
              </Btn>
            </div>
          </div>
        )}
      </div>}

      {total === 0 && (
        <div role="status" style={emptyCountStyle}>{cs.noItemsInGroup}</div>
      )}

      {groups.map((group) => (
        <div key={group.key}>
          {showDividers && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 2px' }}>
              <Caps size={9.5}>{group.label}</Caps>
              <span style={{ flex: 1, height: 1, background: T.ruleSoft }} />
            </div>
          )}
          {group.items.map((d) => (
            <CountLine
              key={d.id}
              d={d}
              lang={lang}
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

const restoredDraftStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  borderRadius: 9,
  background: T.tealDim,
  color: T.tealText,
  fontFamily: fonts.sans,
  fontSize: 12.5,
  fontWeight: 600,
};

const countErrorStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  border: `1px solid ${T.warm}55`,
  borderRadius: 9,
  background: T.warmDim,
  color: T.warm,
  fontFamily: fonts.sans,
  fontSize: 12.5,
  fontWeight: 600,
};

const emptyCountStyle: React.CSSProperties = {
  marginTop: 14,
  padding: '28px 18px',
  border: `1px dashed ${T.controlBorder}`,
  borderRadius: 12,
  color: T.ink2,
  fontFamily: fonts.sans,
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'center',
};

// Compact input for the inline add-item form (matches the sheet's density).
const addInputStyle: React.CSSProperties = {
  width: '100%', height: 44, padding: '0 11px', borderRadius: 8, boxSizing: 'border-box',
  background: T.bg, border: `1px solid ${T.controlBorder}`, outline: 'none',
  fontFamily: fonts.sans, fontSize: 14, color: T.ink,
};

// A tiny labelled field for the inline add-item form: a caps label (with an
// optional "optional" hint) stacked over its input.
function AddField({ label, hint, tip, children }: { label: string; hint?: string; tip?: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <Caps size={11} weight={700} className={overlayStyles.fieldLabel}>{label}</Caps>
        {hint && <span style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 500, color: T.ink2 }}>{hint}</span>}
        {tip && <span title={tip} aria-label={tip} style={{ color: T.ink2, fontSize: 12 }}>ⓘ</span>}
      </span>
      {children}
    </div>
  );
}

// One slim count line: item name + a number box. Nothing else.
function CountLine({
  d,
  lang,
  entry,
  onChange,
  disabled = false,
}: {
  d: DisplayItem;
  lang: Lang;
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
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink,
          minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
        {/* Reminds the counter the pile exists: the count box is the TOTAL on
            hand, set-aside included (the pile itself is edited on the item). */}
        <SetAsideTag count={d.setAside} lang={lang} />
      </span>
      <input
        className={overlayStyles.formControl}
        aria-label={`${d.name} ${lang === 'es' ? 'conteo' : 'count'}`}
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
          width: 92, height: 44, borderRadius: 8, boxSizing: 'border-box',
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
      className={overlayStyles.compactButton}
      onClick={onClick}
      style={{
        width: 44, height: 44, borderRadius: 8, padding: 0, lineHeight: 1, fontSize: 16,
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
  return { bg: T.bg, border: T.controlBorder };
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
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.controlBorder; e.currentTarget.style.background = T.bg; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 15,
        padding: '18px 20px',
        borderRadius: 13,
        cursor: 'pointer',
        background: T.bg,
        border: `1px solid ${T.controlBorder}`,
        textAlign: 'left',
        width: '100%',
      }}
    >
      <Serif size={23} style={{ letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{title}</Serif>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flex: 'none' }}>
        <Serif size={22} color={T.ink2}>{n}</Serif>
        <Caps size={9} color={T.ink2}>{itemsLabel}</Caps>
        <Serif size={20} color={T.ink2} style={{ marginLeft: 4 }}>→</Serif>
      </span>
    </button>
  );
}
