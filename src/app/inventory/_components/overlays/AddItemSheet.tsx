'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
} from '@/lib/db';
import type { InventoryItem, InventoryCategory } from '@/types';
import type { Vendor } from '@/lib/ordering/types';

import { T, fonts, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
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
      unit: 'Unit',
      unitPh: 'each / bottle / case',
      unitCost: 'Unit cost ($)',
      vendor: 'Vendor',
      supplier: 'Supplier',
      leadDays: 'Lead days',
      notes: 'Notes (optional)',
      notesPh: 'Anything worth remembering',
      saveFailed: 'Saving the item failed. Please try again.',
      confirmRemove: (n: string) => `Remove "${n}" from inventory?`,
      couldNotRemove: 'Could not remove the item.',
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
      unit: 'Unidad',
      unitPh: 'unidad / botella / caja',
      unitCost: 'Costo unitario ($)',
      vendor: 'Proveedor',
      supplier: 'Proveedor',
      leadDays: 'Días de entrega',
      notes: 'Notas (opcional)',
      notesPh: 'Algo que valga la pena recordar',
      saveFailed: 'No se pudo guardar el artículo. Inténtalo de nuevo.',
      confirmRemove: (n: string) => `¿Quitar "${n}" del inventario?`,
      couldNotRemove: 'No se pudo quitar el artículo.',
    },
  }[lang];
}

export function AddItemSheet({ lang, open, onClose, item, defaultCategory = 'housekeeping' }: AddItemSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ais = aisStrings(lang);
  const otherLabel = ais.other;
  const isEdit = item != null;

  const [name, setName] = useState('');
  const [category, setCategory] = useState<InvCat>(defaultCategory);
  const [currentStock, setCurrentStock] = useState<string>('0');
  const [parLevel, setParLevel] = useState<string>('0');
  const [unit, setUnit] = useState('each');
  const [unitCost, setUnitCost] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [leadDays, setLeadDays] = useState<string>('3');
  const [notes, setNotes] = useState('');
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
      setCurrentStock(String(item.currentStock ?? 0));
      setParLevel(String(item.parLevel ?? 0));
      setUnit(item.unit || 'each');
      setUnitCost(item.unitCost != null ? String(item.unitCost) : '');
      setVendor(item.vendorName || '');
      setVendorId(item.vendorId ?? null);
      setLeadDays(String(item.reorderLeadDays ?? 3));
      setNotes(item.notes || '');
    } else {
      setName('');
      setCategory(defaultCategory);
      setCurrentStock('0');
      setParLevel('0');
      setUnit('each');
      setUnitCost('');
      setVendor('');
      setVendorId(null);
      setLeadDays('3');
      setNotes('');
    }
  }, [open, item, defaultCategory]);

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    if (!name.trim()) return;
    setSaving(true);
    try {
      const base = {
        name: name.trim(),
        category: category as InventoryCategory,
        currentStock: Number(currentStock) || 0,
        parLevel: Number(parLevel) || 0,
        unit: unit.trim() || 'each',
        unitCost: unitCost ? Number(unitCost) : undefined,
        vendorName: vendor.trim() || undefined,
        vendorId: vendorId ?? null,
        reorderLeadDays: leadDays ? Number(leadDays) : undefined,
        notes: notes.trim() || undefined,
      };
      if (isEdit && item) {
        await updateInventoryItem(user.uid, activePropertyId, item.id, base);
      } else {
        await addInventoryItem(user.uid, activePropertyId, {
          ...base,
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
        <Field label={ais.name}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ais.namePh}
            style={inputStyle}
          />
        </Field>

        <Field label={ais.category}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CATS.map((c) => {
              const active = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
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
                  }}
                >
                  {catLabelFor(lang, c)}
                </button>
              );
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label={ais.onHand}>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              value={currentStock}
              // Reject anything that isn't empty or a non-negative decimal in progress.
              // Blocks "-5", "abc", "1e10" at type-time so the saved value can't be junk.
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setCurrentStock(v); }}
              style={inputStyle}
            />
          </Field>
          <Field label={ais.parLevel}>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              value={parLevel}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setParLevel(v); }}
              style={inputStyle}
            />
          </Field>
          <Field label={ais.unit}>
            <input
              type="text"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder={ais.unitPh}
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label={ais.unitCost}>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={unitCost}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setUnitCost(v); }}
              placeholder="0.00"
              style={inputStyle}
            />
          </Field>
          <Field label={ais.vendor}>
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
          <Field label={ais.leadDays}>
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={leadDays}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setLeadDays(v); }}
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label={ais.notes}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={ais.notesPh}
            style={{
              ...inputStyle,
              height: 'auto',
              padding: '10px 14px',
              resize: 'vertical',
              lineHeight: 1.5,
            }}
          />
        </Field>
      </div>
    </Overlay>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Caps>{label}</Caps>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 40,
  padding: '0 14px',
  borderRadius: 10,
  boxSizing: 'border-box',
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: fonts.sans,
  fontSize: 14,
  color: T.ink,
  outline: 'none',
};
