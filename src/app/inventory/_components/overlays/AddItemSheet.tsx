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

import { T, fonts, catLabel, type InvCat } from '../tokens';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';

interface AddItemSheetProps {
  open: boolean;
  onClose: () => void;
  item: InventoryItem | null;
}

const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

export function AddItemSheet({ open, onClose, item }: AddItemSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const isEdit = item != null;

  const [name, setName] = useState('');
  const [category, setCategory] = useState<InvCat>('housekeeping');
  const [currentStock, setCurrentStock] = useState<string>('0');
  const [parLevel, setParLevel] = useState<string>('0');
  const [unit, setUnit] = useState('each');
  const [unitCost, setUnitCost] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [leadDays, setLeadDays] = useState<string>('3');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

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
      setLeadDays(String(item.reorderLeadDays ?? 3));
      setNotes(item.notes || '');
    } else {
      setName('');
      setCategory('housekeeping');
      setCurrentStock('0');
      setParLevel('0');
      setUnit('each');
      setUnitCost('');
      setVendor('');
      setLeadDays('3');
      setNotes('');
    }
  }, [open, item]);

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
      alert('Saving the item failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!user || !activePropertyId || !item || saving) return;
    if (!confirm(`Remove "${item.name}" from inventory?`)) return;
    setSaving(true);
    try {
      await deleteInventoryItem(user.uid, activePropertyId, item.id);
      onClose();
    } catch (err) {
      console.error('[add-item] delete failed', err);
      alert('Could not remove the item.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={isEdit ? 'Edit item' : 'New item'}
      italic={isEdit ? item?.name : 'Add to inventory'}
      width={640}
      footer={
        <>
          {isEdit && (
            <Btn variant="ghost" size="md" onClick={handleDelete} disabled={saving} style={{ marginRight: 'auto', color: T.warm }}>
              Delete
            </Btn>
          )}
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add item'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bath towels"
            style={inputStyle}
          />
        </Field>

        <Field label="Category">
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
                  {catLabel[c]}
                </button>
              );
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="On hand">
            <input
              type="number"
              value={currentStock}
              onChange={(e) => setCurrentStock(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Par level">
            <input
              type="number"
              value={parLevel}
              onChange={(e) => setParLevel(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Unit">
            <input
              type="text"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="each / bottle / case"
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Unit cost ($)">
            <input
              type="number"
              step="0.01"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="0.00"
              style={inputStyle}
            />
          </Field>
          <Field label="Vendor">
            <input
              type="text"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="Supplier"
              style={inputStyle}
            />
          </Field>
          <Field label="Lead days">
            <input
              type="number"
              value={leadDays}
              onChange={(e) => setLeadDays(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label="Notes (optional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Anything worth remembering"
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
