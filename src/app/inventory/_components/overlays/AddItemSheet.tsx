'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryItem,
  updateInventoryItem,
  archiveInventoryItem,
  saveInventoryCountAtomic,
} from '@/lib/db';
import { generateId } from '@/lib/utils';
import {
  clearInventoryItemCreateAttempt,
  createFrozenInventoryItemAttempt,
  inventoryItemCreateMarker,
  isDefinitiveInventoryItemCreateFailure,
  loadInventoryItemCreateAttempt,
  persistInventoryItemCreateAttempt,
  type FrozenInventoryItemCreateAttempt,
} from '@/lib/inventory-item-create-attempt';
import type { InventoryItem, InventoryCategory, InventoryCustomCategory } from '@/types';
import type { Vendor } from '@/lib/ordering/types';

import { T, fonts, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { numGuard, intGuard, inputLg as inputStyle } from './form-kit';
import {
  clearInventoryOverlayDraft,
  loadInventoryOverlayDraft,
  persistInventoryOverlayDraft,
} from './inventory-overlay-draft';
import { isDefinitiveDeliveryFailure } from './scan-commit';
import {
  clearInventoryOperationAttempt,
  loadInventoryOperationAttempt,
  persistInventoryOperationAttempt,
} from '@/lib/inventory-operation-attempt';
import overlayStyles from './Overlay.module.css';
import { apiListVendors, apiRecordInventoryOpeningAdjustment } from '../ordering-api';
import { catLabelFor, setAsideTip, type Lang } from '../inv-i18n';

interface AddItemSheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  item: InventoryItem | null;
  canViewFinancials: boolean;
  /** Category a *new* item starts on. Defaults to 'housekeeping' (Inventory
   *  page). The Maintenance → Parts tab passes 'maintenance' so a part added
   *  there lands back in that filtered view. Ignored when editing. */
  defaultCategory?: InvCat;
  /** Hotel-defined custom categories (0307) — extra picks in the category row. */
  customCategories?: InventoryCustomCategory[];
  /** Custom category a *new* item starts in (when added from a custom tab). */
  defaultCustomCategoryId?: string | null;
  /** Built-in tabs this hotel removed (tabLayout.hidden, 0308). The category
   *  row mirrors the hotel's ACTUAL tabs — a hotel that runs purely on custom
   *  tabs shouldn't be offered Housekeeping/Maintenance/F&B chips. */
  hiddenBuiltins?: readonly string[];
  /** Opens the atomic stock-loss flow for an existing item. */
  onRecordStockLoss?: (item: InventoryItem) => void;
}

const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

interface FrozenOpeningAdjustmentAttempt {
  itemId: string;
  expectedStock: number;
  resultingStock: number;
  adjustmentQuantity: number;
  unitCost: number;
  requestId: string;
  effectiveAt: string;
}

interface AddItemDraft {
  name: string;
  category: InvCat;
  customCategoryId: string | null;
  currentStock: string;
  setAsideInput: string;
  parLevel: string;
  unitCost: string;
  vendor: string;
  vendorId: string | null;
  openingAdjustmentConfirmed: boolean;
  openingAdjustmentQuantity: string;
  openingAdjustmentAttempt: FrozenOpeningAdjustmentAttempt | null;
}

function validOpeningAdjustmentAttempt(value: unknown): FrozenOpeningAdjustmentAttempt | null {
  if (!value || typeof value !== 'object') return null;
  const attempt = value as Partial<FrozenOpeningAdjustmentAttempt>;
  if (
    typeof attempt.itemId !== 'string'
    || typeof attempt.requestId !== 'string'
    || typeof attempt.effectiveAt !== 'string'
    || !Number.isFinite(attempt.expectedStock)
    || !Number.isFinite(attempt.resultingStock)
    || !Number.isFinite(attempt.adjustmentQuantity)
    || !Number.isFinite(attempt.unitCost)
  ) return null;
  return attempt as FrozenOpeningAdjustmentAttempt;
}

function validAddItemDraft(value: unknown): AddItemDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<AddItemDraft>;
  if (
    typeof draft.name !== 'string'
    || !draft.category
    || !CATS.includes(draft.category)
    || (draft.customCategoryId !== null && typeof draft.customCategoryId !== 'string')
    || typeof draft.currentStock !== 'string'
    || typeof draft.setAsideInput !== 'string'
    || typeof draft.parLevel !== 'string'
    || typeof draft.unitCost !== 'string'
    || typeof draft.vendor !== 'string'
    || (draft.vendorId !== null && typeof draft.vendorId !== 'string')
    || typeof draft.openingAdjustmentConfirmed !== 'boolean'
    || typeof draft.openingAdjustmentQuantity !== 'string'
  ) return null;
  const openingAdjustmentAttempt = draft.openingAdjustmentAttempt == null
    ? null
    : validOpeningAdjustmentAttempt(draft.openingAdjustmentAttempt);
  if (draft.openingAdjustmentAttempt != null && !openingAdjustmentAttempt) return null;
  return { ...draft, openingAdjustmentAttempt } as AddItemDraft;
}

// Co-located strings for the add/edit item sheet.
function aisStrings(lang: Lang) {
  return {
    en: {
      editItem: 'Edit item',
      newItem: 'New item',
      addToInventory: 'Add to inventory',
      other: '— Other (type below) —',
      archive: 'Delete item',
      recordLoss: 'Record missing / damaged',
      recordLossConfirm: 'Open the stock-loss screen? Your unsaved item edits will be discarded.',
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save',
      addItem: 'Add item',
      name: 'Name',
      namePh: 'e.g. Bath towels',
      nameRequired: 'Enter an item name.',
      category: 'Category',
      onHand: 'On hand',
      setAside: 'Set aside',
      setAsideTooHigh: 'Set aside cannot be greater than on hand.',
      usableNow: (n: number) => `= ${n} usable`,
      parLevel: 'Par level',
      unitCost: 'Unit cost ($)',
      vendor: 'Vendor',
      supplier: 'Supplier',
      saveFailed: 'Saving the item failed. Please try again.',
      discardConfirm: 'You have unsaved item changes. Close and discard them?',
      draftRestored: 'Your unsaved item draft was restored.',
      createPending: 'The result could not be confirmed. These exact item fields are locked to the same safe retry so another item cannot be created by mistake.',
      retryCreate: 'Retry exact item',
      createUnsafe: 'The item was not sent because a recovery copy could not be saved safely. Your fields are still here.',
      adjustmentUnsafe: 'The opening-stock adjustment was not sent because this browser could not save a safe retry. Your item fields are still here.',
      adjustmentPending: 'The opening-stock result could not be confirmed. These exact values are locked; retry them so the adjustment cannot be recorded twice.',
      retryAdjustment: 'Retry exact adjustment',
      detailsSavedCountConflict: 'The item details were saved, but on-hand stock changed elsewhere. Refresh the inventory and enter the count again; the newer stock was not overwritten.',
      confirmArchive: (n: string) => `Delete "${n}"? It will disappear from active inventory and totals, but all count and delivery history will be kept.`,
      couldNotArchive: 'Could not delete the item.',
      archiveStockFirst: 'Count this item down to zero before deleting it. Positive on-hand stock must stay in the month-end inventory value.',
      openingAdjustmentTitle: 'Already on the shelf',
      openingAdjustmentBody: 'This starting quantity is pre-existing opening inventory. It is not a delivery or purchase and will adjust beginning inventory for month close.',
      openingAdjustmentConfirm: 'Yes, this stock was already at the hotel.',
      openingAdjustmentCost: 'Enter its unit cost so the opening adjustment can be valued.',
      openingAdjustmentPermission: 'Only a manager who can enter costs can add positive starting stock. Otherwise add the item at zero, then log a delivery.',
      existingAdjustmentTitle: 'Missed opening stock',
      existingAdjustmentBody: 'Use this only for units that were already at the hotel before this period’s opening count but were missed. They will be added to beginning inventory—not purchases or usage.',
      existingAdjustmentConfirm: 'Classify part of this on-hand stock as missed opening inventory.',
      existingAdjustmentQuantity: 'Missed quantity',
      existingAdjustmentQuantityError: 'Enter how many of the resulting on-hand units were already at the hotel. The amount must be greater than zero and cannot exceed on hand.',
      // Field tooltips (hover the ⓘ) — one plain line each.
      tipName: 'What you call this item.',
      tipCategory: 'Which team uses it — housekeeping, maintenance, or food & beverage.',
      tipOnHand: 'How many you have right now, in total (including any set aside).',
      tipParLevel: 'The amount you want to keep in stock. Below it means it’s time to reorder.',
      tipUnitCost: 'What one unit costs you to buy.',
      tipVendor: 'Who you order this from.',
    },
    es: {
      editItem: 'Editar artículo',
      newItem: 'Nuevo artículo',
      addToInventory: 'Agregar al inventario',
      other: '— Otro (escribe abajo) —',
      archive: 'Eliminar artículo',
      recordLoss: 'Registrar faltante / dañado',
      recordLossConfirm: '¿Abrir la pantalla de pérdida? Se descartarán los cambios sin guardar de este artículo.',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      save: 'Guardar',
      addItem: 'Agregar artículo',
      name: 'Nombre',
      namePh: 'ej. Toallas de baño',
      nameRequired: 'Ingresa el nombre del artículo.',
      category: 'Categoría',
      onHand: 'Disponible',
      setAside: 'Apartado',
      setAsideTooHigh: 'La cantidad apartada no puede ser mayor que la cantidad disponible.',
      usableNow: (n: number) => `= ${n} utilizables`,
      parLevel: 'Nivel par',
      unitCost: 'Costo unitario ($)',
      vendor: 'Proveedor',
      supplier: 'Proveedor',
      saveFailed: 'No se pudo guardar el artículo. Inténtalo de nuevo.',
      discardConfirm: 'Tienes cambios del artículo sin guardar. ¿Cerrar y descartarlos?',
      draftRestored: 'Se restauró tu borrador del artículo sin guardar.',
      createPending: 'No se pudo confirmar el resultado. Estos datos exactos están bloqueados para el mismo reintento seguro y así no crear otro artículo por error.',
      retryCreate: 'Reintentar el mismo artículo',
      createUnsafe: 'El artículo no se envió porque no se pudo guardar una copia segura. Tus datos siguen aquí.',
      adjustmentUnsafe: 'El ajuste de inventario inicial no se envió porque este navegador no pudo guardar un reintento seguro. Los datos del artículo siguen aquí.',
      adjustmentPending: 'No se pudo confirmar el ajuste de inventario inicial. Estos valores exactos están bloqueados; reinténtalos para no registrar el ajuste dos veces.',
      retryAdjustment: 'Reintentar ajuste exacto',
      detailsSavedCountConflict: 'Los detalles se guardaron, pero el inventario disponible cambió en otro lugar. Actualiza el inventario y vuelve a ingresar el conteo; no se sobrescribió el valor más reciente.',
      confirmArchive: (n: string) => `¿Eliminar "${n}"? Desaparecerá del inventario activo y los totales, pero se conservará todo el historial de conteos y entregas.`,
      couldNotArchive: 'No se pudo eliminar el artículo.',
      archiveStockFirst: 'Cuenta este artículo hasta cero antes de eliminarlo. El inventario positivo debe permanecer en el valor de inventario de fin de mes.',
      openingAdjustmentTitle: 'Ya estaba en el hotel',
      openingAdjustmentBody: 'Esta cantidad inicial es inventario de apertura preexistente. No es una entrega ni una compra y ajustará el inventario inicial del cierre mensual.',
      openingAdjustmentConfirm: 'Sí, este inventario ya estaba en el hotel.',
      openingAdjustmentCost: 'Ingresa el costo unitario para valorar el ajuste de apertura.',
      openingAdjustmentPermission: 'Solo un gerente que pueda ingresar costos puede agregar inventario inicial positivo. Si no, agrega el artículo en cero y luego registra una entrega.',
      existingAdjustmentTitle: 'Inventario inicial omitido',
      existingAdjustmentBody: 'Úsalo solo para unidades que ya estaban en el hotel antes del conteo inicial de este período, pero se omitieron. Se agregarán al inventario inicial, no a compras ni uso.',
      existingAdjustmentConfirm: 'Clasificar parte de este inventario como inventario inicial omitido.',
      existingAdjustmentQuantity: 'Cantidad omitida',
      existingAdjustmentQuantityError: 'Ingresa cuántas unidades resultantes ya estaban en el hotel. La cantidad debe ser mayor que cero y no puede superar el inventario disponible.',
      // Tooltips de cada campo (pasa el cursor sobre la ⓘ) — una línea simple.
      tipName: 'Cómo llamas a este artículo.',
      tipCategory: 'Qué equipo lo usa — limpieza, mantenimiento o alimentos y bebidas.',
      tipOnHand: 'Cuántos tienes en este momento, en total (incluye los apartados).',
      tipParLevel: 'La cantidad que quieres mantener en stock. Por debajo, toca volver a pedir.',
      tipUnitCost: 'Lo que te cuesta comprar una unidad.',
      tipVendor: 'A quién le pides este artículo.',
    },
  }[lang];
}

export function AddItemSheet({ lang, open, onClose, item, canViewFinancials, defaultCategory = 'housekeeping', customCategories = [], defaultCustomCategoryId = null, hiddenBuiltins = [], onRecordStockLoss }: AddItemSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ais = aisStrings(lang);
  const otherLabel = ais.other;
  const isEdit = item != null;

  const [name, setName] = useState('');
  const [category, setCategory] = useState<InvCat>(defaultCategory);
  // null = the item lives in its built-in `category`; a string id = it lives in
  // that hotel-defined custom category tab (0307).
  const [customCategoryId, setCustomCategoryId] = useState<string | null>(defaultCustomCategoryId);

  // The category row mirrors the hotel's actual tabs: built-in chips only for
  // tabs the hotel still shows (General → Housekeeping + Maintenance,
  // Breakfast → Food & Beverage), plus the custom tabs. An item being edited
  // that lives in a now-hidden built-in bucket keeps its chip so the current
  // assignment stays visible; a hotel with everything hidden and no custom
  // tabs falls back to all three (the picker can't be empty).
  const generalVisible = !hiddenBuiltins.includes('general');
  const breakfastVisible = !hiddenBuiltins.includes('breakfast');
  let visibleCats = CATS.filter((c) => (c === 'breakfast' ? breakfastVisible : generalVisible));
  if (!customCategoryId && !visibleCats.includes(category)) visibleCats = [...visibleCats, category];
  if (visibleCats.length === 0 && customCategories.length === 0) visibleCats = CATS;
  const [currentStock, setCurrentStock] = useState<string>('0');
  // What the on-hand field was seeded with (item value at open, or the DB's
  // post-write-off value). On edit-save we only send currentStock if the user
  // actually CHANGED it — unconditionally sending the open-time snapshot used
  // to fake a physical count (stamping last_counted_at, resetting the
  // occupancy drain estimate) and overwrite counts saved concurrently by
  // someone else while the sheet was open.
  const stockBaselineRef = useRef<number>(0);
  // Reuse the request UUID if a stock correction times out and the manager
  // retries without changing the value. Postgres then replays the result
  // instead of appending a duplicate count-history row.
  const stockCountAttemptRef = useRef<{
    itemId: string;
    value: number;
    requestId: string;
    countedAt: Date;
  } | null>(null);
  const [openingAdjustmentAttempt, setOpeningAdjustmentAttempt] = useState<FrozenOpeningAdjustmentAttempt | null>(null);
  const [parLevel, setParLevel] = useState<string>('0');
  // Set-aside units (0321) — owned but unusable right now. Hotels onboarding
  // existing stock may already have stained/damaged units, so create and edit
  // both expose the field.
  const [setAsideInput, setSetAsideInput] = useState<string>('0');
  // Metadata updates are last-writer-wins. Omitting an untouched Set Aside
  // value prevents a name/par/vendor edit from overwriting a newer operational
  // quantity saved by another staff member while this sheet was open.
  const setAsideBaselineRef = useRef<number>(0);
  const [unitCost, setUnitCost] = useState<string>('');
  const [openingAdjustmentConfirmed, setOpeningAdjustmentConfirmed] = useState(false);
  const [openingAdjustmentQuantity, setOpeningAdjustmentQuantity] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftReadyContext, setDraftReadyContext] = useState('');
  const initialDraftRef = useRef<AddItemDraft | null>(null);
  const [createRetryLocked, setCreateRetryLocked] = useState(false);
  const createAttemptRef = useRef<FrozenInventoryItemCreateAttempt | null>(null);

  const draftScope = item ? `edit:${item.id}` : 'new';
  const draftContext = user?.uid && activePropertyId
    ? `${user.uid}:${activePropertyId}:${draftScope}`
    : '';
  const draftStorageInput = useMemo(() => user?.uid && activePropertyId
    ? { kind: 'item' as const, userId: user.uid, propertyId: activePropertyId, scope: draftScope }
    : null, [activePropertyId, draftScope, user?.uid]);
  const durableAdjustmentInput = useMemo(() => user?.uid && activePropertyId && item
    ? { kind: 'opening-adjustment' as const, userId: user.uid, propertyId: activePropertyId, scope: item.id }
    : null, [activePropertyId, item, user?.uid]);
  const currentDraft: AddItemDraft = useMemo(() => ({
    name, category, customCategoryId, currentStock, setAsideInput, parLevel,
    unitCost, vendor, vendorId, openingAdjustmentConfirmed, openingAdjustmentQuantity,
    openingAdjustmentAttempt,
  }), [
    name, category, customCategoryId, currentStock, setAsideInput, parLevel,
    unitCost, vendor, vendorId, openingAdjustmentConfirmed, openingAdjustmentQuantity,
    openingAdjustmentAttempt,
  ]);
  const adjustmentRetryLocked = isEdit && openingAdjustmentAttempt != null;
  const dirty = draftReadyContext === draftContext
    && initialDraftRef.current != null
    && JSON.stringify(currentDraft) !== JSON.stringify(initialDraftRef.current);

  // Load real vendor records so an item can link to one (vendor_name stays as
  // the free-text fallback). Management-gated API → non-managers just get the
  // free-text field (empty list, no dropdown).
  useEffect(() => {
    if (!open || !activePropertyId) return;
    let cancelled = false;
    void apiListVendors(activePropertyId)
      .then((vs) => { if (!cancelled) setVendors(vs); })
      .catch(() => { if (!cancelled) setVendors([]); });
    return () => { cancelled = true; };
  }, [open, activePropertyId]);

  useEffect(() => {
    if (!open) return;
    setFormError('');
    setDraftRestored(false);
    stockCountAttemptRef.current = null;
    if (item) {
      const durableAttempt = durableAdjustmentInput
        ? loadInventoryOperationAttempt(
            durableAdjustmentInput,
            (value) => {
              const candidate = validOpeningAdjustmentAttempt(value);
              return candidate?.itemId === item.id ? candidate : null;
            },
          )
        : null;
      const initial: AddItemDraft = {
        name: item.name,
        category: item.category as InvCat,
        customCategoryId: item.customCategoryId ?? null,
        currentStock: String(item.currentStock ?? 0),
        setAsideInput: String(Math.max(0, Math.round(item.setAside ?? 0))),
        parLevel: String(item.parLevel ?? 0),
        unitCost: item.unitCost != null ? String(item.unitCost) : '',
        vendor: item.vendorName || '',
        vendorId: item.vendorId ?? null,
        openingAdjustmentConfirmed: false,
        openingAdjustmentQuantity: '',
        openingAdjustmentAttempt: null,
      };
      const stored = draftStorageInput
        ? validAddItemDraft(loadInventoryOverlayDraft<AddItemDraft>(draftStorageInput))
        : null;
      const editable = stored ?? initial;
      const next: AddItemDraft = durableAttempt ? {
        ...editable,
        currentStock: String(durableAttempt.resultingStock),
        unitCost: String(durableAttempt.unitCost),
        openingAdjustmentConfirmed: true,
        openingAdjustmentQuantity: String(durableAttempt.adjustmentQuantity),
        openingAdjustmentAttempt: durableAttempt,
      } : editable;
      createAttemptRef.current = null;
      setCreateRetryLocked(false);
      setName(next.name);
      setCategory(next.category);
      setCustomCategoryId(next.customCategoryId);
      setCurrentStock(next.currentStock);
      stockBaselineRef.current = item.currentStock ?? 0;
      const initialSetAside = Math.max(0, Math.round(item.setAside ?? 0));
      setSetAsideInput(next.setAsideInput);
      setAsideBaselineRef.current = initialSetAside;
      setParLevel(next.parLevel);
      setUnitCost(next.unitCost);
      setVendor(next.vendor);
      setVendorId(next.vendorId);
      setOpeningAdjustmentConfirmed(next.openingAdjustmentConfirmed);
      setOpeningAdjustmentQuantity(next.openingAdjustmentQuantity);
      setOpeningAdjustmentAttempt(next.openingAdjustmentAttempt);
      initialDraftRef.current = initial;
      setDraftRestored(Boolean(stored || durableAttempt));
    } else {
      const restored = activePropertyId
        ? loadInventoryItemCreateAttempt(activePropertyId)
        : null;
      const initial: AddItemDraft = {
        name: '',
        category: defaultCategory,
        customCategoryId: defaultCustomCategoryId,
        currentStock: '0',
        setAsideInput: '0',
        parLevel: '0',
        unitCost: '',
        vendor: '',
        vendorId: null,
        openingAdjustmentConfirmed: false,
        openingAdjustmentQuantity: '',
        openingAdjustmentAttempt: null,
      };
      const stored = !restored && draftStorageInput
        ? validAddItemDraft(loadInventoryOverlayDraft<AddItemDraft>(draftStorageInput))
        : null;
      const next: AddItemDraft = restored ? {
        name: restored.nameInput,
        category: restored.category as InvCat,
        customCategoryId: restored.customCategoryId,
        currentStock: restored.currentStockInput,
        setAsideInput: restored.setAsideInput,
        parLevel: restored.parLevelInput,
        unitCost: restored.unitCostInput,
        vendor: restored.vendorInput,
        vendorId: restored.vendorId,
        openingAdjustmentConfirmed: restored.openingAdjustmentConfirmed,
        openingAdjustmentQuantity: '',
        openingAdjustmentAttempt: null,
      } : stored ?? initial;
      createAttemptRef.current = restored;
      setCreateRetryLocked(!!restored);
      setName(next.name);
      setCategory(next.category);
      setCustomCategoryId(next.customCategoryId);
      setCurrentStock(next.currentStock);
      stockBaselineRef.current = 0;
      setSetAsideInput(next.setAsideInput);
      setAsideBaselineRef.current = 0;
      setParLevel(next.parLevel);
      setUnitCost(next.unitCost);
      setVendor(next.vendor);
      setVendorId(next.vendorId);
      setOpeningAdjustmentConfirmed(next.openingAdjustmentConfirmed);
      setOpeningAdjustmentQuantity(next.openingAdjustmentQuantity);
      setOpeningAdjustmentAttempt(null);
      initialDraftRef.current = initial;
      setDraftRestored(!!stored);
    }
    setDraftReadyContext(draftContext);
  }, [open, item, activePropertyId, defaultCategory, defaultCustomCategoryId, draftContext, draftStorageInput, durableAdjustmentInput]);

  useEffect(() => {
    if (!open || !draftStorageInput || draftReadyContext !== draftContext) return;
    if (dirty || createRetryLocked || adjustmentRetryLocked) {
      persistInventoryOverlayDraft({ ...draftStorageInput, data: currentDraft });
    } else {
      clearInventoryOverlayDraft(draftStorageInput);
    }
  }, [
    open, draftStorageInput, draftReadyContext, draftContext, dirty,
    createRetryLocked, adjustmentRetryLocked, currentDraft,
  ]);

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setFormError('');
    if (!name.trim()) {
      setFormError(ais.nameRequired);
      return;
    }
    const startingStock = Math.max(0, Number(currentStock) || 0);
    const resultingStock = isEdit && currentStock.trim() === ''
      ? stockBaselineRef.current
      : startingStock;
    const setAsideNum = Math.max(0, Math.round(Number(setAsideInput) || 0));
    const onHandForSubset = isEdit && currentStock.trim() === ''
      ? stockBaselineRef.current
      : resultingStock;
    if (setAsideNum > onHandForSubset) {
      setFormError(ais.setAsideTooHigh);
      return;
    }
    if (!isEdit && startingStock > 0) {
      if (!canViewFinancials) {
        setFormError(ais.openingAdjustmentPermission);
        return;
      }
      const startingCost = unitCost.trim() === '' ? Number.NaN : Number(unitCost);
      if (!Number.isFinite(startingCost) || startingCost < 0) {
        setFormError(ais.openingAdjustmentCost);
        return;
      }
      if (!openingAdjustmentConfirmed) {
        setFormError(ais.openingAdjustmentConfirm);
        return;
      }
    }
    const editOpeningAdjustment = isEdit && openingAdjustmentConfirmed;
    const adjustmentQuantity = Number(openingAdjustmentQuantity);
    if (editOpeningAdjustment) {
      if (!canViewFinancials) {
        setFormError(ais.openingAdjustmentPermission);
        return;
      }
      if (!Number.isFinite(adjustmentQuantity) || adjustmentQuantity <= 0 || adjustmentQuantity > resultingStock) {
        setFormError(ais.existingAdjustmentQuantityError);
        return;
      }
      const adjustmentCost = unitCost.trim() === '' ? Number.NaN : Number(unitCost);
      if (!Number.isFinite(adjustmentCost) || adjustmentCost < 0) {
        setFormError(ais.openingAdjustmentCost);
        return;
      }
    }

    // A missed-opening-stock adjustment is additive. Freeze and synchronously
    // verify its exact idempotency envelope before *any* save request begins,
    // so a lost response can only be retried with the same request UUID and
    // values. Once an ambiguous attempt exists, never derive a replacement
    // from newly rendered item data.
    let preparedOpeningAttempt: FrozenOpeningAdjustmentAttempt | null = null;
    if (editOpeningAdjustment && item) {
      const adjustmentCost = Number(unitCost);
      const attempt = openingAdjustmentAttempt ?? {
        itemId: item.id,
        expectedStock: stockBaselineRef.current,
        resultingStock,
        adjustmentQuantity,
        unitCost: adjustmentCost,
        requestId: generateId(),
        effectiveAt: new Date().toISOString(),
      };
      const durableDraft: AddItemDraft = {
        ...currentDraft,
        openingAdjustmentAttempt: attempt,
      };
      const draftPersisted = draftStorageInput
        ? persistInventoryOverlayDraft({ ...draftStorageInput, data: durableDraft })
        : false;
      const attemptPersisted = durableAdjustmentInput
        ? persistInventoryOperationAttempt(durableAdjustmentInput, attempt)
        : false;
      const stored = durableAdjustmentInput
        ? loadInventoryOperationAttempt(
            durableAdjustmentInput,
            (value) => {
              const candidate = validOpeningAdjustmentAttempt(value);
              return candidate?.itemId === item.id ? candidate : null;
            },
          )
        : null;
      if (!draftPersisted || !attemptPersisted || JSON.stringify(stored) !== JSON.stringify(attempt)) {
        setFormError(ais.adjustmentUnsafe);
        return;
      }
      preparedOpeningAttempt = attempt;
      setOpeningAdjustmentAttempt(attempt);
    }
    setSaving(true);
    let metadataSaved = false;
    let createAttemptUsed: FrozenInventoryItemCreateAttempt | null = null;
    let openingAttemptUsed = preparedOpeningAttempt;
    let openingRpcStarted = false;
    try {
      // Unit + lead days are no longer edited here. On EDIT we don't send them
      // (the stored values are preserved); on CREATE we seed sensible defaults
      // below so the ledger's "/ par each" display and reorder lead-time still
      // work.
      const base = {
        name: name.trim(),
        category: category as InventoryCategory,
        // Always explicit: an id assigns the item to a custom tab, null puts it
        // back in its built-in category's bucket.
        customCategoryId: customCategoryId,
        parLevel: Number(parLevel) || 0,
        vendorId: vendorId ?? null,
      };
      if (isEdit && item) {
        // Metadata and stock have different provenance. Metadata stays a normal
        // item update; a deliberately changed on-hand value goes through the
        // atomic count RPC below so stock and count history always land
        // together. An untouched/emptied field sends no stock at all.
        const stockNum = currentStock.trim() === '' ? NaN : Number(currentStock);
        const stockChanged =
          Number.isFinite(stockNum) && stockNum !== stockBaselineRef.current;
        const setAsideChanged = setAsideNum !== setAsideBaselineRef.current;
        await updateInventoryItem(user.uid, activePropertyId, item.id, {
          ...base,
          ...(setAsideChanged ? { setAside: setAsideNum } : {}),
          ...(canViewFinancials && !editOpeningAdjustment
            ? { unitCost: unitCost ? Number(unitCost) : null }
            : {}),
          vendorName: vendor.trim() || null,
        });
        if (setAsideChanged) setAsideBaselineRef.current = setAsideNum;
        metadataSaved = true;
        if (editOpeningAdjustment) {
          const attempt = preparedOpeningAttempt!;
          openingRpcStarted = true;
          await apiRecordInventoryOpeningAdjustment({
            propertyId: activePropertyId,
            ...attempt,
          });
          if (durableAdjustmentInput) clearInventoryOperationAttempt(durableAdjustmentInput, attempt.requestId);
          setOpeningAdjustmentAttempt(null);
          openingAttemptUsed = null;
        } else if (stockChanged) {
          let attempt = stockCountAttemptRef.current;
          if (!attempt || attempt.itemId !== item.id || attempt.value !== stockNum) {
            attempt = {
              itemId: item.id,
              value: stockNum,
              requestId: generateId(),
              countedAt: new Date(),
            };
            stockCountAttemptRef.current = attempt;
          }
          await saveInventoryCountAtomic(
            user.uid,
            activePropertyId,
            attempt.requestId,
            attempt.countedAt,
            user.displayName || user.username || 'team',
            [{
              itemId: item.id,
              expectedStock: stockBaselineRef.current,
              countedStock: stockNum,
            }],
          );
        }
      } else {
        let attempt = createAttemptRef.current;
        if (!attempt) {
          attempt = createFrozenInventoryItemAttempt({
            propertyId: activePropertyId,
            requestId: generateId(),
            itemId: generateId(),
            startedAt: new Date().toISOString(),
            nameInput: name,
            category: category as InventoryCategory,
            customCategoryId,
            currentStockInput: currentStock,
            setAsideInput,
            parLevelInput: parLevel,
            unitCostInput: unitCost,
            vendorInput: vendor,
            vendorId,
            includeUnitCost: canViewFinancials,
            openingAdjustmentConfirmed,
          });
        }
        createAttemptUsed = attempt;
        try {
          // No insert starts until this exact UUID + payload survives a
          // synchronous write/readback. Restricted storage therefore fails
          // before the database can have an ambiguous outcome.
          persistInventoryItemCreateAttempt(attempt);
        } catch (err) {
          console.error('[add-item] recovery persistence failed', err);
          if (!createAttemptRef.current) setCreateRetryLocked(false);
          setFormError(ais.createUnsafe);
          return;
        }
        createAttemptRef.current = attempt;
        setCreateRetryLocked(true);
        await addInventoryItem(user.uid, attempt.propertyId, {
          name: attempt.name,
          category: attempt.category,
          customCategoryId: attempt.customCategoryId,
          parLevel: attempt.parLevel,
          unitCost: attempt.unitCost ?? undefined,
          vendorName: attempt.vendorName ?? undefined,
          vendorId: attempt.vendorId,
          unit: 'each',
          reorderLeadDays: 3,
          currentStock: attempt.currentStock,
          setAside: attempt.setAside,
          notes: inventoryItemCreateMarker(attempt.requestId),
          lastCountedAt: attempt.currentStock > 0 ? new Date(attempt.startedAt) : null,
          openingAdjustmentQuantity: attempt.openingAdjustmentConfirmed ? attempt.currentStock : null,
          openingAdjustmentUnitCost: attempt.openingAdjustmentConfirmed ? attempt.unitCost : null,
          openingAdjustmentAt: attempt.openingAdjustmentConfirmed ? new Date(attempt.startedAt) : null,
          openingAdjustmentRequestId: attempt.openingAdjustmentConfirmed ? attempt.requestId : null,
          propertyId: attempt.propertyId,
        }, attempt.itemId);
        clearInventoryItemCreateAttempt(attempt.propertyId, attempt.requestId);
        createAttemptRef.current = null;
        setCreateRetryLocked(false);
        // The marker exists only to prove an ambiguous retry belongs to this
        // exact row. Cleanup is metadata-only and may safely finish later.
        void updateInventoryItem(user.uid, attempt.propertyId, attempt.itemId, { notes: '' })
          .catch((err) => console.error('[add-item] marker cleanup failed', err));
      }
      if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
      onClose();
    } catch (err) {
      console.error('[add-item] save failed', err);
      if (createAttemptUsed) {
        if (isDefinitiveInventoryItemCreateFailure(err)) {
          clearInventoryItemCreateAttempt(createAttemptUsed.propertyId, createAttemptUsed.requestId);
          if (createAttemptRef.current?.requestId === createAttemptUsed.requestId) {
            createAttemptRef.current = null;
            setCreateRetryLocked(false);
          }
        } else {
          // Unknown transport outcome: retain and lock the exact item UUID and
          // fields. Retry can only resend this same insert.
          createAttemptRef.current = createAttemptUsed;
          setCreateRetryLocked(true);
        }
      }
      let openingAdjustmentUnknown = false;
      if (openingAttemptUsed) {
        openingAdjustmentUnknown = openingRpcStarted
          && !isDefinitiveDeliveryFailure(err, adjustmentRetryLocked);
        if (openingAdjustmentUnknown) {
          setOpeningAdjustmentAttempt(openingAttemptUsed);
        } else {
          if (durableAdjustmentInput) {
            clearInventoryOperationAttempt(durableAdjustmentInput, openingAttemptUsed.requestId);
          }
          setOpeningAdjustmentAttempt(null);
        }
      }
      setFormError(
        createAttemptUsed && !isDefinitiveInventoryItemCreateFailure(err)
          ? ais.createPending
          : openingAdjustmentUnknown
          ? ais.adjustmentPending
          : metadataSaved && (err as { code?: unknown })?.code === '40001'
          ? ais.detailsSavedCountConflict
          : ais.saveFailed,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!user || !activePropertyId || !item || saving || createRetryLocked || adjustmentRetryLocked) return;
    if ((item.currentStock ?? 0) > 0) {
      setFormError(ais.archiveStockFirst);
      return;
    }
    if (!confirm(ais.confirmArchive(item.name))) return;
    setSaving(true);
    try {
      await archiveInventoryItem(user.uid, activePropertyId, item.id);
      if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
      onClose();
    } catch (err) {
      console.error('[add-item] archive failed', err);
      setFormError(ais.couldNotArchive);
    } finally {
      setSaving(false);
    }
  };

  const handleRecordStockLoss = () => {
    if (!item || !onRecordStockLoss || saving || createRetryLocked || adjustmentRetryLocked) return;
    if (dirty && !confirm(ais.recordLossConfirm)) return;
    if (dirty && draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
    onRecordStockLoss(item);
  };

  const requestClose = () => {
    if (saving || createRetryLocked || adjustmentRetryLocked) return;
    if (dirty && !confirm(ais.discardConfirm)) return;
    if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
    onClose();
  };

  return (
    <Overlay
      open={open}
      onClose={requestClose}
      hasUnsavedChanges={dirty}
      eyebrow={isEdit ? ais.editItem : ais.newItem}
      italic={isEdit ? item?.name : ais.addToInventory}
      width={640}
      footer={
        <>
          {isEdit && (
            <div style={{ marginRight: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Btn variant="ghost" size="md" onClick={handleArchive} disabled={saving || createRetryLocked || adjustmentRetryLocked} style={{ color: T.warm }}>
                {ais.archive}
              </Btn>
              {onRecordStockLoss && (item.currentStock ?? 0) > 0 && (
                <Btn variant="ghost" size="md" onClick={handleRecordStockLoss} disabled={saving || createRetryLocked || adjustmentRetryLocked} style={{ color: T.terra }}>
                  {ais.recordLoss}
                </Btn>
              )}
            </div>
          )}
          <Btn variant="ghost" size="md" onClick={requestClose} disabled={saving || createRetryLocked || adjustmentRetryLocked}>
            {ais.cancel}
          </Btn>
          <Btn
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={saving || !name.trim()}
            aria-busy={saving}
          >
            {saving
              ? ais.saving
              : adjustmentRetryLocked
                ? ais.retryAdjustment
                : isEdit
                  ? ais.save
                  : createRetryLocked
                    ? ais.retryCreate
                    : ais.addItem}
          </Btn>
        </>
      }
    >
      {createRetryLocked && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 9,
            background: T.warmDim,
            color: T.warm,
            fontFamily: fonts.sans,
            fontSize: 12.5,
          }}
        >
          {ais.createPending}
        </div>
      )}
      {adjustmentRetryLocked && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 9,
            background: T.warmDim,
            color: T.warm,
            fontFamily: fonts.sans,
            fontSize: 12.5,
          }}
        >
          {ais.adjustmentPending}
        </div>
      )}
      {draftRestored && !createRetryLocked && !adjustmentRetryLocked && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 9,
            background: T.tealDim,
            color: T.tealText,
            fontFamily: fonts.sans,
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          {ais.draftRestored}
        </div>
      )}
      {formError && (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 9,
            background: T.warmDim,
            border: `1px solid ${T.warm}55`,
            color: T.warm,
            fontFamily: fonts.sans,
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          {formError}
        </div>
      )}
      <fieldset
        disabled={saving || createRetryLocked || adjustmentRetryLocked}
        aria-busy={saving}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
      <div className={overlayStyles.formStack}>
        <Field label={ais.name} tip={ais.tipName}>
          <input
            className={overlayStyles.formControl}
            aria-label={ais.name}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ais.namePh}
            style={inputStyle}
          />
        </Field>

        <Field label={ais.category} tip={ais.tipCategory}>
          <div className={overlayStyles.categoryRow} role="group" aria-label={ais.category}>
            {visibleCats.map((c) => {
              // A built-in chip is active only when the item isn't in a custom tab.
              const active = !customCategoryId && category === c;
              return (
                <CatChip key={c} active={active} label={catLabelFor(lang, c)} onClick={() => { setCategory(c); setCustomCategoryId(null); }} />
              );
            })}
            {customCategories.map((cc) => (
              <CatChip
                key={cc.id}
                active={customCategoryId === cc.id}
                label={cc.name}
                onClick={() => setCustomCategoryId(cc.id)}
              />
            ))}
          </div>
        </Field>

        <div className={overlayStyles.formGrid2}>
          <Field label={ais.onHand} tip={ais.tipOnHand}>
            <input
              className={overlayStyles.formControl}
              aria-label={ais.onHand}
              type="number"
              min="0"
              inputMode="decimal"
              value={currentStock}
              // numGuard blocks "-5", "abc", "1e10" at type-time so the saved
              // value can't be junk.
              onChange={(e) => { const v = e.target.value; if (numGuard(v)) setCurrentStock(v); }}
              style={inputStyle}
            />
          </Field>
          <Field label={ais.parLevel} tip={ais.tipParLevel}>
            <input
              className={overlayStyles.formControl}
              aria-label={ais.parLevel}
              type="number"
              min="0"
              inputMode="decimal"
              value={parLevel}
              onChange={(e) => { const v = e.target.value; if (numGuard(v)) setParLevel(v); }}
              style={inputStyle}
            />
          </Field>
        </div>

        {/* Total on hand includes this pile; the live helper makes the usable
            quantity explicit before either a create or edit is saved. */}
        <div className={overlayStyles.formGrid2} style={{ alignItems: 'end' }}>
          <Field label={ais.setAside} tip={setAsideTip(lang)}>
            <input
              className={overlayStyles.formControl}
              aria-label={ais.setAside}
              type="number"
              min="0"
              inputMode="numeric"
              value={setAsideInput}
              onChange={(e) => { const v = e.target.value; if (intGuard(v)) setSetAsideInput(v); }}
              style={inputStyle}
            />
          </Field>
          <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 500, color: T.ink2, paddingBottom: 10 }}>
            {ais.usableNow(Math.max(0, (Number(currentStock) || 0) - (Number(setAsideInput) || 0)))}
          </span>
        </div>

        <div className={canViewFinancials ? overlayStyles.formGrid2 : undefined}>
          {canViewFinancials && (
            <Field label={ais.unitCost} tip={ais.tipUnitCost}>
              <input
                className={overlayStyles.formControl}
                aria-label={ais.unitCost}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={unitCost}
                onChange={(e) => { const v = e.target.value; if (numGuard(v)) setUnitCost(v); }}
                placeholder="0.00"
                style={inputStyle}
              />
            </Field>
          )}
          <Field label={ais.vendor} tip={ais.tipVendor}>
            {vendors.length > 0 && (
              <select
                className={overlayStyles.formControl}
                aria-label={ais.vendor}
                value={vendorId ?? ''}
                onChange={(e) => {
                  const id = e.target.value || null;
                  setVendorId(id);
                  if (id) {
                    const v = vendors.find((x) => x.id === id);
                    if (v) setVendor(v.name);
                  }
                }}
                style={{ ...inputStyle, marginBottom: 6 }}
              >
                <option value="">{otherLabel}</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            )}
            <input
              className={overlayStyles.formControl}
              aria-label={ais.supplier}
              type="text"
              value={vendor}
              onChange={(e) => { setVendor(e.target.value); setVendorId(null); }}
              placeholder={ais.supplier}
              style={inputStyle}
            />
          </Field>
        </div>

        {!isEdit && (Number(currentStock) || 0) > 0 && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: T.warmDim,
              border: `1px solid ${T.rule}`,
              color: T.ink,
              fontFamily: fonts.sans,
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700 }}>{ais.openingAdjustmentTitle}</div>
            <div style={{ color: T.ink2, marginTop: 3 }}>
              {canViewFinancials ? ais.openingAdjustmentBody : ais.openingAdjustmentPermission}
            </div>
            {canViewFinancials && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, cursor: 'pointer' }}>
                <input
                  aria-label={ais.openingAdjustmentConfirm}
                  type="checkbox"
                  checked={openingAdjustmentConfirmed}
                  onChange={(event) => setOpeningAdjustmentConfirmed(event.target.checked)}
                  style={{ marginTop: 2, width: 18, height: 18, flex: 'none' }}
                />
                <span>{ais.openingAdjustmentConfirm}</span>
              </label>
            )}
          </div>
        )}

        {isEdit && canViewFinancials && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: openingAdjustmentConfirmed ? T.warmDim : 'rgba(31,35,28,0.025)',
              border: `1px solid ${T.rule}`,
              color: T.ink,
              fontFamily: fonts.sans,
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700 }}>{ais.existingAdjustmentTitle}</div>
            <div style={{ color: T.ink2, marginTop: 3 }}>{ais.existingAdjustmentBody}</div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, cursor: 'pointer' }}>
              <input
                aria-label={ais.existingAdjustmentConfirm}
                type="checkbox"
                checked={openingAdjustmentConfirmed}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setOpeningAdjustmentConfirmed(checked);
                  if (checked && openingAdjustmentQuantity.trim() === '') {
                    const increase = Math.max(0, (Number(currentStock) || 0) - stockBaselineRef.current);
                    setOpeningAdjustmentQuantity(increase > 0 ? String(increase) : '');
                  }
                }}
                style={{ marginTop: 2, width: 18, height: 18, flex: 'none' }}
              />
              <span>{ais.existingAdjustmentConfirm}</span>
            </label>
            {openingAdjustmentConfirmed && (
              <div style={{ marginTop: 10, maxWidth: 220 }}>
                <Field label={ais.existingAdjustmentQuantity}>
                  <input
                    className={overlayStyles.formControl}
                    aria-label={ais.existingAdjustmentQuantity}
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={openingAdjustmentQuantity}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (numGuard(value)) setOpeningAdjustmentQuantity(value);
                    }}
                    placeholder="0"
                    style={inputStyle}
                  />
                </Field>
              </div>
            )}
          </div>
        )}
      </div>
      </fieldset>
    </Overlay>
  );
}

function CatChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={overlayStyles.categoryChip}
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: '8px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.controlBorder}`,
        fontFamily: fonts.sans,
        fontSize: 13,
        fontWeight: 600,
        maxWidth: 200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function Field({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Caps size={11} weight={700} className={overlayStyles.fieldLabel}>{label}</Caps>
        {tip && <InfoTip text={tip} />}
      </div>
      {children}
    </div>
  );
}

// A tiny ⓘ that reveals a plain-language tooltip on hover/focus. The bubble is
// position:fixed (measured off the icon) so it never clips inside the sheet's
// scroll box — the Overlay scrim's backdrop-filter makes it the containing
// block, and the scrim spans the viewport, so these are effectively viewport
// coordinates (same trick as the StaxisMenu popover).
function InfoTip({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.top - 8, left: r.left + r.width / 2 });
  };
  const hide = () => setPos(null);
  return (
    <span style={{ display: 'inline-flex' }}>
      <button
        ref={ref}
        type="button"
        className={overlayStyles.compactButton}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => e.preventDefault()}
        aria-label={text}
        style={{
          width: 30,
          minWidth: 30,
          height: 30,
          minHeight: 30,
          flex: 'none',
          borderRadius: 999,
          border: `1px solid ${T.controlBorder}`,
          background: 'transparent',
          color: T.ink2,
          cursor: 'help',
          padding: 0,
          fontFamily: fonts.serif ?? fonts.sans,
          fontSize: 10,
          fontStyle: 'italic',
          fontWeight: 700,
          lineHeight: 1,
          textTransform: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        i
      </button>
      {pos && (
        <span
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translate(-50%, -100%)',
            zIndex: 2200,
            width: 'max-content',
            maxWidth: 240,
            background: T.ink,
            color: T.bg,
            borderRadius: 9,
            padding: '8px 11px',
            fontFamily: fonts.sans,
            fontSize: 12,
            fontWeight: 400,
            lineHeight: 1.45,
            letterSpacing: 0,
            textTransform: 'none',
            boxShadow: '0 10px 30px -10px rgba(31,42,32,0.45)',
            pointerEvents: 'none',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
