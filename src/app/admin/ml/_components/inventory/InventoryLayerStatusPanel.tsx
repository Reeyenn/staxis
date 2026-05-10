'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryItemModelStatuses } from '@/lib/db';
import type { InventoryItemModelStatus } from '@/lib/db/ml-inventory-cockpit';
import { CheckCircle2, AlertCircle, Circle } from 'lucide-react';

const GRADUATION_MIN_EVENTS = 30;
const GRADUATION_MAE_RATIO = 0.10;
const GRADUATION_PASSES = 5;

/**
 * Inventory rate model status — one row per item showing where each model is
 * in its journey from "no model" → "Bayesian (low confidence)" → "graduated"
 * → "XGBoost". This is the single most-important panel for Reeyen because
 * it answers "is the AI working for THIS hotel right now?"
 *
 * Items are sorted: graduated first, then close-to-graduated, then by event
 * count descending. So the panel always opens with the items the AI is
 * most successful with.
 */
export function InventoryLayerStatusPanel() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [items, setItems] = useState<InventoryItemModelStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        const data = await getInventoryItemModelStatuses(activePropertyId, 200);
        setItems(data);
      } catch (err) {
        console.error('InventoryLayerStatusPanel: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const aPriority = a.autoFillEnabled ? 0 : (a.isActive ? 1 : 2);
      const bPriority = b.autoFillEnabled ? 0 : (b.isActive ? 1 : 2);
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.countsTotal - a.countsTotal;
    });
  }, [items]);

  const totalGraduated = items.filter((i) => i.autoFillEnabled).length;
  const totalActive = items.filter((i) => i.isActive).length;
  const totalNoModel = items.filter((i) => !i.isActive).length;

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '12px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          Inventory rate models
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          One Bayesian model per (item × this property). Auto-graduates to XGBoost at 100+ events.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '24px', marginBottom: '16px', fontSize: '12px' }}>
        <Stat label="Graduated" value={totalGraduated} color="#00a050" />
        <Stat label="Active" value={totalActive} color="#0066cc" />
        <Stat label="No model yet" value={totalNoModel} color="#7a8a9e" />
        <Stat label="Total items" value={items.length} color="#1b1c19" />
      </div>

      {loading ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.12)' }}>
                <Th>Status</Th>
                <Th>Item</Th>
                <Th>Algorithm</Th>
                <Th align="right">Events</Th>
                <Th align="right">Validation MAE</Th>
                <Th align="right">Beats baseline</Th>
                <Th align="right">Consec. passes</Th>
                <Th>Trained</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 50).map((it) => (
                <ItemRow key={it.itemId} item={it} />
              ))}
            </tbody>
          </table>
          {sorted.length > 50 && (
            <div style={{ textAlign: 'center', color: '#7a8a9e', fontSize: '11px', marginTop: '8px' }}>
              Showing 50 of {sorted.length} items
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({ item }: { item: InventoryItemModelStatus }) {
  const status = item.autoFillEnabled
    ? { icon: <CheckCircle2 size={14} color="#00a050" />, label: 'Graduated', color: '#00a050' }
    : item.isActive
    ? { icon: <Circle size={14} color="#0066cc" />, label: 'Active', color: '#0066cc' }
    : { icon: <AlertCircle size={14} color="#7a8a9e" />, label: 'No model', color: '#7a8a9e' };
  return (
    <tr style={{ borderBottom: '1px solid rgba(78,90,122,0.06)' }}>
      <Td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: status.color, fontWeight: 600 }}>
          {status.icon}{status.label}
        </span>
      </Td>
      <Td>{item.itemName}</Td>
      <Td>{item.algorithm ?? '—'}</Td>
      <Td align="right">{item.countsTotal}</Td>
      <Td align="right">{item.validationMae !== null ? item.validationMae.toFixed(3) : '—'}</Td>
      <Td align="right">
        {item.beatsBaselinePct !== null
          ? `${Math.round(item.beatsBaselinePct * 100)}%`
          : '—'}
      </Td>
      <Td align="right">
        {item.consecutivePassingRuns}/{GRADUATION_PASSES}
      </Td>
      <Td>{item.trainedAt ? new Date(item.trainedAt).toLocaleDateString() : '—'}</Td>
    </tr>
  );
}

function EmptyState() {
  return (
    <div style={{
      padding: '24px',
      textAlign: 'center',
      color: '#7a8a9e',
      fontSize: '13px',
      background: '#f7fafb',
      borderRadius: '8px',
    }}>
      No inventory items found. Add items in /inventory to start training.
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '8px 12px',
      textAlign: align ?? 'left',
      color: '#7a8a9e',
      fontWeight: 500,
      fontSize: '11px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>{children}</th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td style={{
      padding: '8px 12px',
      textAlign: align ?? 'left',
      color: '#1b1c19',
    }}>{children}</td>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ fontSize: '20px', fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#7a8a9e' }}>{label}</div>
    </div>
  );
}
