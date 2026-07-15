'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import { numGuard, inputLg as inputStyle } from './form-kit';
import { apiListVendors } from '../ordering-api';
import { catLabelFor, type Lang } from '../inv-i18n';

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
}

const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

// Co-located strings for the add/edit item sheet.
function aisStrings(lang: Lang) {
  return {
    en: {
      editItem: 'Edit item',
      newItem: 'New item',
      addToInventory: 'Add to inventory',
      other: '— Other (type below) —',
      archive: 'Archive',
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save',
      addItem: 'Add item',
      name: 'Name',
      namePh: 'e.g. Bath towels',
      category: 'Category',
      onHand: 'On hand',
      parLevel: 'Par level',
      unitCost: 'Unit cost ($)',
      vendor: 'Vendor',
      supplier: 'Supplier',
      saveFailed: 'Saving the item failed. Please try again.',
      createPending: 'The result could not be confirmed. These exact item fields are locked to the same safe retry so another item cannot be created by mistake.',
      retryCreate: 'Retry exact item',
      createUnsafe: 'The item was not sent because a recovery copy could not be saved safely. Your fields are still here.',
      detailsSavedCountConflict: 'The item details were saved, but on-hand stock changed elsewhere. Refresh the inventory and enter the count again; the newer stock was not overwritten.',
      confirmArchive: (n: string) => `Archive "${n}"? It will be hidden from active inventory, but all count and delivery history will be kept.`,
      couldNotArchive: 'Could not archive the item.',
      // Field tooltips (hover the ⓘ) — one plain line each.
      tipName: 'What you call this item.',
      tipCategory: 'Which team uses it — housekeeping, maintenance, or food & beverage.',
      tipOnHand: 'How many you have right now.',
      tipParLevel: 'The amount you want to keep in stock. Below it means it’s time to reorder.',
      tipUnitCost: 'What one unit costs you to buy.',
      tipVendor: 'Who you order this from.',
    },
    es: {
      editItem: 'Editar artículo',
      newItem: 'Nuevo artículo',
      addToInventory: 'Agregar al inventario',
      other: '— Otro (escribe abajo) —',
      archive: 'Archivar',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      save: 'Guardar',
      addItem: 'Agregar artículo',
      name: 'Nombre',
      namePh: 'ej. Toallas de baño',
      category: 'Categoría',
      onHand: 'Disponible',
      parLevel: 'Nivel par',
      unitCost: 'Costo unitario ($)',
      vendor: 'Proveedor',
      supplier: 'Proveedor',
      saveFailed: 'No se pudo guardar el artículo. Inténtalo de nuevo.',
      createPending: 'No se pudo confirmar el resultado. Estos datos exactos están bloqueados para el mismo reintento seguro y así no crear otro artículo por error.',
      retryCreate: 'Reintentar el mismo artículo',
      createUnsafe: 'El artículo no se envió porque no se pudo guardar una copia segura. Tus datos siguen aquí.',
      detailsSavedCountConflict: 'Los detalles se guardaron, pero el inventario disponible cambió en otro lugar. Actualiza el inventario y vuelve a ingresar el conteo; no se sobrescribió el valor más reciente.',
      confirmArchive: (n: string) => `¿Archivar "${n}"? Se ocultará del inventario activo, pero se conservará todo el historial de conteos y entregas.`,
      couldNotArchive: 'No se pudo archivar el artículo.',
      // Tooltips de cada campo (pasa el cursor sobre la ⓘ) — una línea simple.
      tipName: 'Cómo llamas a este artículo.',
      tipCategory: 'Qué equipo lo usa — limpieza, mantenimiento o alimentos y bebidas.',
      tipOnHand: 'Cuántos tienes en este momento.',
      tipParLevel: 'La cantidad que quieres mantener en stock. Por debajo, toca volver a pedir.',
      tipUnitCost: 'Lo que te cuesta comprar una unidad.',
      tipVendor: 'A quién le pides este artículo.',
    },
  }[lang];
}

export function AddItemSheet({ lang, open, onClose, item, canViewFinancials, defaultCategory = 'housekeeping', customCategories = [], defaultCustomCategoryId = null }: AddItemSheetProps) {
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
  const [parLevel, setParLevel] = useState<string>('0');
  const [unitCost, setUnitCost] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [saving, setSaving] = useState(false);
  const [createRetryLocked, setCreateRetryLocked] = useState(false);
  const createAttemptRef = useRef<FrozenInventoryItemCreateAttempt | null>(null);

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
    stockCountAttemptRef.current = null;
    if (item) {
      createAttemptRef.current = null;
      setCreateRetryLocked(false);
      setName(item.name);
      setCategory(item.category as InvCat);
      setCustomCategoryId(item.customCategoryId ?? null);
      setCurrentStock(String(item.currentStock ?? 0));
      stockBaselineRef.current = item.currentStock ?? 0;
      setParLevel(String(item.parLevel ?? 0));
      setUnitCost(item.unitCost != null ? String(item.unitCost) : '');
      setVendor(item.vendorName || '');
      setVendorId(item.vendorId ?? null);
    } else {
      const restored = activePropertyId
        ? loadInventoryItemCreateAttempt(activePropertyId)
        : null;
      createAttemptRef.current = restored;
      setCreateRetryLocked(!!restored);
      setName(restored?.nameInput ?? '');
      setCategory((restored?.category as InvCat | undefined) ?? defaultCategory);
      setCustomCategoryId(restored ? restored.customCategoryId : defaultCustomCategoryId);
      setCurrentStock(restored?.currentStockInput ?? '0');
      stockBaselineRef.current = 0;
      setParLevel(restored?.parLevelInput ?? '0');
      setUnitCost(restored?.unitCostInput ?? '');
      setVendor(restored?.vendorInput ?? '');
      setVendorId(restored?.vendorId ?? null);
    }
  }, [open, item, activePropertyId, defaultCategory, defaultCustomCategoryId]);

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    if (!name.trim()) return;
    setSaving(true);
    let metadataSaved = false;
    let createAttemptUsed: FrozenInventoryItemCreateAttempt | null = null;
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
        await updateInventoryItem(user.uid, activePropertyId, item.id, {
          ...base,
          ...(canViewFinancials
            ? { unitCost: unitCost ? Number(unitCost) : null }
            : {}),
          vendorName: vendor.trim() || null,
        });
        metadataSaved = true;
        if (stockChanged) {
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
            parLevelInput: parLevel,
            unitCostInput: unitCost,
            vendorInput: vendor,
            vendorId,
            includeUnitCost: canViewFinancials,
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
          alert(ais.createUnsafe);
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
          notes: inventoryItemCreateMarker(attempt.requestId),
          lastCountedAt: attempt.currentStock > 0 ? new Date(attempt.startedAt) : null,
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
      alert(
        createAttemptUsed && !isDefinitiveInventoryItemCreateFailure(err)
          ? ais.createPending
          : metadataSaved && (err as { code?: unknown })?.code === '40001'
          ? ais.detailsSavedCountConflict
          : ais.saveFailed,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!user || !activePropertyId || !item || saving) return;
    if (!confirm(ais.confirmArchive(item.name))) return;
    setSaving(true);
    try {
      await archiveInventoryItem(user.uid, activePropertyId, item.id);
      onClose();
    } catch (err) {
      console.error('[add-item] archive failed', err);
      alert(ais.couldNotArchive);
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (saving || createRetryLocked) return;
    onClose();
  };

  return (
    <Overlay
      open={open}
      onClose={requestClose}
      eyebrow={isEdit ? ais.editItem : ais.newItem}
      italic={isEdit ? item?.name : ais.addToInventory}
      width={640}
      footer={
        <>
          {isEdit && (
            <Btn variant="ghost" size="md" onClick={handleArchive} disabled={saving} style={{ marginRight: 'auto', color: T.warm }}>
              {ais.archive}
            </Btn>
          )}
          <Btn variant="ghost" size="md" onClick={requestClose} disabled={saving || createRetryLocked}>
            {ais.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? ais.saving : isEdit ? ais.save : createRetryLocked ? ais.retryCreate : ais.addItem}
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
      <fieldset
        disabled={saving || createRetryLocked}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={ais.name} tip={ais.tipName}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ais.namePh}
            style={inputStyle}
          />
        </Field>

        <Field label={ais.category} tip={ais.tipCategory}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CATS.map((c) => {
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label={ais.onHand} tip={ais.tipOnHand}>
            <input
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
              type="number"
              min="0"
              inputMode="decimal"
              value={parLevel}
              onChange={(e) => { const v = e.target.value; if (numGuard(v)) setParLevel(v); }}
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: canViewFinancials ? '1fr 1fr' : '1fr', gap: 12 }}>
          {canViewFinancials && (
            <Field label={ais.unitCost} tip={ais.tipUnitCost}>
              <input
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
              type="text"
              value={vendor}
              onChange={(e) => { setVendor(e.target.value); setVendorId(null); }}
              placeholder={ais.supplier}
              style={inputStyle}
            />
          </Field>
        </div>
      </div>
      </fieldset>
    </Overlay>
  );
}

function CatChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        fontFamily: fonts.sans,
        fontSize: 13,
        fontWeight: 500,
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
        <Caps>{label}</Caps>
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
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => e.preventDefault()}
        aria-label={text}
        style={{
          width: 15,
          height: 15,
          flex: 'none',
          borderRadius: 999,
          border: `1px solid ${T.rule}`,
          background: 'transparent',
          color: T.ink3,
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
