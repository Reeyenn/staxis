'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
} from '@/lib/db';
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
      delete: 'Delete',
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
      confirmRemove: (n: string) => `Remove "${n}" from inventory?`,
      couldNotRemove: 'Could not remove the item.',
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
      delete: 'Eliminar',
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
      confirmRemove: (n: string) => `¿Quitar "${n}" del inventario?`,
      couldNotRemove: 'No se pudo quitar el artículo.',
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

export function AddItemSheet({ lang, open, onClose, item, defaultCategory = 'housekeeping', customCategories = [], defaultCustomCategoryId = null }: AddItemSheetProps) {
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
  const [parLevel, setParLevel] = useState<string>('0');
  const [unitCost, setUnitCost] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [saving, setSaving] = useState(false);

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
    if (item) {
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
      setName('');
      setCategory(defaultCategory);
      setCustomCategoryId(defaultCustomCategoryId);
      setCurrentStock('0');
      stockBaselineRef.current = 0;
      setParLevel('0');
      setUnitCost('');
      setVendor('');
      setVendorId(null);
    }
  }, [open, item, defaultCategory, defaultCustomCategoryId]);

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    if (!name.trim()) return;
    setSaving(true);
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
        unitCost: unitCost ? Number(unitCost) : undefined,
        vendorName: vendor.trim() || undefined,
        vendorId: vendorId ?? null,
      };
      if (isEdit && item) {
        // Metadata edit: only send currentStock if the user deliberately
        // changed the on-hand field (an intentional stock correction — the db
        // layer then rightly treats it as a count). An untouched or emptied
        // field sends NO stock, so last_counted_at / the consumption-estimate
        // window are left alone and a count saved on another device while
        // this sheet was open can't be overwritten by a typo-fix Save.
        const stockNum = currentStock.trim() === '' ? NaN : Number(currentStock);
        const stockChanged =
          Number.isFinite(stockNum) && stockNum !== stockBaselineRef.current;
        await updateInventoryItem(user.uid, activePropertyId, item.id, {
          ...base,
          ...(stockChanged ? { currentStock: stockNum } : {}),
        });
      } else {
        await addInventoryItem(user.uid, activePropertyId, {
          ...base,
          unit: 'each',
          reorderLeadDays: 3,
          currentStock: Number(currentStock) || 0,
          propertyId: activePropertyId,
        });
      }
      onClose();
    } catch (err) {
      console.error('[add-item] save failed', err);
      alert(ais.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!user || !activePropertyId || !item || saving) return;
    if (!confirm(ais.confirmRemove(item.name))) return;
    setSaving(true);
    try {
      await deleteInventoryItem(user.uid, activePropertyId, item.id);
      onClose();
    } catch (err) {
      console.error('[add-item] delete failed', err);
      alert(ais.couldNotRemove);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={isEdit ? ais.editItem : ais.newItem}
      italic={isEdit ? item?.name : ais.addToInventory}
      width={640}
      footer={
        <>
          {isEdit && (
            <Btn variant="ghost" size="md" onClick={handleDelete} disabled={saving} style={{ marginRight: 'auto', color: T.warm }}>
              {ais.delete}
            </Btn>
          )}
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            {ais.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? ais.saving : isEdit ? ais.save : ais.addItem}
          </Btn>
        </>
      }
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
