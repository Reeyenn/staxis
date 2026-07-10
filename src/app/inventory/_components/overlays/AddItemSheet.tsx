'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  addInventoryDiscard,
} from '@/lib/db';
import type { InventoryItem, InventoryCategory, InventoryDiscardReason } from '@/types';
import type { Vendor } from '@/lib/ordering/types';

import { T, fonts, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { numGuard, intGuard, inputLg as inputStyle } from './form-kit';
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
      // Write-off (waste) section.
      writeOff: 'Write off waste',
      writeOffHint: 'Removes damaged / lost stock so it isn’t counted as usage.',
      writeOffQty: 'Quantity',
      writeOffReason: 'Reason',
      writeOffNotes: 'Note (optional)',
      writeOffNotesPh: 'e.g. water-damaged case',
      writeOffBtn: 'Write off',
      writingOff: 'Writing off…',
      writeOffDone: 'Written off',
      writeOffFailed: 'Could not write off. Please try again.',
      reasonStained: 'Stained',
      reasonDamaged: 'Damaged',
      reasonLost: 'Lost',
      reasonTheft: 'Theft',
      reasonOther: 'Other',
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
      // Write-off (waste) section.
      writeOff: 'Dar de baja (merma)',
      writeOffHint: 'Quita el stock dañado / perdido para que no cuente como uso.',
      writeOffQty: 'Cantidad',
      writeOffReason: 'Motivo',
      writeOffNotes: 'Nota (opcional)',
      writeOffNotesPh: 'ej. caja dañada por agua',
      writeOffBtn: 'Dar de baja',
      writingOff: 'Dando de baja…',
      writeOffDone: 'Dado de baja',
      writeOffFailed: 'No se pudo dar de baja. Inténtalo de nuevo.',
      reasonStained: 'Manchado',
      reasonDamaged: 'Dañado',
      reasonLost: 'Perdido',
      reasonTheft: 'Robo',
      reasonOther: 'Otro',
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

  // Write-off (waste) sub-form — edit mode only.
  const [woQty, setWoQty] = useState('');
  const [woReason, setWoReason] = useState<InventoryDiscardReason>('damaged');
  const [woNotes, setWoNotes] = useState('');
  const [woSaving, setWoSaving] = useState(false);
  const [woDone, setWoDone] = useState(false);

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
    // Reset the write-off sub-form whenever the sheet opens or switches items.
    setWoQty('');
    setWoReason('damaged');
    setWoNotes('');
    setWoDone(false);
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

  const woQtyNum = Number(woQty);
  const woValid = Number.isFinite(woQtyNum) && woQtyNum > 0;

  const handleWriteOff = async () => {
    if (!user || !activePropertyId || !item || woSaving || !woValid) return;
    setWoSaving(true);
    setWoDone(false);
    try {
      // Snapshot the unit cost from the item edit form (may differ from the
      // stored value if the user just changed it) so cost_value is truthful.
      const uc = unitCost ? Number(unitCost) : (item.unitCost ?? undefined);
      const res = await addInventoryDiscard(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        itemId: item.id,
        itemName: item.name,
        quantity: woQtyNum,
        reason: woReason,
        unitCost: uc,
        costValue: uc != null ? Math.round(uc * woQtyNum * 100) / 100 : undefined,
        discardedAt: new Date(),
        discardedBy: user.displayName || user.username || undefined,
        notes: woNotes.trim() || undefined,
      });
      // Reflect the decremented stock in the on-hand field. Use the DB's
      // AUTHORITATIVE post-decrement value (res.newStock) — NOT a number
      // derived from the editable on-hand field, which may have drifted from
      // the stored value and could otherwise overwrite real stock on a later
      // Save. Fall back to the stored item value if the read-back failed.
      const nextStock = res.newStock ?? Math.max(0, (item.currentStock ?? 0) - woQtyNum);
      setCurrentStock(String(nextStock));
      setWoQty('');
      setWoNotes('');
      setWoDone(true);
    } catch (err) {
      console.error('[add-item] write-off failed', err);
      alert(ais.writeOffFailed);
    } finally {
      setWoSaving(false);
    }
  };

  const reasonOptions: Array<{ value: InventoryDiscardReason; label: string }> = [
    { value: 'damaged', label: ais.reasonDamaged },
    { value: 'stained', label: ais.reasonStained },
    { value: 'lost', label: ais.reasonLost },
    { value: 'theft', label: ais.reasonTheft },
    { value: 'other', label: ais.reasonOther },
  ];

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
              // numGuard blocks "-5", "abc", "1e10" at type-time so the saved
              // value can't be junk.
              onChange={(e) => { const v = e.target.value; if (numGuard(v)) setCurrentStock(v); }}
              style={inputStyle}
            />
          </Field>
          <Field label={ais.parLevel}>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              value={parLevel}
              onChange={(e) => { const v = e.target.value; if (numGuard(v)) setParLevel(v); }}
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
              onChange={(e) => { const v = e.target.value; if (numGuard(v)) setUnitCost(v); }}
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
              onChange={(e) => { const v = e.target.value; if (intGuard(v)) setLeadDays(v); }}
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

        {/* Write-off (waste) — edit mode only. Logs a discard so thrown-away
            stock isn't learned as consumption, and drops the on-hand count. */}
        {isEdit && (
          <div
            style={{
              marginTop: 4,
              paddingTop: 16,
              borderTop: `1px solid ${T.rule}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Caps>{ais.writeOff}</Caps>
              <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3, lineHeight: 1.4 }}>
                {ais.writeOffHint}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
              <Field label={ais.writeOffQty}>
                <input
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={woQty}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) { setWoQty(v); setWoDone(false); } }}
                  placeholder="0"
                  style={inputStyle}
                />
              </Field>
              <Field label={ais.writeOffReason}>
                <select
                  value={woReason}
                  onChange={(e) => { setWoReason(e.target.value as InventoryDiscardReason); setWoDone(false); }}
                  style={inputStyle}
                >
                  {reasonOptions.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label={ais.writeOffNotes}>
              <input
                type="text"
                value={woNotes}
                onChange={(e) => { setWoNotes(e.target.value); setWoDone(false); }}
                placeholder={ais.writeOffNotesPh}
                style={inputStyle}
              />
            </Field>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Btn
                variant="ghost"
                size="md"
                onClick={handleWriteOff}
                disabled={woSaving || saving || !woValid}
                style={{ color: T.warm, borderColor: T.warm }}
              >
                {woSaving ? ais.writingOff : ais.writeOffBtn}
              </Btn>
              {woDone && (
                <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, fontWeight: 500 }}>
                  {ais.writeOffDone}
                </span>
              )}
            </div>
          </div>
        )}
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
